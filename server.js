// show-relay/server.js
// Server-authoritative + Redis persistence + public/private rooms (ESM)
// Merged: V2 base (host.online=true, newPlayer.online=true, full logging,
//         roundResult/show/gameEnd SOUND_EVENTs) +
//         V1 fix: rejoin:true awareness + yourTurn SOUND_EVENT (new feature)

import 'dotenv/config'
import { WebSocketServer } from 'ws'
import http from 'http'
import { createClient } from 'redis'
import {
  makeRoom, makePlayer, applyServerAction, sanitizeRoom,
  isSpecial, isShowHand, removeDisconnectedBots,
} from './game/game.js'

const PORT = process.env.PORT || 3001

// ── Redis client ──────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL })

redis.on('error', (err) => console.error('[Redis] error:', err))
redis.on('connect', () => console.log('[Redis] connected'))
redis.on('reconnecting', () => console.log('[Redis] reconnecting…'))

await redis.connect()

// ── Redis helpers ─────────────────────────────────────────────────
const ROOM_TTL        = 60 * 60 * 6  // 6 hours (active rooms)
const EMPTY_LOBBY_TTL = 15             // 15 seconds (empty lobbies)

function roomKey(code) { return `room:${code}` }
function logsKey(code) { return `room:${code}:logs` }
function metaKey(code) { return `room:${code}:meta` }

async function saveRoom(code, entry, ttl = ROOM_TTL) {
  const pipeline = redis.multi()
  pipeline.set(roomKey(code), JSON.stringify(entry.room), { EX: ttl })
  pipeline.set(logsKey(code), JSON.stringify(entry.logs), { EX: ttl })
  pipeline.set(metaKey(code), JSON.stringify({
    isPublic:  entry.isPublic,
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
  }), { EX: ttl })
  await pipeline.exec()
}

async function loadRoom(code) {
  const [roomRaw, logsRaw, metaRaw] = await Promise.all([
    redis.get(roomKey(code)),
    redis.get(logsKey(code)),
    redis.get(metaKey(code)),
  ])
  if (!roomRaw) return null
  const room = JSON.parse(roomRaw)
  const logs = logsRaw ? JSON.parse(logsRaw) : []
  const meta = metaRaw ? JSON.parse(metaRaw) : { isPublic: false, createdAt: Date.now() }
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
async function addPublicRoom(code)    { await redis.sAdd('public_rooms', code) }
async function removePublicRoom(code) { await redis.sRem('public_rooms', code) }
async function getPublicRoomCodes()   { return redis.sMembers('public_rooms') }

// ── In-memory room entries ────────────────────────────────────────
// entries: Map<roomCode, { clients: Set<WebSocket>, timers: {}, cleanupTimer }>
const entries = new Map()

function getEntry(code) {
  if (!entries.has(code)) {
    entries.set(code, { clients: new Set(), timers: {}, cleanupTimer: null })
  }
  return entries.get(code)
}

// ── Utilities ─────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

async function uniqueRoomCode() {
  let code   = generateRoomCode()
  let exists = await redis.exists(roomKey(code))
  while (exists) { code = generateRoomCode(); exists = await redis.exists(roomKey(code)) }
  return code
}

function sendTo(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload))
}

function broadcastToRoom(code, payload) {
  const msg = JSON.stringify(payload)
  getEntry(code).clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg) })
}

function broadcastState(code, room, logs) {
  broadcastToRoom(code, { type: 'STATE_SYNC', payload: room, logs })
}

function sendToPlayer(code, playerId, payload) {
  getEntry(code).clients.forEach(ws => {
    if (ws.playerId === playerId && ws.readyState === 1) ws.send(JSON.stringify(payload))
  })
}

