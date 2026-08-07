// Cloudflare Pages Function for WebRTC Signaling
// File: /functions/signal.js (Handles WebSocket connections on /signal)

// Global map to hold active rooms and peer connections.
// Since Cloudflare Workers are stateless, a global map persists in-memory
// within the active isolate. For multi-region scaling, Cloudflare Pages support
// Durable Objects, but for standard setups, this in-memory fallback works beautifully!
const rooms = new Map(); // roomId -> Map(peerId -> websocket)

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const peerId = url.searchParams.get('peerId');
  if (!peerId) {
    return new Response('peerId is required', { status: 400 });
  }

  const publicIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'default';
  const roomParam = url.searchParams.get('room');
  const roomId = (roomParam && roomParam !== 'filedrop-default-room')
    ? roomParam
    : publicIp;

  // Upgrade connection to WebSocket
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  // Handle Durable Objects if configured under the name "SIGNAL_ROOMS"
  if (env.SIGNAL_ROOMS) {
    const id = env.SIGNAL_ROOMS.idFromName(roomId);
    const roomObject = env.SIGNAL_ROOMS.get(id);
    return roomObject.fetch(request);
  }

  // Standard WebSockets within the active isolate (In-Memory Fallback)
  const [client, server] = new WebSocketPair();
  server.accept();

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  const room = rooms.get(roomId);

  // Send list of existing peers to the new peer
  const existingPeers = Array.from(room.keys());
  server.send(JSON.stringify({ type: 'PEER_LIST', peers: existingPeers }));

  // Notify other peers in this room
  const joinedMessage = JSON.stringify({ type: 'PEER_JOINED', peerId });
  room.forEach((peerWs, id) => {
    if (id !== peerId && peerWs.readyState === 1) { // 1 is OPEN
      try {
        peerWs.send(joinedMessage);
      } catch (err) {
        console.error(`Error notifying join to ${id}:`, err);
      }
    }
  });

  // Store connection
  room.set(peerId, server);

  server.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.to && room.has(msg.to)) {
        const targetWs = room.get(msg.to);
        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify({ ...msg, from: peerId }));
        }
      }
    } catch (err) {
      console.error('Error forwarding message:', err);
    }
  });

  const cleanup = () => {
    if (room.get(peerId) === server) {
      room.delete(peerId);
      const leaveMessage = JSON.stringify({ type: 'PEER_LEFT', peerId });
      room.forEach((peerWs, id) => {
        if (peerWs.readyState === 1) {
          try {
            peerWs.send(leaveMessage);
          } catch (err) {
            console.error(`Error notifying leave to ${id}:`, err);
          }
        }
      });
      if (room.size === 0) {
        rooms.delete(roomId);
      }
    }
  };

  server.addEventListener('close', cleanup);
  server.addEventListener('error', cleanup);

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
