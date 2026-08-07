// Cloudflare Worker Script for BoltDrop WebRTC Signaling Server
// Supports both Durable Objects (recommended for multi-region) and isolate WebSockets.

export class SignalRoom {
  constructor(state, env) {
    this.state = state;
    this.peers = new Map(); // peerId -> WebSocket
  }

  async fetch(request) {
    const url = new URL(request.url);
    const peerId = url.searchParams.get('peerId');
    if (!peerId) {
      return new Response('peerId is required', { status: 400 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server, [peerId]);
    this.peers.set(peerId, server);

    // Send existing peers list to the newly connected peer
    const existingPeers = Array.from(this.peers.keys()).filter(id => id !== peerId);
    server.send(JSON.stringify({ type: 'PEER_LIST', peers: existingPeers }));

    // Broadcast join event
    this._broadcast({ type: 'PEER_JOINED', peerId }, peerId);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const msg = JSON.parse(message);
      const tags = this.state.getTags(ws);
      const senderId = tags && tags[0];

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.to && this.peers.has(msg.to)) {
        const targetWs = this.peers.get(msg.to);
        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify({ ...msg, from: senderId }));
        }
      }
    } catch (err) {
      console.error('[SignalRoom] Error parsing message:', err);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const tags = this.state.getTags(ws);
    const peerId = tags && tags[0];
    if (peerId) {
      this.peers.delete(peerId);
      this._broadcast({ type: 'PEER_LEFT', peerId }, peerId);
    }
  }

  async webSocketError(ws, error) {
    this.webSocketClose(ws);
  }

  _broadcast(msg, excludePeerId) {
    const data = JSON.stringify(msg);
    this.peers.forEach((ws, id) => {
      if (id !== excludePeerId && ws.readyState === 1) {
        try {
          ws.send(data);
        } catch (e) {}
      }
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Upgrade',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/signal' || url.pathname === '/') {
      const peerId = url.searchParams.get('peerId');
      if (!peerId) {
        return new Response(
          JSON.stringify({
            status: 'online',
            service: 'BoltDrop WebRTC Signaling Server',
            timestamp: new Date().toISOString()
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const rawIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'default';
      const publicIp = rawIp.split(',')[0].trim().replace(/^::ffff:/, '');
      const roomParam = url.searchParams.get('room');
      const roomId = (roomParam && roomParam !== 'filedrop-default-room')
        ? roomParam
        : publicIp;

      // Primary: Route to Durable Object if configured
      if (env.SIGNAL_ROOMS) {
        const id = env.SIGNAL_ROOMS.idFromName(roomId);
        const roomObject = env.SIGNAL_ROOMS.get(id);
        return roomObject.fetch(request);
      }

      // Fallback: Standard isolate WebSockets
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426, headers: corsHeaders });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      if (!globalThis.rooms) globalThis.rooms = new Map();
      if (!globalThis.rooms.has(roomId)) globalThis.rooms.set(roomId, new Map());
      const room = globalThis.rooms.get(roomId);

      const existingPeers = Array.from(room.keys());
      server.send(JSON.stringify({ type: 'PEER_LIST', peers: existingPeers }));

      const joinedMsg = JSON.stringify({ type: 'PEER_JOINED', peerId });
      room.forEach((peerWs, id) => {
        if (id !== peerId && peerWs.readyState === 1) {
          try { peerWs.send(joinedMsg); } catch (e) {}
        }
      });

      room.set(peerId, server);

      server.addEventListener('message', (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'ping') {
            server.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          if (msg.to && room.has(msg.to)) {
            const target = room.get(msg.to);
            if (target && target.readyState === 1) {
              target.send(JSON.stringify({ ...msg, from: peerId }));
            }
          }
        } catch (e) {}
      });

      const cleanup = () => {
        if (room.get(peerId) === server) {
          room.delete(peerId);
          const leftMsg = JSON.stringify({ type: 'PEER_LEFT', peerId });
          room.forEach((peerWs, id) => {
            if (peerWs.readyState === 1) {
              try { peerWs.send(leftMsg); } catch (e) {}
            }
          });
          if (room.size === 0) globalThis.rooms.delete(roomId);
        }
      };

      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);

      return new Response(null, { status: 101, webSocket: client, headers: corsHeaders });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};
