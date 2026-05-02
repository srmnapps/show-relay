// show-relay/server.js
// Server-authoritative + Redis persistence + public/private rooms (ESM)
import 'dotenv/config'
// show-relay/server.js
// Server-authoritative + Redis persistence + public/private rooms (ESM)

import { WebSocketServer } from 'ws'
import http from 'http'
import { createClient } from 'redis'
import { makeRoom, makePlayer, applyServerAction } from './game/game.js'

const PORT = process.env.PORT || 3001

// ── Redis client ──────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL })

redis.on('error', (err) => console.error('[Redis] error:', err))
redis.on('connect', () => console.log('[Redis] connected'))
redis.on('reconnecting', () => console.log('[Redis] reconnecting…'))

await redis.connect()

// ── Redis helpers ─────────────────────────────────────────────────
const ROOM_TTL = 60 * 60 * 2 // 2 hours in seconds

function roomKey(code)     { return `room:${code}` }
function logsKey(code)     { return `room:${code}:logs` }
function metaKey(code)     { return `room:${code}:meta` }

async function saveRoom(code, entry) {
  const pipeline = redis.multi()
  pipeline.set(roomKey(code), JSON.stringify(entry.room), { EX: ROOM_TTL })
  pipeline.set(logsKey(code), JSON.stringify(entry.logs), { EX: ROOM_TTL })
  pipeline.set(metaKey(code), JSON.stringify({
    isPublic:  entry.isPublic,
    createdAt: entry.createdAt,
  }), { EX: ROOM_TTL })
  await pipeline.exec()
}

async function loadRoom(code) {
  const [roomRaw, logsRaw, metaRaw] = await Promise.all([
    redis.get(roomKey(code)),
    redis.get(logsKey(code)),
    redis.get(metaKey(code)),
  ])
  if (!roomRaw) return null
  const room  = JSON.parse(roomRaw)
  const logs  = logsRaw  ? JSON.parse(logsRaw)  : []
  const meta  = metaRaw  ? JSON.parse(metaRaw)  : { isPublic: false, createdAt: Date.now() }
  return { room, logs, isPublic: meta.isPublic, createdAt: meta.createdAt }
}

async function deleteRoom(code) {
  await Promise.all([
    redis.del(roomKey(code)),
    redis.del(logsKey(code)),
    redis.del(metaKey(code)),
  ])
}

// ── Track all active public room codes in a Redis Set ─────────────
async function addPublicRoom(code) {
  await redis.sAdd('public_rooms', code)
}
async function removePublicRoom(code) {
  await redis.sRem('public_rooms', code)
}
async function getPublicRoomCodes() {
  return redis.sMembers('public_rooms')
}

// ── In-memory clients map (WebSocket connections — not persisted) ──
// clients: Map<roomCode, Set<WebSocket>>
const clients = new Map()

function getClients(code) {
  if (!clients.has(code)) clients.set(code, new Set())
  return clients.get(code)
}

// ── Utilities ─────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

async function uniqueRoomCode() {
  let code = generateRoomCode()
  let exists = await redis.exists(roomKey(code))
  while (exists) {
    code = generateRoomCode()
    exists = await redis.exists(roomKey(code))
  }
  return code
}

function sendTo(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload))
}

function broadcastToRoom(code, payload) {
  const msg = JSON.stringify(payload)
  getClients(code).forEach(ws => {
    if (ws.readyState === 1) ws.send(msg)
  })
}

function broadcastState(code, room, logs) {
  broadcastToRoom(code, { type: 'STATE_SYNC', payload: room, logs })
}

function sendToPlayer(code, playerId, payload) {
  getClients(code).forEach(ws => {
    if (ws.playerId === playerId && ws.readyState === 1) {
      ws.send(JSON.stringify(payload))
    }
  })
}

// ── Build public room summary ─────────────────────────────────────
function buildRoomSummary(code, room, meta) {
  return {
    code,
    hostName:    room.players[0]?.name ?? 'Unknown',
    playerCount: room.players.length,
    maxPlayers:  5,
    mode:        room.mode,
    createdAt:   meta.createdAt,
    isPublic:    meta.isPublic,
  }
}

// ── Broadcast updated public room list to ALL connected clients ───
async function broadcastRoomsList() {
  try {
    const codes = await getPublicRoomCodes()
    const summaries = []
    for (const code of codes) {
      const data = await loadRoom(code)
      if (!data) {
        // Room expired in Redis — clean up set
        await removePublicRoom(code)
        continue
      }
      if (data.room.phase === 'lobby' && data.isPublic) {
        summaries.push(buildRoomSummary(code, data.room, data))
      }
    }
    const msg = JSON.stringify({ type: 'ROOMS_LIST', rooms: summaries })
    wss.clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(msg)
    })
  } catch (err) {
    console.error('[broadcastRoomsList] error:', err)
  }
}

// ── Active timers (in-memory — not persisted) ─────────────────────
const timers = new Map() // roomCode → { showResolve, roundEnd }

function getTimers(code) {
  if (!timers.has(code)) timers.set(code, {})
  return timers.get(code)
}

