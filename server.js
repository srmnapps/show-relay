import { WebSocketServer } from "ws"
import http from "http"

const PORT = process.env.PORT || 3001

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" })
  res.end("Show Game Relay — OK")
})

const wss = new WebSocketServer({ server: httpServer })
const rooms = new Map()

wss.on("connection", (ws) => {
  let myRoom = null

  ws.on("message", (raw) => {
    let data
    try { data = JSON.parse(raw) } catch { return }
    if (!data.room || !data.type) return

    if (data.type === "JOIN_ROOM") {
      myRoom = data.room
      if (!rooms.has(myRoom)) rooms.set(myRoom, new Set())
      rooms.get(myRoom).add(ws)
      console.log(`[+] ${myRoom} peers: ${rooms.get(myRoom).size}`)
      ws.send(JSON.stringify({ type: "JOINED" }))
      return
    }

    // Relay to all peers EXCEPT sender
    const peers = rooms.get(data.room)
    if (!peers) return
    const msg = JSON.stringify(data)
    peers.forEach(peer => {
      if (peer !== ws && peer.readyState === 1) peer.send(msg)
    })
  })

  ws.on("close", () => {
    if (!myRoom) return
    rooms.get(myRoom)?.delete(ws)
    if (rooms.get(myRoom)?.size === 0) rooms.delete(myRoom)
    console.log(`[-] ${myRoom} peers: ${rooms.get(myRoom)?.size ?? 0}`)
  })

  ws.on("error", () => ws.terminate())
})

httpServer.listen(PORT, () => console.log(`Relay on :${PORT}`))