// ── Sound event helper ────────────────────────────────────────────
function broadcastSound(code, sound, extra = {}) {
  broadcastToRoom(code, {
    type:  'SOUND_EVENT',
    sound,
    ...extra,
    id: `${sound}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
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

// ── Broadcast updated public room list to ALL connected clients ────
async function broadcastRoomsList() {
  try {
    const codes     = await getPublicRoomCodes()
    const summaries = []
    for (const code of codes) {
      const data = await loadRoom(code)
      if (!data) { await removePublicRoom(code); continue }
      if (data.room.phase === 'lobby' && data.isPublic) {
        summaries.push(buildRoomSummary(code, data.room, data))
      }
    }
    const msg = JSON.stringify({ type: 'ROOMS_LIST', rooms: summaries })
    wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg) })
  } catch (err) {
    console.error('[broadcastRoomsList] error:', err)
  }
}

// ── Helpers ───────────────────────────────────────────────────────
function getOnlineHumanCount(room) {
  return room.players.filter(p => p.isBot !== true && p.online === true).length
}

async function deleteEmptyLobbyNow(code) {
  const entry = getEntry(code)
  if (entry.cleanupTimer) { clearTimeout(entry.cleanupTimer); entry.cleanupTimer = null }
  console.log(`[CLEANUP] Immediately deleting empty lobby ${code}`)
  try {
    await deleteRoom(code)
    await removePublicRoom(code)
  } catch (err) {
    console.error('[deleteEmptyLobbyNow] Redis error:', err)
  }
  entries.delete(code)
  broadcastRoomsList()
}

function scheduleRoomCleanup(code) {
  const entry = getEntry(code)
  if (entry.cleanupTimer) return
  console.log(`[CLEANUP] Scheduling empty-lobby cleanup for ${code} in ${EMPTY_LOBBY_TTL}s`)
  entry.cleanupTimer = setTimeout(async () => {
    entry.cleanupTimer = null
    if (entry.clients.size > 0) return
    try {
      const data = await loadRoom(code)
      if (!data) return
      if (data.room.players.some(p => p.online) && entry.clients.size > 0) return
      if (data.room.phase !== 'lobby') return
      console.log(`[CLEANUP] Deleting empty lobby ${code}`)
      await deleteRoom(code)
      await removePublicRoom(code)
      entries.delete(code)
      broadcastRoomsList()
    } catch (err) {
      console.error('[CLEANUP timer]', err)
    }
  }, EMPTY_LOBBY_TTL * 1000)
}

function cancelRoomCleanup(code) {
  const entry = getEntry(code)
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer)
    entry.cleanupTimer = null
    console.log(`[CLEANUP] Cancelled cleanup for ${code}`)
  }
}

// ── Host transfer ─────────────────────────────────────────────────
function transferHost(room) {
  if (!room.players || room.players.length === 0) return room
  const currentHost = room.players.find(p => p.id === room.hostId)
  if (currentHost && currentHost.online) return room

  const newHost = room.players.find(p => p.id !== room.hostId && p.online && !p.isBot)
    ?? room.players.find(p => p.id !== room.hostId && p.online)

  if (newHost) {
    console.log(`[HOST] Transfer ${room.code}: ${room.hostId} → ${newHost.id} (${newHost.name})`)
    room.hostId = newHost.id
  }
  return room
}

// ── Bot card picker ───────────────────────────────────────────────
function pickBotCard(room, playerIdx) {
  const player = room.players[playerIdx]
  if (!player?.chits?.length) return null

  const normalCards = player.chits.reduce((acc, c, i) => {
    if (!isSpecial(c)) acc.push({ i, symbol: c.symbol })
    return acc
  }, [])

  if (room.mustPassNormalPlayerIdx === playerIdx) {
    return normalCards.length > 0
      ? chooseLeastUsefulNormal(normalCards)
      : Math.floor(Math.random() * player.chits.length)
  }
  if (normalCards.length === 0) return Math.floor(Math.random() * player.chits.length)
  return chooseLeastUsefulNormal(normalCards)
}

function chooseLeastUsefulNormal(normalCards) {
  const counts = {}
  normalCards.forEach(({ symbol }) => { counts[symbol] = (counts[symbol] || 0) + 1 })
  const maxCount  = Math.max(...Object.values(counts))
  const dominated = Object.keys(counts).filter(s => counts[s] === maxCount)
  const weakCards = normalCards.filter(c => !dominated.includes(c.symbol))
  const pool      = weakCards.length > 0 ? weakCards : normalCards
  return pool[Math.floor(Math.random() * pool.length)].i
}

// ── Bot turn scheduler ────────────────────────────────────────────
async function scheduleBotTurn(code, playerIdx, delayMs = 800) {
  const entry = getEntry(code)
  if (entry.timers.botTurn) { clearTimeout(entry.timers.botTurn); entry.timers.botTurn = null }

  entry.timers.botTurn = setTimeout(async () => {
    entry.timers.botTurn = null
    try {
      const data = await loadRoom(code)
      if (!data) return
      const { room, logs } = data
      if (room.currentTurn !== playerIdx) return
      const player = room.players[playerIdx]
      if (!player || (!player.botActive && !player.isBot) || room.phase !== 'playing') return

      const requiredShowSets = room.settings?.normalCount === 8 ? 2 : 1
      const botCanShow       = isShowHand(player.chits, requiredShowSets)
      const botPlayerId      = player.id
      let result

      if (botCanShow) {
        result = applyServerAction(room, logs, { type: 'SHOW', playerIdx, timestamp: Date.now() }, botPlayerId)
        if (!result.error) {
          console.log(`[BOT] ${code} player ${playerIdx} called SHOW!`)
          sanitizeRoom(result.room)
          await saveRoom(code, { ...data, room: result.room, logs: result.logs })
          broadcastState(code, result.room, result.logs)
          broadcastSound(code, 'show')
          scheduleShowResolve(code, 5000)
          return
        }
      }

      const chitIdx = pickBotCard(room, playerIdx)
      if (chitIdx === null) return

      result = applyServerAction(room, logs, { type: 'PASS', chitIdx }, botPlayerId)
      if (result.error) { console.error(`[BOT] ${code} player ${playerIdx} error:`, result.error); return }

      sanitizeRoom(result.room)
      await saveRoom(code, { ...data, room: result.room, logs: result.logs })
      broadcastState(code, result.room, result.logs)
      broadcastSound(code, 'cardPass')

      // Broadcast yourTurn sound to the next player if they are human
      const nextTurn   = result.room.currentTurn
      const nextPlayer = result.room.players[nextTurn]
      if (nextPlayer && !nextPlayer.isBot && !nextPlayer.botActive && nextPlayer.online && result.room.phase === 'playing') {
        sendToPlayer(code, nextPlayer.id, {
          type:  'SOUND_EVENT',
          sound: 'yourTurn',
          id:    `yourTurn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        })
      }
      // Schedule next bot turn if it's another bot
      if (nextPlayer && (nextPlayer.botActive || nextPlayer.isBot) && result.room.phase === 'playing') {
        scheduleBotTurn(code, nextTurn, 800)
      }
    } catch (err) {
      console.error('[BOT scheduleBotTurn]', err)
    }
  }, delayMs)
}

