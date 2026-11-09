/**
 * Jarvis Browser Bridge — Driver (Jarvis side, v1)
 *
 * Node client that speaks protocol v1.0 as role 'driver'. The extension holds
 * role 'extension' and enforces permissions locally; this client only proposes.
 *
 * CLI (for private testing; later driven programmatically by the agent):
 *   node driver/driver.js --relay ws://127.0.0.1:8787 --key <connector-key> observe
 *   node driver/driver.js --relay <url> --key <key> act --type click --target "Add to cart" --tier T1
 *   node driver/driver.js --relay <url> --key <key> act --type type --target "search box" --value "wireless headphones" --tier T2
 *   node driver/driver.js --relay <url> --key <key> act --type key --press-key Enter --tier T1
 *   node driver/driver.js --relay <url> --key <key> status
 *   node driver/driver.js --relay <url> --key <key> abort
 *
 * Flags:
 *   --key <connector-key>   The shared connector secret (or env KEY). This is
 *                           the ONLY meaning of --key. The keypress action's
 *                           key name travels in --press-key, never --key.
 *   --press-key <name>      Key to press for `--type key` (e.g. Enter, Tab,
 *                           Escape). Required when --type is key.
 *
 * Output contract (relied on by downstream tooling):
 *   EVERY invocation prints valid JSON to stdout. Success prints the protocol
 *   result (or a status object). Failure prints
 *     {"ok": false, "error": "<CODE>", "message": "<plain-language reason>"}
 *   to stdout and exits non-zero. Stdout is NEVER an empty file — an empty
 *   stdout used to be misread downstream as an extension outage. Human
 *   diagnostics go to stderr only.
 *
 * The connector key is the shared secret the user linked in chat. It is passed
 * via argv/env here for testing only — never logged, never echoed, and never
 * included in any output, including error messages.
 */

import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { writeSync } from 'node:fs';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : (process.env[name.replace(/^--/, '').toUpperCase()] || def);
}

class DriverError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Write one JSON line to stdout synchronously (so it is flushed even when
// stdout is redirected to a file) and exit with the given code.
function emitAndExit(obj, code) {
  try { writeSync(1, JSON.stringify(obj) + '\n'); } catch { /* stdout gone */ }
  process.exit(code);
}

function failNow(code, message, exitCode, extra) {
  emitAndExit({ ok: false, error: code, message, ...(extra || {}) }, exitCode || 1);
}

// Help is a successful invocation: valid JSON on stdout, exit 0, no key needed.
if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
  emitAndExit({
    ok: true,
    usage: [
      'node driver/driver.js --relay <ws-url> --key <connector-key> <command>',
      'commands: observe | act | abort | status',
      'act flags: --type click|type|key|scroll|navigate --target <label> --ref <ref> --value <text> --press-key <name> --url <url> --tier T0|T1|T2|T3',
      '--key is always the connector key; the keypress name goes in --press-key (e.g. --press-key Enter)',
    ],
  }, 0);
}

const RELAY = opt('--relay', 'ws://127.0.0.1:8787');
const KEY = opt('--key', '');
const CMD = args.find((a) => ['observe', 'act', 'abort', 'status'].includes(a));

// In-flight act proposals owned by this process. A one-shot CLI holds none at
// rest, so `status` reports 0; the counter exists so the field is real, not
// decorative, if this process is ever embedded.
let pendingProposals = 0;

// The four status fields, always present in `status` output — including its
// error paths, so a failed status check still reports peer/worker as "no"
// alongside the structured error instead of a bare error object.
function statusSnapshot(peer) {
  const p = peer ? 'yes' : 'no';
  return {
    peerConnected: p,
    workerAlive: p,
    pendingProposals,
    sessionTimeRemaining: null,
  };
}

if (!KEY) {
  failNow('KEY_MISSING', 'connector key is missing — pass --key <connector-key> or set the KEY environment variable', 2,
    CMD === 'status' ? statusSnapshot(false) : undefined);
}
if (KEY.length < 16) {
  failNow('KEY_INVALID', 'connector key is too short — it must be at least 16 characters', 2,
    CMD === 'status' ? statusSnapshot(false) : undefined);
}
if (!CMD) {
  failNow('USAGE', 'command required: observe | act | abort | status', 2);
}

