// show-relay/server.js
// Server-authoritative game server (ESM)

import { WebSocketServer } from 'ws'
import http from 'http'
import { makeRoom, makePlayer, applyServerAction } from './game/game.js'

const PORT = process.env.PORT || 3001

// ── Room registry ─────────────────────────────────────────────────
// rooms: Map<roomCode, { room, logs, clients: Set<WebSocket>, timers: {} }>
const rooms = new Map()

// ── Utilities ─────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]
  // Ensure uniqueness
  return rooms.has(code) ? generateRoomCode() : code
}

function broadcast(entry, payload) {
  const msg = JSON.stringify(payload)
  entry.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg)
  })
}

function broadcastState(entry) {
  broadcast(entry, {
    type: 'STATE_SYNC',
    payload: entry.room,
    logs: entry.logs,
  })
}

function sendTo(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload))
}

// ── SHOW timer ────────────────────────────────────────────────────
function scheduleShowResolve(entry) {
  // Clear any previous show timers
  clearTimeout(entry.timers.showResolve)
  clearTimeout(entry.timers.roundEnd)

  entry.timers.showResolve = setTimeout(() => {
    const result = applyServerAction(entry.room, entry.logs, { type: 'SHOW_RESOLVE' }, entry.room.players[entry.room.showCaller]?.id)
    if (result.error) return
    entry.room = result.room
    entry.logs = result.logs
    broadcastState(entry)

    entry.timers.roundEnd = setTimeout(() => {
      const r2 = applyServerAction(entry.room, entry.logs, { type: 'ROUND_END' }, entry.room.players[0]?.id)
      if (!r2.error) {
        entry.room = r2.room
        entry.logs = r2.logs
        broadcastState(entry)
      }
    }, 1800)
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

  ws.on('message', (raw) => {
    let data
    try { data = JSON.parse(raw) } catch { return }
    if (!data.type) return

    switch (data.type) {

      // ── CREATE_ROOM ───────────────────────────────────────────
      case 'CREATE_ROOM': {
        const { player } = data
        if (!player?.id || !player?.name) {
          return sendTo(ws, { type: 'ERROR', message: 'Invalid player info.' })
        }

        const roomCode = generateRoomCode()
        const host     = makePlayer(player.id, player.name, 0)
        const room     = makeRoom(roomCode, host)
        const logs     = ['Room created! Share the code.']
        const entry    = { room, logs, clients: new Set([ws]), timers: {} }

        rooms.set(roomCode, entry)
        ws.roomCode = roomCode
        ws.playerId = player.id

        console.log(`[CREATE] ${roomCode} by "${player.name}"`)

        sendTo(ws, {
          type:     'ROOM_CREATED',
          roomCode,
          playerId: player.id,
          room,
          logs,
        })
        break
      }

      // ── JOIN_ROOM ─────────────────────────────────────────────
      case 'JOIN_ROOM': {
        const { roomCode, player } = data
        if (!roomCode || !player?.id || !player?.name) {
          return sendTo(ws, { type: 'ERROR', message: 'Invalid join request.' })
        }

        const entry = rooms.get(roomCode)
        if (!entry) {
          return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })
        }

        // Attach socket to room
        entry.clients.add(ws)
        ws.roomCode = roomCode
        ws.playerId = player.id

        const existing = entry.room.players.find(p => p.id === player.id)

        if (!existing) {
          // New player — only add if lobby + space available
          if (entry.room.phase !== 'lobby') {
            return sendTo(ws, { type: 'ERROR', message: 'Game already started.' })
          }
          if (entry.room.players.length >= 5) {
            return sendTo(ws, { type: 'ERROR', message: 'Room is full.' })
          }
          const newPlayer = makePlayer(player.id, player.name, entry.room.players.length)
          entry.room = { ...entry.room, players: [...entry.room.players, newPlayer] }
          entry.logs = [`${player.name} joined!`, ...entry.logs]
          console.log(`[JOIN] ${roomCode} ← "${player.name}" (${entry.room.players.length} players)`)
        } else {
          // Reconnect
          console.log(`[REJOIN] ${roomCode} ← "${player.name}"`)
        }

        sendTo(ws, {
          type:     'JOINED_ROOM',
          roomCode,
          playerId: player.id,
          room:     entry.room,
          logs:     entry.logs,
        })

        // Broadcast updated state to everyone else
        entry.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify({
              type:    'STATE_SYNC',
              payload: entry.room,
              logs:    entry.logs,
            }))
          }
        })
        break
      }

      // ── REQUEST_STATE ─────────────────────────────────────────
      case 'REQUEST_STATE': {
        const { roomCode, playerId } = data
        const entry = rooms.get(roomCode)
        if (!entry) {
          return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })
        }
        sendTo(ws, {
          type:    'STATE_SYNC',
          payload: entry.room,
          logs:    entry.logs,
        })
        break
      }

      // ── ACTION ────────────────────────────────────────────────
      case 'ACTION': {
        const { roomCode, playerId, action } = data
        const entry = rooms.get(roomCode)
        if (!entry) {
          return sendTo(ws, { type: 'ERROR', message: 'Room not found.' })
        }

        const result = applyServerAction(entry.room, entry.logs, action, playerId)
        if (result.error) {
          return sendTo(ws, { type: 'ERROR', message: result.error })
        }

        entry.room = result.room
        entry.logs = result.logs

        // Server owns SHOW timer
        if (action.type === 'SHOW') {
          scheduleShowResolve(entry)
        }

        broadcastState(entry)
        break
      }

      // ── LEAVE_ROOM ────────────────────────────────────────────
      case 'LEAVE_ROOM': {
        const { roomCode, playerId } = data
        const entry = rooms.get(roomCode)
        if (!entry) return

        entry.clients.delete(ws)
        ws.roomCode = null
        ws.playerId = null

        console.log(`[LEAVE] ${roomCode} — "${playerId}"`)

        // Keep player in room for potential reconnect; broadcast to remaining clients
        if (entry.clients.size > 0) {
          broadcastState(entry)
        } else {
          // No clients left — clean up timers but keep room briefly for reconnect
          clearTimeout(entry.timers.showResolve)
          clearTimeout(entry.timers.roundEnd)
        }
        break
      }

      default:
        break
    }
  })

  ws.on('close', () => {
    const { roomCode } = ws
    if (!roomCode) return
    const entry = rooms.get(roomCode)
    if (!entry) return

    entry.clients.delete(ws)
    console.log(`[DISCONNECT] ${roomCode} — clients remaining: ${entry.clients.size}`)

    if (entry.clients.size === 0) {
      // Clean up timers; optionally delete room after a grace period
      clearTimeout(entry.timers.showResolve)
      clearTimeout(entry.timers.roundEnd)
      setTimeout(() => {
        const e = rooms.get(roomCode)
        if (e && e.clients.size === 0) {
          rooms.delete(roomCode)
          console.log(`[CLEANUP] Room ${roomCode} removed.`)
        }
      }, 60_000) // 1 minute grace for reconnect
    }
  })

  ws.on('error', () => ws.terminate())
})

httpServer.listen(PORT, () => console.log(`Show Game Server on :${PORT}`))