function maybeScheduleBotTurn(code, room) {
  if (room.phase !== 'playing') return
  const currentPlayer = room.players[room.currentTurn]
  if (currentPlayer?.botActive || currentPlayer?.isBot) {
    scheduleBotTurn(code, room.currentTurn, 800)
  }
}

function clearBotTimer(code) {
  const entry = getEntry(code)
  if (entry.timers.botTurn) { clearTimeout(entry.timers.botTurn); entry.timers.botTurn = null }
}

// ── SHOW timer ────────────────────────────────────────────────────
function scheduleShowResolve(code, remainingMs = 5000) {
  const entry = getEntry(code)
  clearTimeout(entry.timers.showResolve)
  clearTimeout(entry.timers.roundEnd)

  entry.timers.showResolve = setTimeout(async () => {
    try {
      const data     = await loadRoom(code)
      if (!data) return
      const callerId = data.room.players[data.room.showCaller]?.id
      const result   = applyServerAction(data.room, data.logs, { type: 'SHOW_RESOLVE' }, callerId)
      if (result.error) return
      sanitizeRoom(result.room)
      await saveRoom(code, { ...data, room: result.room, logs: result.logs })
      broadcastState(code, result.room, result.logs)
      broadcastSound(code, 'roundResult')

      entry.timers.roundEnd = setTimeout(async () => {
        try {
          const data2 = await loadRoom(code)
          if (!data2) return
          const r2 = applyServerAction(data2.room, data2.logs, { type: 'ROUND_END' }, data2.room.players[0]?.id)
          if (!r2.error) {
            sanitizeRoom(r2.room)
            await saveRoom(code, { ...data2, room: r2.room, logs: r2.logs })
            broadcastState(code, r2.room, r2.logs)
          }
        } catch (err) { console.error('[ROUND_END timer]', err) }
      }, 1800)
    } catch (err) { console.error('[SHOW_RESOLVE timer]', err) }
  }, Math.max(0, remainingMs))
}

