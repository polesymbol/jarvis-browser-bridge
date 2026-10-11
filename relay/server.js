/**
 * Jarvis Browser Bridge — Relay Server (v1)
 *
 * A WebSocket relay between the user's Chrome extension and the Jarvis driver.
 * Design rules (from ARCHITECTURE.md):
 *  - PASSTHROUGH ONLY. The relay never stores page content, DOM snapshots, or
 *    screenshots. It routes messages between the two paired sides.
 *  - The connector key is transmitted over TLS (wss) and immediately hashed
 *    (SHA-256) to derive the session room id. Raw keys are never logged or
 *    persisted.
 *  - Permission enforcement happens LOCALLY in the extension's service worker
 *    (decideAction). A compromised relay cannot escalate privileges — it can
 *    only forward or drop messages.
 *  - Page content is data, never instructions. The relay does not interpret it.
 *
 * Pairing: both sides open a WebSocket and send as their first message:
 *   { v: 1, type: 'pair.request', role: 'extension' | 'driver', key: '<connector key>' }
 * The relay answers:
 *   { v: 1, type: 'pair.confirm', role, peer: true|false }
 * Afterwards every non-relay message is forwarded to the peer in the same room.
 *
 * Env: PORT (default 8787), TLS_CERT + TLS_KEY (enables wss), DEBUG_TYPES=1
 * to log message types only (never bodies).
 */

import { WebSocketServer } from 'ws';
import { createHash, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { pathToFileURL } from 'url';

const PORT = parseInt(process.env.PORT || '8787', 10);
const DEBUG_TYPES = process.env.DEBUG_TYPES === '1';

/** roomId -> { keyHash: Buffer, extension: WebSocket|null, driver: WebSocket|null, createdAt: number } */
const rooms = new Map();

function roomIdFor(key) {
  const h = createHash('sha256').update(String(key), 'utf8').digest();
  return h.toString('hex');
}

function log(...args) {
  console.log(new Date().toISOString(), '[relay]', ...args);
}

function safeClose(ws, code, reason) {
  try { ws.close(code, reason); } catch { /* already closed */ }
}

/** Forward a protocol message to the peer, if connected. Returns false if no peer. */
function forwardToPeer(room, fromRole, raw) {
  const peer = fromRole === 'extension' ? room.driver : room.extension;
  if (peer && peer.readyState === 1) {
    peer.send(raw);
    return true;
  }
  return false;
}

function destroyRoom(roomId, reason) {
  const room = rooms.get(roomId);
  if (!room) return;
  rooms.delete(roomId);
  for (const ws of [room.extension, room.driver]) {
    if (ws) safeClose(ws, 1000, reason || 'session ended');
  }
  log(`room ${roomId.slice(0, 8)}… destroyed (${reason || 'session ended'})`);
}

function handlePair(ws, msg) {
  const { role, key } = msg;
  if ((role !== 'extension' && role !== 'driver') || typeof key !== 'string' || key.length < 16) {
    safeClose(ws, 4401, 'invalid pair.request');
    return null;
  }
  const roomId = roomIdFor(key);
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      keyHash: createHash('sha256').update(key, 'utf8').digest(),
      extension: null,
      driver: null,
      createdAt: Date.now(),
    };
    rooms.set(roomId, room);
  }
  // One connection per role: a new connection replaces a stale one.
  if (room[role] && room[role] !== ws) {
    safeClose(room[role], 4409, 'replaced by new connection');
  }
  room[role] = ws;
  ws._roomId = roomId;
  ws._role = role;

  const peerConnected = !!room[role === 'extension' ? 'driver' : 'extension'];
  ws.send(JSON.stringify({ v: 1, type: 'pair.confirm', role, peer: peerConnected }));
  log(`paired role=${role} room=${roomId.slice(0, 8)}… peer=${peerConnected}`);

  // Notify the already-connected peer that its counterpart arrived.
  const peer = room[role === 'extension' ? 'driver' : 'extension'];
  if (peer && peer.readyState === 1) {
    peer.send(JSON.stringify({ v: 1, type: 'peer.joined', role }));
  }
  return room;
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    safeClose(ws, 4400, 'message must be JSON');
    return;
  }
  if (msg.v !== 1 || typeof msg.type !== 'string') {
    safeClose(ws, 4400, 'protocol v1 requires {v:1, type}');
    return;
  }
  if (DEBUG_TYPES) log('type:', msg.type, 'role:', ws._role);

  // session.abort tears the room down after forwarding.
  if (msg.type === 'session.abort') {
    const room = rooms.get(ws._roomId);
    if (room) {
      forwardToPeer(room, ws._role, raw.toString());
      destroyRoom(ws._roomId, 'abort');
    }
    return;
  }

  const room = rooms.get(ws._roomId);
  if (!room) {
    safeClose(ws, 4401, 'not paired');
    return;
  }
  if (!forwardToPeer(room, ws._role, raw.toString())) {
    ws.send(JSON.stringify({ v: 1, type: 'peer.unavailable' }));
  }
}

function onDisconnect(ws) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  if (room[ws._role] === ws) room[ws._role] = null;
  const peer = room[ws._role === 'extension' ? 'driver' : 'extension'];
  if (peer && peer.readyState === 1) {
    peer.send(JSON.stringify({ v: 1, type: 'peer.left', role: ws._role }));
  }
  if (!room.extension && !room.driver) {
    rooms.delete(ws._roomId);
    log(`room ${ws._roomId.slice(0, 8)}… cleaned up (both sides gone)`);
  }
}

export function createRelay(port = PORT) {
  let httpServer;
  if (process.env.TLS_CERT && process.env.TLS_KEY) {
    httpServer = createHttpsServer({
      cert: readFileSync(process.env.TLS_CERT),
      key: readFileSync(process.env.TLS_KEY),
    });
    log('TLS enabled (wss)');
  } else {
    httpServer = createHttpServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      } else {
        res.writeHead(404); res.end();
      }
    });
    log('plain ws (no TLS_CERT/TLS_KEY) — private/dev use only');
  }

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    let paired = false;
    // First message must be pair.request; anything else is rejected.
    const firstTimer = setTimeout(() => {
      if (!paired) safeClose(ws, 4401, 'pair.request required first');
    }, 10000);

    ws.on('message', (raw) => {
      if (!paired) {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { safeClose(ws, 4400, 'message must be JSON'); return; }
        if (msg.v !== 1 || msg.type !== 'pair.request') {
          safeClose(ws, 4401, 'pair.request required first');
          return;
        }
        const room = handlePair(ws, msg);
        if (room) {
          paired = true;
          clearTimeout(firstTimer);
          // Heartbeat.
          ws._hb = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 30000);
        }
        return;
      }
      handleMessage(ws, raw);
    });

    ws.on('close', () => { clearTimeout(firstTimer); clearInterval(ws._hb); onDisconnect(ws); });
    ws.on('error', () => { /* close event follows */ });
  });

  httpServer.listen(port, () => log(`listening on port ${port}`));
  return { httpServer, wss, rooms };
}

// Run directly: `node relay/server.js`
// pathToFileURL comparison is Windows-safe (handles drive letters,
// backslashes, and spaces like "My Projects").
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createRelay();
}