// ── SHOW timer ────────────────────────────────────────────────────
function scheduleShowResolve(code, room, logs) {
  const t = getTimers(code)
  clearTimeout(t.showResolve)
  clearTimeout(t.roundEnd)

  t.showResolve = setTimeout(async () => {
    try {
      const data = await loadRoom(code)
      if (!data) return
      const callerId = data.room.players[data.room.showCaller]?.id
      const result   = applyServerAction(data.room, data.logs, { type: 'SHOW_RESOLVE' }, callerId)
      if (result.error) return
      await saveRoom(code, { ...data, room: result.room, logs: result.logs })
      broadcastState(code, result.room, result.logs)

      t.roundEnd = setTimeout(async () => {
        try {
          const data2 = await loadRoom(code)
          if (!data2) return
          const r2 = applyServerAction(data2.room, data2.logs, { type: 'ROUND_END' }, data2.room.players[0]?.id)
          if (!r2.error) {
            await saveRoom(code, { ...data2, room: r2.room, logs: r2.logs })
            broadcastState(code, r2.room, r2.logs)
          }
        } catch (err) { console.error('[ROUND_END timer]', err) }
      }, 1800)
    } catch (err) { console.error('[SHOW_RESOLVE timer]', err) }
  }, 5000)
}

// ── HTTP server ───────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Show Game Server — OK')
})

const wss = new WebSocketServer({ server: httpServer })

