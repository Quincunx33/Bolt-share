import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Rooms map: roomId -> Map(peerId -> websocket)
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function broadcastToRoom(roomId, msg, excludePeerId) {
  const roomPeers = rooms.get(roomId);
  if (!roomPeers) return;
  const data = JSON.stringify(msg);
  roomPeers.forEach((ws, id) => {
    if (id !== excludePeerId && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

// Handle HTTP requests and upgrade WebSocket
server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/signal') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch (err) {
    console.error('[server] error during upgrade:', err);
    socket.destroy();
  }
});

wss.on('connection', (ws, request) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const peerId = url.searchParams.get('peerId');
    if (!peerId) {
      ws.close(4000, 'peerId required');
      return;
    }

    // Determine room — group by connection IP or room override param
    const rawIp = request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'default';
    const cleanIp = rawIp.split(',')[0].trim().replace(/^::ffff:/, '');
    const roomParam = url.searchParams.get('room');
    
    let roomId = cleanIp;
    if (roomParam && roomParam !== 'filedrop-default-room') {
      roomId = roomParam;
    } else if (cleanIp.includes(':')) {
      const parts = cleanIp.split(':').filter(Boolean);
      const prefix = parts.slice(0, Math.min(4, parts.length)).join(':');
      roomId = `v6-${prefix}`;
    } else {
      roomId = `v4-${cleanIp}`;
    }

    console.log(`[signal] peer ${peerId} joining room ${roomId} (IP: ${cleanIp})`);

    const room = getOrCreateRoom(roomId);

    // Send the joining peer the list of existing peers
    const existingPeers = Array.from(room.keys());
    ws.send(JSON.stringify({ type: 'PEER_LIST', peers: existingPeers }));

    // Notify existing peers
    broadcastToRoom(roomId, { type: 'PEER_JOINED', peerId }, peerId);

    // Register this peer
    room.set(peerId, ws);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (msg.to && room.has(msg.to)) {
          const targetWs = room.get(msg.to);
          if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ ...msg, from: peerId }));
          }
        }
      } catch (e) {
        console.error('[signal] error forwarding message:', e);
      }
    });

    const cleanup = () => {
      if (room.get(peerId) === ws) {
        room.delete(peerId);
        console.log(`[signal] peer ${peerId} left room ${roomId}`);
        broadcastToRoom(roomId, { type: 'PEER_LEFT', peerId }, peerId);
        if (room.size === 0) {
          rooms.delete(roomId);
        }
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  } catch (err) {
    console.error('[signal] connection error:', err);
    ws.close(1011, 'Internal Error');
  }
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
      root: __dirname
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.use((req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[server] failed to start:', err);
});
