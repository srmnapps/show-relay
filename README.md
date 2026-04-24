# Show Game — WebSocket Relay

Minimal WebSocket relay server for the Show game.
Deploy this on Render.com (free) — takes 3 minutes.

## Local dev
```bash
npm install
npm run dev   # → ws://localhost:3001
```

## Deploy on Render (free)
1. Push this folder to a GitHub repo
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - Name: show-relay
   - Runtime: Node
   - Build Command: npm install
   - Start Command: npm start
5. Click Deploy
6. Get your URL: wss://show-relay-xxxx.onrender.com
7. Put that URL in your frontend .env file
