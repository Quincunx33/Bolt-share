// Cloudflare Worker Script for BoltDrop WebRTC Signaling Server
// Supports both Durable Objects (recommended for multi-region) and isolate WebSockets.

export class SignalRoom {
  constructor(state, env) {
    this.state = state;
  }

  // Retrieve active websockets & peer IDs directly from state tags
  // This is immune to Durable Object hibernation memory resets!
  _getPeersMap() {
    const map = new Map();
    const sockets = this.state.getWebSockets();
    for (const socket of sockets) {
      const tags = this.state.getTags(socket);
      if (tags && tags[0]) {
        map.set(tags[0], socket);
      }
    }
    return map;
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

    // Accept WebSocket and tag with peerId for hibernation support
    this.state.acceptWebSocket(server, [peerId]);

    const peersMap = this._getPeersMap();

    // Send existing peers list to the newly connected peer
    const existingPeers = Array.from(peersMap.keys()).filter(id => id !== peerId);
    server.send(JSON.stringify({ type: 'PEER_LIST', peers: existingPeers }));

    // Broadcast join event to all other peers in the room
    this._broadcast({ type: 'PEER_JOINED', peerId }, peerId);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const msg = JSON.parse(message);
      const tags = this.state.getTags(ws);
      const senderId = tags && tags[0];

      if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
        return;
      }

      if (msg.to) {
        const peersMap = this._getPeersMap();
        if (peersMap.has(msg.to)) {
          const targetWs = peersMap.get(msg.to);
          if (targetWs && targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({ ...msg, from: senderId }));
          }
        }
      }
    } catch (err) {
      console.error('[SignalRoom] Error handling message:', err);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const tags = this.state.getTags(ws);
    const peerId = tags && tags[0];
    if (peerId) {
      this._broadcast({ type: 'PEER_LEFT', peerId }, peerId);
    }
  }

  async webSocketError(ws, error) {
    this.webSocketClose(ws);
  }

  _broadcast(msg, excludePeerId) {
    const data = JSON.stringify(msg);
    const peersMap = this._getPeersMap();
    peersMap.forEach((ws, id) => {
      if (id !== excludePeerId && ws.readyState === 1) {
        try {
          ws.send(data);
        } catch (e) {}
      }
    });
  }
}