// ── Connection handler ────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.roomCode = null
  ws.playerId = null

  ws.on('message', async (raw) => {
    let data
    try { data = JSON.parse(raw) } catch { return }
    if (!data.type) return

    switch (data.type) {

      // ── CREATE_ROOM ───────────────────────────────────────────
      case 'CREATE_ROOM': {
        const { player, isPublic = false } = data
        if (!player?.id || !player?.name) {
          return sendTo(ws, { type: 'ERROR', message: 'Invalid player info.' })
        }

        try {
          const roomCode = await uniqueRoomCode()
          const host     = makePlayer(player.id, player.name, 0)
          const room     = makeRoom(roomCode, host)
          const logs     = ['Room created! Share the code.']
          const entry    = { room, logs, isPublic: Boolean(isPublic), createdAt: Date.now() }

          await saveRoom(roomCode, entry)
          if (isPublic) await addPublicRoom(roomCode)

          getClients(roomCode).add(ws)
          ws.roomCode = roomCode
          ws.playerId = player.id

          console.log(`[CREATE] ${roomCode} by "${player.name}" isPublic=${isPublic}`)

          sendTo(ws, {
            type: 'ROOM_CREATED', roomCode,
            playerId: player.id, isPublic: Boolean(isPublic), room, logs,
          })

          if (isPublic) broadcastRoomsList()
        } catch (err) {
          console.error('[CREATE_ROOM]', err)
          sendTo(ws, { type: 'ERROR', message: 'Failed to create room.' })
        }
        break
      }

      // ── JOIN_ROOM ─────────────────────────────────────────────
      case 'JOIN_ROOM': {
        const { roomCode, player } = data
        if (!roomCode || !player?.id || !player?.name) {
          return sendTo(ws, { type: 'ERROR', message: 'Invalid join request.' })
        }

        try {
          const entry = await loadRoom(roomCode)
          if (!entry) {
            return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })
          }

          getClients(roomCode).add(ws)
          ws.roomCode = roomCode
          ws.playerId = player.id

          const existing = entry.room.players.find(p => p.id === player.id)

          if (!existing) {
            if (entry.room.phase !== 'lobby') {
              return sendTo(ws, { type: 'ERROR', message: 'Game already started.' })
            }
            if (entry.room.players.length >= 5) {
              return sendTo(ws, { type: 'ERROR', message: 'Room is full.' })
            }
            const newPlayer = makePlayer(player.id, player.name, entry.room.players.length)
            entry.room = { ...entry.room, players: [...entry.room.players, newPlayer] }
            entry.logs = [`${player.name} joined!`, ...entry.logs]
            await saveRoom(roomCode, entry)
            console.log(`[JOIN] ${roomCode} ← "${player.name}" (${entry.room.players.length} players)`)
          } else {
            console.log(`[REJOIN] ${roomCode} ← "${player.name}"`)
          }

          sendTo(ws, {
            type: 'JOINED_ROOM', roomCode,
            playerId: player.id, isPublic: entry.isPublic,
            room: entry.room, logs: entry.logs,
          })

          // Broadcast updated state to other room members
          getClients(roomCode).forEach(client => {
            if (client !== ws && client.readyState === 1) {
              client.send(JSON.stringify({
                type: 'STATE_SYNC', payload: entry.room, logs: entry.logs,
              }))
            }
          })

          if (entry.isPublic) broadcastRoomsList()
        } catch (err) {
          console.error('[JOIN_ROOM]', err)
          sendTo(ws, { type: 'ERROR', message: 'Failed to join room.' })
        }
        break
      }

      // ── LIST_ROOMS ────────────────────────────────────────────
      case 'LIST_ROOMS': {
        try {
          const codes = await getPublicRoomCodes()
          const summaries = []
          for (const code of codes) {
            const d = await loadRoom(code)
            if (!d) { await removePublicRoom(code); continue }
            if (d.room.phase === 'lobby' && d.isPublic) {
              summaries.push(buildRoomSummary(code, d.room, d))
            }
          }
          sendTo(ws, { type: 'ROOMS_LIST', rooms: summaries })
        } catch (err) {
          console.error('[LIST_ROOMS]', err)
          sendTo(ws, { type: 'ROOMS_LIST', rooms: [] })
        }
        break
      }

      // ── TOGGLE_VISIBILITY ─────────────────────────────────────
      case 'TOGGLE_VISIBILITY': {
        const { roomCode, playerId } = data
        try {
          const entry = await loadRoom(roomCode)
          if (!entry) return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })
          if (entry.room.hostId !== playerId) {
            return sendTo(ws, { type: 'ERROR', message: 'Only the host can change visibility.' })
          }

          entry.isPublic = !entry.isPublic
          await saveRoom(roomCode, entry)

          if (entry.isPublic) await addPublicRoom(roomCode)
          else                await removePublicRoom(roomCode)

          console.log(`[VISIBILITY] ${roomCode} → ${entry.isPublic ? 'public' : 'private'}`)

          broadcastToRoom(roomCode, { type: 'VISIBILITY_CHANGED', isPublic: entry.isPublic })
          broadcastRoomsList()
        } catch (err) {
          console.error('[TOGGLE_VISIBILITY]', err)
        }
        break
      }

      // ── REQUEST_STATE ─────────────────────────────────────────
      case 'REQUEST_STATE': {
        const { roomCode } = data
        try {
          const entry = await loadRoom(roomCode)
          if (!entry) return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })
          sendTo(ws, { type: 'STATE_SYNC', payload: entry.room, logs: entry.logs })
        } catch (err) {
          console.error('[REQUEST_STATE]', err)
        }
        break
      }

      // ── ACTION ────────────────────────────────────────────────
      case 'ACTION': {
        const { roomCode, playerId, action } = data
        try {
          const entry = await loadRoom(roomCode)
          if (!entry) return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })

          const result = applyServerAction(entry.room, entry.logs, action, playerId)
          if (result.error) return sendTo(ws, { type: 'ERROR', message: result.error })

          entry.room = result.room
          entry.logs = result.logs
          await saveRoom(roomCode, entry)

          // SHOW — schedule server-side resolve timer
          if (action.type === 'SHOW') {
            scheduleShowResolve(roomCode, result.room, result.logs)
          }

          // Game started — remove from public list
          if (action.type === 'START' && entry.isPublic) {
            await removePublicRoom(roomCode)
            broadcastRoomsList()
          }

          broadcastState(roomCode, result.room, result.logs)
        } catch (err) {
          console.error('[ACTION]', err)
          sendTo(ws, { type: 'ERROR', message: 'Server error processing action.' })
        }
        break
      }

      // ── LEAVE_ROOM ────────────────────────────────────────────
      case 'LEAVE_ROOM': {
        const { roomCode, playerId } = data
        try {
          getClients(roomCode).delete(ws)
          ws.roomCode = null
          ws.playerId = null
          console.log(`[LEAVE] ${roomCode} — "${playerId}"`)

          const entry = await loadRoom(roomCode)
          if (!entry) return

          if (getClients(roomCode).size > 0) {
            broadcastState(roomCode, entry.room, entry.logs)
            if (entry.isPublic) broadcastRoomsList()
          }
        } catch (err) {
          console.error('[LEAVE_ROOM]', err)
        }
        break
      }

      // ── VOICE SIGNALING ───────────────────────────────────────
      case 'VOICE_OFFER':
      case 'VOICE_ANSWER':
      case 'VOICE_ICE': {
        const { roomCode, toId } = data
        sendToPlayer(roomCode, toId, data)
        break
      }

      default:
        break
    }
  })

  ws.on('close', async () => {
    const { roomCode } = ws
    if (!roomCode) return

    getClients(roomCode).delete(ws)
    console.log(`[DISCONNECT] ${roomCode} — clients remaining: ${getClients(roomCode).size}`)

    if (getClients(roomCode).size === 0) {
      // Clear timers
      const t = getTimers(roomCode)
      clearTimeout(t.showResolve)
      clearTimeout(t.roundEnd)
      timers.delete(roomCode)
      clients.delete(roomCode)

      // Room data stays in Redis (survives for reconnect up to 2h TTL)
      // But update public list in case player count changed
      try {
        const entry = await loadRoom(roomCode)
        if (entry?.isPublic) broadcastRoomsList()
      } catch {}
    } else {
      // Other clients still connected — update public list
      try {
        const entry = await loadRoom(roomCode)
        if (entry?.isPublic) broadcastRoomsList()
      } catch {}
    }
  })

  ws.on('error', () => ws.terminate())
})

httpServer.listen(PORT, () => console.log(`Show Game Server on :${PORT}`))