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
 *   node driver/driver.js --relay <url> --key <key> abort
 *
 * The connector key is the shared secret the user linked in chat. It is passed
 * via argv/env here for testing only — never logged.
 */

import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : (process.env[name.replace(/^--/, '').toUpperCase()] || def);
}

const RELAY = opt('--relay', 'ws://127.0.0.1:8787');
const KEY = opt('--key', '');
const CMD = args.find((a) => ['observe', 'act', 'abort'].includes(a));

if (!KEY || KEY.length < 16) {
  console.error('error: --key <connector-key> (min 16 chars) is required');
  process.exit(2);
}
if (!CMD) {
  console.error('error: command required: observe | act | abort');
  process.exit(2);
}

function waitFor(ws, types, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting for ${types.join('/')}`));
    }, timeoutMs);
    function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (types.includes(msg.type)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msg);
      } else if (['peer.joined', 'peer.left', 'peer.unavailable'].includes(msg.type)) {
        console.error(`[relay] ${msg.type}${msg.role ? ` (${msg.role})` : ''}`);
      }
    }
    ws.on('message', onMsg);
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
      ws.off('message', onMsg);
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (resultTypes.includes(msg.type)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve({ kind: 'result', msg });
      } else if (msg.type === 'peer.unavailable') {
        unavailable = true;
        console.error('[relay] peer.unavailable — request never reached the extension; waiting for it to rejoin…');
      } else if (msg.type === 'peer.joined' && unavailable) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve({ kind: 'resend' });
      } else if (['peer.joined', 'peer.left'].includes(msg.type)) {
        console.error(`[relay] ${msg.type}${msg.role ? ` (${msg.role})` : ''}`);
      }
    }
    ws.on('message', onMsg);
  });
}

async function sendResilient(ws, msg, resultTypes, totalTimeoutMs) {
  const deadline = Date.now() + totalTimeoutMs;
  for (;;) {
    ws.send(JSON.stringify(msg));
    const outcome = await waitOutcome(ws, resultTypes, Math.max(1, deadline - Date.now()));
    if (outcome.kind === 'result') return outcome.msg;
    if (outcome.kind === 'timeout') {
      throw new Error(`timeout waiting for ${resultTypes.join('/')} (extension did not rejoin in time)`);
    }
    // 'resend': the extension is back — loop around and send again.
  }
}

async function pair(ws) {
  ws.send(JSON.stringify({ v: 1, type: 'pair.request', role: 'driver', key: KEY }));
  const confirm = await waitFor(ws, ['pair.confirm'], 10000);
  console.error(`[paired] peer connected: ${confirm.peer}`);
  if (!confirm.peer) console.error('[hint] the extension side is not connected yet — proposals will queue as peer.unavailable');
}

async function main() {
  // Route through the egress proxy when set (this VM intercepts direct TLS
  // to some hosts). The proxy does CONNECT tunneling, so the wss session
  // itself stays end-to-end encrypted. Never proxy loopback addresses.
  let wsOpts = {};
  try {
    const host = new URL(RELAY).hostname;
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(host);
    const proxy = !isLoopback && (process.env.HTTPS_PROXY || process.env.https_proxy);
    if (proxy) wsOpts = { agent: new HttpsProxyAgent(proxy) };
  } catch { /* keep direct */ }
  const ws = new WebSocket(RELAY, wsOpts);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await pair(ws);

  if (CMD === 'observe') {
    const res = await sendResilient(ws, { v: 1, type: 'observe.request', id: `obs-${Date.now()}` }, ['observe.result'], 30000);
    console.log(JSON.stringify(res, null, 2));
  } else if (CMD === 'act') {
    // Proposal shape matches the extension's handleProposal():
    // { actionTier, type, target:{ref,label}, value?, site, description }
    // Get `ref` from a prior `observe` call's snapshot interactives.
    const proposal = {
      actionTier: opt('--tier', 'T1'),
      type: opt('--type', 'click'),
      target: { ref: opt('--ref', null), label: opt('--target', '') },
      value: opt('--value', undefined),
      url: opt('--url', undefined),
      site: opt('--site', ''),
      description: `${opt('--type', 'click')} '${opt('--target', '')}'`,
    };
    const id = `act-${Date.now()}`;
    console.error('[sent] act.propose — waiting for user consent…');
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
  } else if (CMD === 'abort') {
    ws.send(JSON.stringify({ v: 1, type: 'session.abort', reason: 'driver CLI abort' }));
    console.error('[sent] session.abort');
  }

  ws.close();
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