function getNetworkRoomId(request, roomParam) {
  if (roomParam && roomParam !== 'filedrop-default-room') {
    return roomParam;
  }
  const rawIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'default';
  const cleanIp = rawIp.split(',')[0].trim().replace(/^::ffff:/, '');

  if (cleanIp.includes(':')) {
    // IPv6 address — group by /64 prefix (first 4 segments) so devices on same Wi-Fi match!
    const parts = cleanIp.split(':').filter(Boolean);
    const prefix = parts.slice(0, Math.min(4, parts.length)).join(':');
    return `v6-${prefix}`;
  }
  // IPv4 address
  return `v4-${cleanIp}`;
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

    // Handle signaling only on /signal route
    if (url.pathname === '/signal') {
      const peerId = url.searchParams.get('peerId');
      if (!peerId) {
        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
          return new Response(
            JSON.stringify({
              status: 'online',
              service: 'BoltDrop WebRTC Signaling Server',
              timestamp: new Date().toISOString()
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        return new Response('peerId is required', { status: 400, headers: corsHeaders });
      }

      const roomParam = url.searchParams.get('room');
      const roomId = getNetworkRoomId(request, roomParam);

      // Primary: Route to Durable Object if configured
      if (env.SIGNAL_ROOMS) {
        const id = env.SIGNAL_ROOMS.idFromName(roomId);
        const roomObject = env.SIGNAL_ROOMS.get(id);
        return roomObject.fetch(request);
      }

      // Fallback: Standard isolate WebSockets with BroadcastChannel cross-isolate synchronization
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426, headers: corsHeaders });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      if (!globalThis.rooms) globalThis.rooms = new Map();
      
      if (!globalThis.rooms.has(roomId)) {
        let channel = null;
        try {
          channel = new BroadcastChannel('filedrop-room-' + roomId);
        } catch (e) {
          console.warn('[Isolate] BroadcastChannel not supported:', e);
        }

        const roomData = {
          peers: new Map(),
          channel
        };

        if (channel) {
          channel.onmessage = (event) => {
            try {
              const data = event.data;
              const currentRoom = globalThis.rooms.get(roomId);
              if (!currentRoom) return;

              if (data.type === 'BC_PING_PEERS') {
                const localPeerIds = Array.from(currentRoom.peers.keys());
                if (localPeerIds.length > 0 && channel) {
                  channel.postMessage({
                    type: 'BC_PONG_PEERS',
                    fromIsolatePeers: localPeerIds,
                    requesterPeerId: data.requesterPeerId
                  });
                }
              } else if (data.type === 'BC_PONG_PEERS') {
                if (data.requesterPeerId) {
                  const targetWs = currentRoom.peers.get(data.requesterPeerId);
                  if (targetWs && targetWs.readyState === 1) {
                    data.fromIsolatePeers.forEach(pid => {
                      if (pid !== data.requesterPeerId) {
                        try {
                          targetWs.send(JSON.stringify({ type: 'PEER_JOINED', peerId: pid }));
                        } catch (e) {}
                      }
                    });
                  }
                }
              } else if (data.type === 'BC_PEER_JOINED') {
                const joinedMsg = JSON.stringify({ type: 'PEER_JOINED', peerId: data.peerId });
                currentRoom.peers.forEach((ws, pid) => {
                  if (pid !== data.peerId && ws.readyState === 1) {
                    try { ws.send(joinedMsg); } catch (e) {}
                  }
                });
              } else if (data.type === 'BC_PEER_LEFT') {
                const leftMsg = JSON.stringify({ type: 'PEER_LEFT', peerId: data.peerId });
                currentRoom.peers.forEach((ws) => {
                  if (ws.readyState === 1) {
                    try { ws.send(leftMsg); } catch (e) {}
                  }
                });
              } else if (data.type === 'BC_SIGNAL') {
                const targetWs = currentRoom.peers.get(data.to);
                if (targetWs && targetWs.readyState === 1) {
                  try { targetWs.send(JSON.stringify(data.payload)); } catch (e) {}
                }
              }
            } catch (err) {
              console.error('[BC Error]', err);
            }
          };
        }

        globalThis.rooms.set(roomId, roomData);
      }

      const roomData = globalThis.rooms.get(roomId);
      const localPeers = roomData.peers;
      const bc = roomData.channel;

      // Send local peers list
      const existingLocalPeers = Array.from(localPeers.keys());
      server.send(JSON.stringify({ type: 'PEER_LIST', peers: existingLocalPeers }));

      // Send joined msg to local peers
      const joinedMsg = JSON.stringify({ type: 'PEER_JOINED', peerId });
      localPeers.forEach((peerWs, id) => {
        if (id !== peerId && peerWs.readyState === 1) {
          try { peerWs.send(joinedMsg); } catch (e) {}
        }
      });

      // Register local peer
      localPeers.set(peerId, server);

      // Broadcast to other isolates
      if (bc) {
        try {
          bc.postMessage({ type: 'BC_PEER_JOINED', peerId });
          bc.postMessage({ type: 'BC_PING_PEERS', requesterPeerId: peerId });
        } catch (e) {}
      }

      server.addEventListener('message', (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'ping') {
            try { server.send(JSON.stringify({ type: 'pong' })); } catch(e){}
            return;
          }
          if (msg.to) {
            if (localPeers.has(msg.to)) {
              const target = localPeers.get(msg.to);
              if (target && target.readyState === 1) {
                target.send(JSON.stringify({ ...msg, from: peerId }));
              }
            } else if (bc) {
              try {
                bc.postMessage({
                  type: 'BC_SIGNAL',
                  to: msg.to,
                  payload: { ...msg, from: peerId }
                });
              } catch (e) {}
            }
          }
        } catch (e) {}
      });

      const cleanup = () => {
        if (localPeers.get(peerId) === server) {
          localPeers.delete(peerId);

          const leftMsg = JSON.stringify({ type: 'PEER_LEFT', peerId });
          localPeers.forEach((peerWs) => {
            if (peerWs.readyState === 1) {
              try { peerWs.send(leftMsg); } catch (e) {}
            }
          });

          if (bc) {
            try {
              bc.postMessage({ type: 'BC_PEER_LEFT', peerId });
            } catch (e) {}
          }

          if (localPeers.size === 0) {
            if (bc) {
              try { bc.close(); } catch (e) {}
            }
            globalThis.rooms.delete(roomId);
          }
        }
      };

      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);

      return new Response(null, { status: 101, webSocket: client, headers: corsHeaders });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};