function waitFor(ws, types, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new DriverError('PEER_TIMEOUT', `timed out waiting for the extension to respond (${types.join('/')})`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMsg);
      ws.off('close', onClose);
    }
    function onClose() {
      cleanup();
      reject(new DriverError('RELAY_UNREACHABLE', `relay connection closed while waiting for ${types.join('/')}`));
    }
    function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (types.includes(msg.type)) {
        cleanup();
        resolve(msg);
      } else if (['peer.joined', 'peer.left', 'peer.unavailable'].includes(msg.type)) {
        console.error(`[relay] ${msg.type}${msg.role ? ` (${msg.role})` : ''}`);
      }
    }
    ws.on('message', onMsg);
    ws.on('close', onClose);
  });
}

// The extension's service worker can be suspended by Chrome at any time and
// rejoins within ~30s via its keepalive alarm. If the relay reports
// peer.unavailable, the request was never forwarded — wait for the extension
// to rejoin (peer.joined) and resend, instead of timing out on a lost request.
function waitOutcome(ws, resultTypes, timeoutMs) {
  return new Promise((resolve) => {
    let unavailable = false;
    const timer = setTimeout(() => {
      cleanup();
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMsg);
      ws.off('close', onClose);
    }
    function onClose() {
      cleanup();
      resolve({ kind: 'error', error: new DriverError('RELAY_UNREACHABLE', 'relay connection closed while waiting for the extension') });
    }
    function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (resultTypes.includes(msg.type)) {
        cleanup();
        resolve({ kind: 'result', msg });
      } else if (msg.type === 'peer.unavailable') {
        unavailable = true;
        console.error('[relay] peer.unavailable — request never reached the extension; waiting for it to rejoin…');
      } else if (msg.type === 'peer.joined' && unavailable) {
        cleanup();
        resolve({ kind: 'resend' });
      } else if (['peer.joined', 'peer.left'].includes(msg.type)) {
        console.error(`[relay] ${msg.type}${msg.role ? ` (${msg.role})` : ''}`);
      }
    }
    ws.on('message', onMsg);
    ws.on('close', onClose);
  });
}

async function sendResilient(ws, msg, resultTypes, totalTimeoutMs) {
  const deadline = Date.now() + totalTimeoutMs;
  for (;;) {
    ws.send(JSON.stringify(msg));
    const outcome = await waitOutcome(ws, resultTypes, Math.max(1, deadline - Date.now()));
    if (outcome.kind === 'result') return outcome.msg;
    if (outcome.kind === 'error') throw outcome.error;
    if (outcome.kind === 'timeout') {
      throw new DriverError('PEER_TIMEOUT', `timed out waiting for the extension to respond (${resultTypes.join('/')}) — it did not rejoin in time`);
    }
    // 'resend': the extension is back — loop around and send again.
  }
}

async function pair(ws, timeoutMs) {
  ws.send(JSON.stringify({ v: 1, type: 'pair.request', role: 'driver', key: KEY }));
  const confirm = await waitFor(ws, ['pair.confirm'], timeoutMs || 10000);
  console.error(`[paired] peer connected: ${confirm.peer}`);
  if (!confirm.peer) console.error('[hint] the extension side is not connected yet — proposals will queue as peer.unavailable');
  return confirm;
}