// ── Restore timers on Redis load ──────────────────────────────────
function restoreTimersAfterLoad(code, room) {
  if (room.phase === 'showWindow' && room.showWindowEnd) {
    const remaining = room.showWindowEnd - Date.now()
    console.log(`[RESTORE] Re-scheduling SHOW_RESOLVE for ${code} in ${remaining}ms`)
    scheduleShowResolve(code, remaining > 0 ? remaining : 0)
  }
  maybeScheduleBotTurn(code, room)
}

// ── HTTP server ────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Show Game Server — OK')
})

const wss = new WebSocketServer({ server: httpServer })

// ── Connection handler ─────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.roomCode = null
  ws.playerId = null

  ws.on('message', async (raw) => {
    let data
    try { data = JSON.parse(raw) } catch { return }
    if (!data.type) return

    switch (data.type) {

      // ── CREATE_ROOM ─────────────────────────────────────────────
      case 'CREATE_ROOM': {
        const { player, isPublic = false } = data
        if (!player?.id || !player?.name) {
          return sendTo(ws, { type: 'ERROR', message: 'Invalid player info.' })
        }
        try {
          const roomCode = await uniqueRoomCode()
          const host     = makePlayer(player.id, player.name, 0)
          host.online    = true   // mark host online immediately
          const room     = makeRoom(roomCode, host)
          sanitizeRoom(room)
          const logs     = ['Room created! Share the code.']
          const entry    = { room, logs, isPublic: Boolean(isPublic), createdAt: Date.now() }

          await saveRoom(roomCode, entry)
          if (isPublic) await addPublicRoom(roomCode)

          const mem = getEntry(roomCode)
          mem.clients.add(ws)
          ws.roomCode = roomCode
          ws.playerId = player.id

          cancelRoomCleanup(roomCode)
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

      // ── JOIN_ROOM ────────────────────────────────────────────────
      case 'JOIN_ROOM': {
        const { roomCode, player, rejoin } = data
        if (!roomCode || !player?.id || !player?.name) {
          return sendTo(ws, { type: 'ERROR', message: 'Invalid join request.' })
        }
        try {
          let entry = await loadRoom(roomCode)
          if (!entry) {
            return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })
          }

          sanitizeRoom(entry.room)

          const mem = getEntry(roomCode)
          mem.clients.add(ws)
          ws.roomCode = roomCode
          ws.playerId = player.id

          cancelRoomCleanup(roomCode)

          const existingIdx = entry.room.players.findIndex(p => p.id === player.id)
          console.log('[JOIN_ROOM]', roomCode, player?.id, player?.name, rejoin ? '(rejoin)' : '')

          if (existingIdx !== -1) {
            // REJOIN: player already in room, restore seat
            const p = entry.room.players[existingIdx]
            p.online         = true
            p.botActive      = p.isBot ? true : false
            p.disconnectedAt = null

            entry.logs = [`${player.name} reconnected!`, ...entry.logs]

            clearBotTimer(roomCode)
            cancelRoomCleanup(roomCode)
            restoreTimersAfterLoad(roomCode, entry.room)

            await saveRoom(roomCode, entry)
            console.log(`[REJOIN] ${roomCode} ← "${player.name}"`)

            sendTo(ws, {
              type: 'JOINED_ROOM', roomCode,
              playerId: player.id, isPublic: entry.isPublic,
              room: entry.room, logs: entry.logs,
            })
            broadcastState(roomCode, entry.room, entry.logs)

            // Send yourTurn sound if it's the rejoining player's turn
            if (entry.room.phase === 'playing' && entry.room.currentTurn === existingIdx) {
              sendTo(ws, {
                type:  'SOUND_EVENT',
                sound: 'yourTurn',
                id:    `yourTurn_rejoin_${Date.now()}`,
              })
            }
          } else {
            // NEW player — only allowed in lobby
            if (entry.room.phase !== 'lobby') {
              return sendTo(ws, { type: 'ERROR', message: 'Game already started.' })
            }
            if (entry.room.players.length >= 5) {
              return sendTo(ws, { type: 'ERROR', message: 'Room is full.' })
            }
            const newPlayer  = makePlayer(player.id, player.name, entry.room.players.length)
            newPlayer.online = true   // mark online immediately
            entry.room       = { ...entry.room, players: [...entry.room.players, newPlayer] }
            entry.logs       = [`${player.name} joined!`, ...entry.logs]
            await saveRoom(roomCode, entry)
            console.log(`[JOIN] ${roomCode} ← "${player.name}" (${entry.room.players.length} players)`)

            sendTo(ws, {
              type: 'JOINED_ROOM', roomCode,
              playerId: player.id, isPublic: entry.isPublic,
              room: entry.room, logs: entry.logs,
            })

            mem.clients.forEach(client => {
              if (client !== ws && client.readyState === 1) {
                client.send(JSON.stringify({ type: 'STATE_SYNC', payload: entry.room, logs: entry.logs }))
              }
            })
          }

          if (entry.isPublic) broadcastRoomsList()
        } catch (err) {
          console.error('[JOIN_ROOM]', err)
          sendTo(ws, { type: 'ERROR', message: 'Failed to join room.' })
        }
        break
      }

      // ── LIST_ROOMS ───────────────────────────────────────────────
      case 'LIST_ROOMS': {
        try {
          const codes     = await getPublicRoomCodes()
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

      // ── TOGGLE_VISIBILITY ────────────────────────────────────────
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

      // ── REQUEST_STATE ────────────────────────────────────────────
      case 'REQUEST_STATE': {
        const { roomCode } = data
        try {
          const entry = await loadRoom(roomCode)
          if (!entry) return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })
          sanitizeRoom(entry.room)
          restoreTimersAfterLoad(roomCode, entry.room)
          sendTo(ws, { type: 'STATE_SYNC', payload: entry.room, logs: entry.logs })
        } catch (err) {
          console.error('[REQUEST_STATE]', err)
        }
        break
      }

      // ── ADD_BOT ──────────────────────────────────────────────────
      case 'ADD_BOT': {
        const { roomCode, playerId } = data
        try {
          const entry = await loadRoom(roomCode)
          if (!entry) return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })
          if (entry.room.hostId !== playerId) return sendTo(ws, { type: 'ERROR', message: 'Only the host can add bots.' })
          if (entry.room.phase !== 'lobby')   return sendTo(ws, { type: 'ERROR', message: 'Can only add bots in lobby.' })
          if (entry.room.players.length >= 5) return sendTo(ws, { type: 'ERROR', message: 'Room is full.' })

          const existingBots = entry.room.players.filter(p => p.isBot).length
          const botName      = `Bot ${existingBots + 1}`
          const botId        = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
          const bot          = makePlayer(botId, botName, entry.room.players.length, { isBot: true })

          entry.room.players.push(bot)
          entry.logs = [`${botName} added to lobby!`, ...entry.logs]

          sanitizeRoom(entry.room)
          await saveRoom(entry.room.code, entry)
          broadcastState(roomCode, entry.room, entry.logs)
          console.log(`[BOT] Added ${botName} to ${roomCode}`)
        } catch (err) {
          console.error('[ADD_BOT]', err)
          sendTo(ws, { type: 'ERROR', message: 'Failed to add bot.' })
        }
        break
      }

      // ── REMOVE_BOT ───────────────────────────────────────────────
      case 'REMOVE_BOT': {
        const { roomCode, playerId, botId, targetIdx: removeBotIdx } = data
        try {
          const entry = await loadRoom(roomCode)
          if (!entry) return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })
          if (entry.room.hostId !== playerId) return sendTo(ws, { type: 'ERROR', message: 'Only the host can remove bots.' })
          if (entry.room.phase !== 'lobby')   return sendTo(ws, { type: 'ERROR', message: 'Can only remove bots in lobby.' })

          let botIdx = -1
          if (removeBotIdx !== undefined && removeBotIdx >= 0 && entry.room.players[removeBotIdx]?.isBot) {
            botIdx = removeBotIdx
          } else if (botId) {
            botIdx = entry.room.players.findIndex(p => p.id === botId && p.isBot)
          }
          if (botIdx === -1) return sendTo(ws, { type: 'ERROR', message: 'Bot not found.' })

          const botName = entry.room.players[botIdx].name
          entry.room.players.splice(botIdx, 1)
          entry.room.players = entry.room.players.map((p, i) => ({ ...p, color: i }))
          entry.logs = [`${botName} removed from lobby.`, ...entry.logs]

          sanitizeRoom(entry.room)
          await saveRoom(roomCode, entry)
          broadcastState(roomCode, entry.room, entry.logs)
          console.log(`[BOT] Removed ${botName} from ${roomCode}`)
        } catch (err) {
          console.error('[REMOVE_BOT]', err)
          sendTo(ws, { type: 'ERROR', message: 'Failed to remove bot.' })
        }
        break
      }

      // ── ACTION ───────────────────────────────────────────────────
      case 'ACTION': {
        const { roomCode, playerId, action } = data
        try {
          const entry = await loadRoom(roomCode)
          if (!entry) return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })

          sanitizeRoom(entry.room)

          const playerInRoom = entry.room.players.some(p => p.id === playerId)
          if (!playerInRoom) return sendTo(ws, { type: 'ERROR', message: 'Player not in room.' })

          const result = applyServerAction(entry.room, entry.logs, action, playerId)
          if (result.error) return sendTo(ws, { type: 'ERROR', message: result.error })

          sanitizeRoom(result.room)
          entry.room = result.room
          entry.logs = result.logs
          await saveRoom(roomCode, entry)

          if (action.type === 'SHOW') scheduleShowResolve(roomCode, 5000)

          if (action.type === 'START' && entry.isPublic) {
            await removePublicRoom(roomCode)
            broadcastRoomsList()
          }

          broadcastState(roomCode, result.room, result.logs)

          // ── Sound events ──────────────────────────────────────
          const SOUND_ACTION_MAP = {
            PASS:                'cardPass',
            USE_REVERSE:         'specialReverse',
            USE_FREEZE:          'specialFreeze',
            USE_BLIND_SNATCH:    'specialBlindSnatch',
            USE_REVEALED_SNATCH: 'specialRevealedSnatch',
            USE_STUN_GRENADE:    'specialStunGrenade',
            USE_VITALS:          'specialVitals',
            USE_SUPER_VITALS:    'specialSuperVitals',
            USE_NUKE:            'specialNuke',
            USE_PUPPETEER:       'specialReverse',   // reuse a subtle sound
            USE_POSITION_SWAP:   'specialBlindSnatch',
            SHOW:                'show',
            END_GAME:            'gameEnd',
          }
          const soundName = SOUND_ACTION_MAP[action.type]
          if (soundName) {
            broadcastToRoom(roomCode, {
              type:       'SOUND_EVENT',
              sound:      soundName,
              roomCode,
              byPlayerId: playerId,
              id:         `${action.type}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            })
          }

          // ── yourTurn sound: send only to the next human player ─
          if (['PASS','USE_REVERSE','USE_FREEZE','BLIND_SNATCH_PICK',
               'REVEALED_SNATCH_PICK_CHIT','NUKE_PICK_CARD',
               'STUN_GRENADE_PICK','FREEZE_PICK','PUPPETEER_PICK',
               'POSITION_SWAP_PICK'].includes(action.type)
              && result.room.phase === 'playing') {
            const nextTurn   = result.room.currentTurn
            const nextPlayer = result.room.players[nextTurn]
            if (nextPlayer && !nextPlayer.isBot && !nextPlayer.botActive && nextPlayer.online) {
              sendToPlayer(roomCode, nextPlayer.id, {
                type:  'SOUND_EVENT',
                sound: 'yourTurn',
                id:    `yourTurn_${action.type}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              })
            }
          }

          maybeScheduleBotTurn(roomCode, result.room)
        } catch (err) {
          console.error('[ACTION]', err)
          sendTo(ws, { type: 'ERROR', message: 'Server error processing action.' })
        }
        break
      }

      // ── LEAVE_ROOM ───────────────────────────────────────────────
      case 'LEAVE_ROOM': {
        const { roomCode, playerId } = data
        try {
          const mem = getEntry(roomCode)
          mem.clients.delete(ws)
          ws.roomCode = null
          ws.playerId = null
          console.log(`[LEAVE] ${roomCode} — "${playerId}"`)

          const entry = await loadRoom(roomCode)
          if (!entry) return

          if (entry.room.phase === 'lobby') {
            const leavingIdx = entry.room.players.findIndex(p => p.id === playerId && !p.isBot)
            if (leavingIdx !== -1) {
              entry.room.players.splice(leavingIdx, 1)
              if (entry.room.hostId === playerId) entry.room = transferHost(entry.room)
            }

            if (getOnlineHumanCount(entry.room) === 0 || entry.room.players.filter(p => !p.isBot).length === 0) {
              cancelRoomCleanup(roomCode)
              await deleteEmptyLobbyNow(roomCode)
            } else {
              await saveRoom(roomCode, entry)
              if (mem.clients.size > 0) broadcastState(roomCode, entry.room, entry.logs)
              if (entry.isPublic) broadcastRoomsList()
            }
          } else {
            if (mem.clients.size > 0) {
              broadcastState(roomCode, entry.room, entry.logs)
              if (entry.isPublic) broadcastRoomsList()
            }
          }
        } catch (err) {
          console.error('[LEAVE_ROOM]', err)
        }
        break
      }

      // ── VOICE SIGNALING ──────────────────────────────────────────
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

  // ── Disconnect handler ────────────────────────────────────────────
  ws.on('close', async () => {
    const { roomCode, playerId } = ws
    if (!roomCode) return
    console.log('[WS CLOSE]', roomCode, playerId)

    const mem = getEntry(roomCode)
    mem.clients.delete(ws)
    console.log(`[DISCONNECT] ${roomCode} — playerId: ${playerId} — clients remaining: ${mem.clients.size}`)

    try {
      const entry = await loadRoom(roomCode)
      if (!entry) return

      sanitizeRoom(entry.room)

      const playerIdx = entry.room.players.findIndex(p => p.id === playerId)

      if (playerIdx !== -1 && !entry.room.players[playerIdx].isBot) {
        const player = entry.room.players[playerIdx]

        if (['playing', 'showWindow', 'pendingSpecial'].includes(entry.room.phase)) {
          // Bot takeover mid-game
          player.online         = false
          player.botActive      = true
          player.disconnectedAt = Date.now()

          if (entry.room.hostId === playerId) {
            entry.room = transferHost(entry.room)
            entry.logs = [`Host transferred to ${entry.room.players.find(p => p.id === entry.room.hostId)?.name ?? 'unknown'}.`, ...entry.logs]
          }

          entry.logs = [`${player.name} disconnected. Bot taking over.`, ...entry.logs]
          await saveRoom(roomCode, entry)
          broadcastState(roomCode, entry.room, entry.logs)

          if (entry.room.phase === 'playing' && entry.room.currentTurn === playerIdx) {
            scheduleBotTurn(roomCode, playerIdx, 800)
          }
        } else if (entry.room.phase === 'lobby') {
          player.online = false
          if (entry.room.hostId === playerId) entry.room = transferHost(entry.room)

          if (getOnlineHumanCount(entry.room) === 0) {
            await saveRoom(roomCode, entry)
            console.log('[LOBBY CLEANUP SCHEDULED]', roomCode)
            scheduleRoomCleanup(roomCode)
          } else {
            await saveRoom(roomCode, entry)
            if (mem.clients.size > 0) broadcastState(roomCode, entry.room, entry.logs)
          }
        } else {
          // roundEnd / afterShow / ended
          player.online = false
          if (entry.room.hostId === playerId) entry.room = transferHost(entry.room)
          await saveRoom(roomCode, entry)
          broadcastState(roomCode, entry.room, entry.logs)
        }
      }

      if (entry.isPublic) broadcastRoomsList()

      // No humans online during active game — stop bots, schedule 2-min cleanup
      if (['playing','showWindow','pendingSpecial','roundEnd','afterShow'].includes(entry.room.phase)) {
        const hasOnlineHuman = entry.room.players.some(p => !p.isBot && p.online)
        if (!hasOnlineHuman) {
          clearBotTimer(roomCode)
          console.log(`[CLEANUP] No humans online in active game ${roomCode} — scheduling 2-min cleanup.`)
          const mem2 = getEntry(roomCode)
          if (mem2.cleanupTimer) clearTimeout(mem2.cleanupTimer)
          mem2.cleanupTimer = setTimeout(async () => {
            mem2.cleanupTimer = null
            const fresh = await loadRoom(roomCode).catch(() => null)
            if (!fresh) return
            if (fresh.room.players.some(p => !p.isBot && p.online)) return
            console.log(`[CLEANUP] Still no humans — deleting room ${roomCode}`)
            await deleteRoom(roomCode).catch(() => {})
            await removePublicRoom(roomCode).catch(() => {})
            entries.delete(roomCode)
            broadcastRoomsList()
          }, 2 * 60 * 1000)
        }
      }
    } catch (err) {
      console.error('[DISCONNECT handler]', err)
    }
  })

  ws.on('error', () => ws.terminate())
})

httpServer.listen(PORT, () => console.log(`Show Game Server on :${PORT}`))