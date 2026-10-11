/**
 * Relay self-test: exercises the full protocol through a real server with a
 * fake extension peer and the real driver CLI.
 *
 * Run: node relay/test.js
 */
import { createRelay } from './server.js';
import WebSocket from 'ws';
import { spawn } from 'child_process';

const KEY = 'test-connector-key-0123456789abcdef';
let failures = 0;
function assert(cond, name) {
  console.log(cond ? `  ok - ${name}` : `  FAIL - ${name}`);
  if (!cond) failures++;
}
function queue(ws) {
  const buf = [];
  const waiters = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const i = waiters.findIndex((w) => w.types.includes(m.type));
    if (i !== -1) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
    } else {
      buf.push(m);
    }
  });
  return {
    next(types, timeoutMs = 5000) {
      const bi = buf.findIndex((m) => types.includes(m.type));
      if (bi !== -1) return Promise.resolve(buf.splice(bi, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = {
          types, resolve,
          timer: setTimeout(() => {
            const j = waiters.indexOf(w);
            if (j !== -1) waiters.splice(j, 1);
            reject(new Error('timeout: ' + types.join('/')));
          }, timeoutMs),
        };
        waiters.push(w);
      });
    },
  };
}
const connect = (port) => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('open', () => res({ ws, q: queue(ws) }));
  ws.on('error', rej);
});

// Fake extension: pairs, then behaves like the real service worker's gate.
async function fakeExtension(port) {
  const { ws, q } = await connect(port);
  ws.send(JSON.stringify({ v: 1, type: 'pair.request', role: 'extension', key: KEY }));
  await q.next(['pair.confirm']);
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.v !== 1) return;
    if (m.type === 'observe.request') {
      ws.send(JSON.stringify({ v: 1, type: 'observe.result', id: m.id, title: 'Fake page', url: 'https://example.com', elements: [] }));
    } else if (m.type === 'act.propose') {
      // Local gate: grant, then report execution (echo the wire id).
      ws.send(JSON.stringify({ v: 1, type: 'consent.grant', id: m.id, scope: 'once' }));
      ws.send(JSON.stringify({ v: 1, type: 'act.result', id: m.id, ok: true }));
    }
  });
  return { ws, q };
}

async function main() {
  const { httpServer } = createRelay(0);
  await new Promise((r) => httpServer.on('listening', r));
  const port = httpServer.address().port;
  console.log('relay on port', port);

  console.log('test: pairing + observe round-trip');
  const { ws: ext, q: extQ } = await fakeExtension(port);
  const { ws: drv, q: drvQ } = await connect(port);
  drv.send(JSON.stringify({ v: 1, type: 'pair.request', role: 'driver', key: KEY }));
  const confirm = await drvQ.next(['pair.confirm']);
  assert(confirm.role === 'driver' && confirm.peer === true, 'driver pairs and sees extension peer');

  drv.send(JSON.stringify({ v: 1, type: 'observe.request', id: 'o1' }));
  const obs = await drvQ.next(['observe.result']);
  assert(obs.title === 'Fake page' && obs.id === 'o1', 'observe.request → observe.result through relay');

  console.log('test: act.propose → consent.grant → act.result');
  drv.send(JSON.stringify({ v: 1, type: 'act.propose', id: 'a1', proposal: { actionTier: 'T1', type: 'click', target: { ref: 'r1', label: 'x' }, site: 'https://example.com', description: "click x" } }));
  const consent = await drvQ.next(['consent.grant']);
  const result = await drvQ.next(['act.result']);
  assert(consent.id === 'a1' && result.ok === true, 'full consent flow round-trips');

  console.log('test: wrong key rejected');
  const { ws: bad } = await connect(port);
  const badClosed = new Promise((res) => bad.on('close', (code) => res(code)));
  bad.send(JSON.stringify({ v: 1, type: 'pair.request', role: 'driver', key: 'short' }));
  assert((await badClosed) === 4401, 'short key closed with 4401');

  console.log('test: non-pair first message rejected');
  const { ws: rude } = await connect(port);
  const rudeClosed = new Promise((res) => rude.on('close', (code) => res(code)));
  rude.send(JSON.stringify({ v: 1, type: 'observe.request', id: 'x' }));
  assert((await rudeClosed) === 4401, 'first message must be pair.request');

  console.log('test: real driver.js CLI observe');
  const ROOT = new URL('..', import.meta.url).pathname; // project root (test.js lives in relay/)
  const cli = await new Promise((resolve) => {
    const p = spawn('node', [ROOT + 'driver/driver.js', '--relay', `ws://127.0.0.1:${port}`, '--key', KEY, 'observe'], { cwd: ROOT });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d);
    p.stderr.on('data', (d) => err += d);
    p.on('close', (code) => resolve({ code, out, err }));
  });
  assert(cli.code === 0 && cli.out.includes('Fake page'), 'driver.js CLI observe works end-to-end');

  console.log('test: session.abort tears down the room');
  // Fresh driver connection: the CLI test's pairing replaced the earlier
  // driver socket (by design — one connection per role), so re-pair.
  const { ws: drv2, q: drvQ2 } = await connect(port);
  drv2.send(JSON.stringify({ v: 1, type: 'pair.request', role: 'driver', key: KEY }));
  await drvQ2.next(['pair.confirm']);
  const extClosed = new Promise((res) => ext.on('close', (code) => res(code)));
  drv2.send(JSON.stringify({ v: 1, type: 'session.abort', reason: 'test done' }));
  assert((await extClosed) === 1000, 'abort closes the peer cleanly');

  httpServer.close();
  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test error:', e.message); process.exit(1); });