async function connect(timeoutMs) {
  let parsed;
  try { parsed = new URL(RELAY); } catch {
    throw new DriverError('RELAY_UNREACHABLE', 'relay address is not a valid URL');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new DriverError('RELAY_UNREACHABLE', 'relay address must be a ws:// or wss:// URL');
  }
  // Route through the egress proxy when set (this VM intercepts direct TLS
  // to some hosts). The proxy does CONNECT tunneling, so the wss session
  // itself stays end-to-end encrypted. Never proxy loopback addresses.
  let wsOpts = {};
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  const proxy = !isLoopback && (process.env.HTTPS_PROXY || process.env.https_proxy);
  if (proxy) wsOpts = { agent: new HttpsProxyAgent(proxy) };
  const ws = new WebSocket(RELAY, wsOpts);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      reject(new DriverError('RELAY_UNREACHABLE', 'could not connect to the relay — connection timed out'));
    }, timeoutMs || 15000);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', () => {
      clearTimeout(timer);
      reject(new DriverError('RELAY_UNREACHABLE', 'could not connect to the relay — check that it is running and the address is correct'));
    });
  });
  // Mid-session socket errors surface through the waits' close handlers;
  // swallow the raw event so it can never crash the process silently.
  ws.on('error', () => {});
  return ws;
}

async function main() {
  const ws = await connect(CMD === 'status' ? 8000 : 15000);
  try {
    if (CMD === 'status') {
      const confirm = await pair(ws, 8000);
      // The extension's service worker holds its relay socket open while it
      // is alive, so "peer present at the relay" is the worker-alive signal
      // protocol v1 exposes. Session grants live inside the extension and
      // protocol v1 has no message to query their remaining time, so that
      // field is reported as null (unknown), never invented.
      console.log(JSON.stringify({
        ok: true,
        command: 'status',
        ...statusSnapshot(!!confirm.peer),
      }, null, 2));
      return;
    }

    await pair(ws);

    if (CMD === 'observe') {
      const res = await sendResilient(ws, { v: 1, type: 'observe.request', id: `obs-${Date.now()}` }, ['observe.result'], 30000);
      console.log(JSON.stringify(res, null, 2));
    } else if (CMD === 'act') {
      // Proposal shape matches the extension's handleProposal():
      // { actionTier, type, target:{ref,label}, value?, key?, site, description }
      // Get `ref` from a prior `observe` call's snapshot interactives.
      // The keypress name travels in --press-key -> proposal.key. --key is
      // the connector key and is never reused for this.
      const type = opt('--type', 'click');
      const pressKey = opt('--press-key', undefined);
      if (type === 'key' && !pressKey) {
        throw new DriverError('USAGE', '--press-key <name> is required for --type key (for example --press-key Enter)');
      }
      const proposal = {
        actionTier: opt('--tier', 'T1'),
        type,
        target: { ref: opt('--ref', null), label: opt('--target', '') },
        value: opt('--value', undefined),
        key: pressKey,
        url: opt('--url', undefined),
        site: opt('--site', ''),
        description: type === 'key' ? `press '${pressKey}'` : `${type} '${opt('--target', '')}'`,
      };
      const id = `act-${Date.now()}`;
      console.error('[sent] act.propose — waiting for user consent…');
      pendingProposals++;
      try {
        // Accept act.result during the consent wait too: a verdict may arrive
        // implicitly (auto-allow executes without a separate grant on old builds).
        const first = await sendResilient(ws, { v: 1, type: 'act.propose', id, proposal }, ['consent.grant', 'consent.deny', 'act.result'], 120000);
        if (first.type === 'act.result') {
          console.log(JSON.stringify(first, null, 2));
        } else {
          const consent = first;
          console.error(`[consent] ${consent.type}${consent.scope ? ` scope=${consent.scope}` : ''}`);
          if (consent.type === 'consent.grant') {
            const result = await waitFor(ws, ['act.result'], 60000);
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(JSON.stringify({ denied: true, consent }, null, 2));
          }
        }
      } finally {
        pendingProposals--;
      }
    } else if (CMD === 'abort') {
      ws.send(JSON.stringify({ v: 1, type: 'session.abort', reason: 'driver CLI abort' }));
      console.error('[sent] session.abort');
      console.log(JSON.stringify({ ok: true, command: 'abort', type: 'session.abort', sent: true }, null, 2));
    }
  } finally {
    ws.close();
  }
}

main().catch((e) => {
  const code = e && e.code ? e.code : 'INTERNAL';
  const message = e && e.message ? e.message : 'unexpected driver error';
  failNow(code, message, 1, CMD === 'status' ? statusSnapshot(false) : undefined);
});
