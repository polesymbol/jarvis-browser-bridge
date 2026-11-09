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
 * Consent lifecycle for act (protocol acknowledgements):
 *   act.propose -> proposal.received -> consent.shown -> consent.waiting*
 *   -> consent.grant | consent.deny -> act.result.
 *   Each state is reported distinctly instead of one opaque timeout:
 *   PEER_DOWN (extension never acknowledged the proposal),
 *   PROMPT_NOT_SHOWN (received, but no prompt became visible),
 *   NO_ANSWER (shown but unanswered — the proposal stays queued in the
 *   panel, never deny-and-forget), DENIED (the verdict was deny), and
 *   APPLIED_UNCONFIRMED (granted, but the result never arrived — the act
 *   is NEVER resent from that point; observe before retrying). Phase
 *   timeouts default to receipt 30s / shown 20s / consent 120s / result
 *   60s; JBB_ACT_RECEIPT_MS, JBB_ACT_SHOWN_MS, JBB_ACT_CONSENT_MS and
 *   JBB_ACT_RESULT_MS override them (the test suite uses small values).
 *   KEY_ROTATED is reported when the extension has rotated its connector
 *   key ("key rotated — pair again") — at pairing time via pair.error, or
 *   live via a key.rotated notice. It is distinct from a wrong key, which
 *   simply finds no peer.
 *
 * The connector key is the shared secret the user linked in chat. It is passed
 * via argv/env here for testing only — never logged, never echoed, and never
 * included in any output, including error messages.
 */

import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { writeSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// Label normalization — byte-equivalent to JBB.normalizeLabel in
// extension/protocol.js (and the content script's copy): zero-width
// characters stripped, non-breaking spaces become plain spaces. Applied
// to --target so matching is exact-after-normalization on both sides.
function normalizeLabel(s) {
  return String(s == null ? '' : s)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
      'commands: observe | act | abort | status | watch',
      'observe flags: --text-offset <n> (page through snapshot text: the result carries text_offset/text_total_chars/text_next_offset)',
      'watch flags: --duration <seconds> (stream media.progress events as JSON lines; 0 = until Ctrl-C)',
      'act flags: --type click|type|key|scroll|navigate|clickAt|clickSelector|hover|select|setValue|drag|listTabs|switchTab|closeTab|closeInactiveTabs|openTab|pinTab|fetch|waitFor|media|captions|frameGrab --target <label> --ref <ref> --value <text> --press-key <name> --url <url> --tier T0|T1|T2|T3 --snapshot-version <n> --x <n> --y <n> --selector <css> --option-text <text> --to-target <label> --from-x <n> --from-y <n> --to-x <n> --to-y <n> --tab-id <n> --method <verb> --body <text> --content-type <mime> --wait element|text|navigation|networkIdle|mediaEnded --wait-text <text> --timeout <ms> --media play|pause|seek --seek-to <s> --from <s> --to <s> --language <code> --track-index <n> --at <s> --out <file>',
      '--key is always the connector key; the keypress name goes in --press-key (e.g. --press-key Enter)',
    ],
  }, 0);
}

const RELAY = opt('--relay', 'ws://127.0.0.1:8787');
const KEY = opt('--key', '');
const CMD = args.find((a) => ['observe', 'act', 'abort', 'status', 'watch'].includes(a));

// In-flight act proposals owned by this process. A one-shot CLI holds none at
// rest, so `status` reports 0; the counter exists so the field is real, not
// decorative, if this process is ever embedded.
let pendingProposals = 0;

const ACT_RECEIPT_MS = parseInt(process.env.JBB_ACT_RECEIPT_MS || '30000', 10);
const ACT_SHOWN_MS = parseInt(process.env.JBB_ACT_SHOWN_MS || '20000', 10);
const ACT_CONSENT_MS = parseInt(process.env.JBB_ACT_CONSENT_MS || '120000', 10);
const ACT_RESULT_MS = parseInt(process.env.JBB_ACT_RESULT_MS || '60000', 10);

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
      if (msg.type === 'key.rotated') {
        cleanup();
        reject(new DriverError('KEY_ROTATED', 'key rotated — pair again'));
        return;
      }
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
      if (msg.type === 'key.rotated') {
        cleanup();
        resolve({ kind: 'error', error: new DriverError('KEY_ROTATED', 'key rotated — pair again') });
      } else if (resultTypes.includes(msg.type)) {
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
  const confirm = await waitFor(ws, ['pair.confirm', 'pair.error'], timeoutMs || 10000);
  if (confirm.type === 'pair.error') {
    // The relay refuses a rotated key explicitly — never let that degrade
    // into a timeout or a lonely-room guess.
    throw new DriverError(confirm.error || 'KEY_ROTATED', confirm.message || 'key rotated — pair again');
  }
  console.error(`[paired] peer connected: ${confirm.peer}`);
  if (!confirm.peer) console.error('[hint] the extension side is not connected yet — proposals will queue as peer.unavailable');
  return confirm;
}

// ---------------------------------------------------------------- act lifecycle
// A small message pump: every relay message for this act is buffered or
// handed to the phase waiting for it, correlated by the act's unique id
// (carried as proposalId by the extension, as id by older peers).
function createPump(ws, actId) {
  const buffer = [];
  const waiters = [];
  const pump = { peerUnavailable: false, fatal: null };
  function idOk(m) {
    if (m.proposalId) return m.proposalId === actId;
    if (m.id) return m.id === actId;
    return true;
  }
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'key.rotated') {
      // Fatal for this act: the key died mid-flight. Fail every phase with
      // KEY_ROTATED, never a phase timeout.
      pump.fatal = new DriverError('KEY_ROTATED', 'key rotated — pair again');
      waiters.splice(0).forEach((w) => { clearTimeout(w.timer); w.reject(pump.fatal); });
      return;
    }
    if (m.type === 'peer.unavailable') {
      pump.peerUnavailable = true;
      console.error('[relay] peer.unavailable — the extension is not connected');
    } else if (m.type === 'peer.left') {
      console.error('[relay] peer.left — the extension disconnected');
    }
    if (!idOk(m) && m.type !== 'peer.joined') { buffer.push(m); return; }
    const i = waiters.findIndex((w) => w.types.includes(m.type));
    if (i !== -1) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
    } else {
      buffer.push(m);
    }
  });
  pump.next = (types, timeoutMs) => {
    if (pump.fatal) return Promise.reject(pump.fatal);
    const bi = buffer.findIndex((m) => types.includes(m.type) && (m.type === 'peer.joined' || idOk(m)));
    if (bi !== -1) return Promise.resolve(buffer.splice(bi, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { types, resolve, reject };
      w.timer = setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j !== -1) waiters.splice(j, 1);
        const e = new Error('pump timeout');
        e.pumpTimeout = true;
        reject(e);
      }, Math.max(1, timeoutMs));
      waiters.push(w);
    });
  };
  return pump;
}

function denyError(msg) {
  return new DriverError('DENIED', msg && msg.reason ? `the action was denied — ${msg.reason}` : 'the user denied this action');
}

// An act.result ends the act. A STALE_SNAPSHOT refusal gets the crisp
// machine-readable surface (non-zero exit, current version included) —
// every other result prints verbatim, as before.
// ---------------------------------------------------------- player memory
// Per-player failure memory: a player that fails to start twice is
// recorded NOT VERIFIED and the driver refuses to burn more waits on
// it. A verified play clears the record. Stored on this machine only
// (JBB_PLAYER_MEMORY overrides the path, e.g. for tests).
const PLAYER_MEMORY_PATH = process.env.JBB_PLAYER_MEMORY
  || path.join(os.homedir(), '.jbb-player-memory.json');

function playerGateKey(proposal) {
  const label = (proposal.target && proposal.target.label) || '';
  return `${proposal.site || ''}|${label}`;
}
function loadPlayerMemory() {
  try { return JSON.parse(readFileSync(PLAYER_MEMORY_PATH, 'utf8')); } catch { return {}; }
}
function savePlayerMemory(mem) {
  try {
    mkdirSync(path.dirname(PLAYER_MEMORY_PATH), { recursive: true });
    writeFileSync(PLAYER_MEMORY_PATH, JSON.stringify(mem, null, 2));
  } catch { /* memory is best-effort; a read-only disk must not break acts */ }
}
function mediaGate(proposal) {
  if (proposal.type !== 'media' || !proposal.media || proposal.media.action !== 'play') return;
  const mem = loadPlayerMemory();
  const entry = mem[playerGateKey(proposal)];
  if (entry && entry.fails >= 2 && !entry.verified) {
    emitAndExit({
      ok: false,
      error: 'NOT_VERIFIED',
      message: `this player failed to start ${entry.fails} times (last reason: ${entry.lastReason || 'unknown'}) and is recorded NOT VERIFIED — not retrying`,
      player: playerGateKey(proposal),
      attempts: entry.fails,
      lastReason: entry.lastReason || null,
    }, 1);
  }
}
function mediaRecord(proposal, msg) {
  if (proposal.type !== 'media' || !proposal.media || proposal.media.action !== 'play' || !msg) return;
  const key = playerGateKey(proposal);
  const mem = loadPlayerMemory();
  const d = msg.data || {};
  if (msg.ok && d.verified) {
    if (mem[key]) { delete mem[key]; savePlayerMemory(mem); }
    return;
  }
  const entry = mem[key] || { fails: 0 };
  entry.fails = (entry.fails || 0) + 1;
  entry.verified = false;
  entry.lastReason = d.reason || (msg.ok ? 'did-not-start' : (msg.error || 'act failed'));
  entry.playerKey = d.playerKey || entry.playerKey || null;
  entry.at = new Date().toISOString();
  mem[key] = entry;
  savePlayerMemory(mem);
  if (entry.fails >= 2) {
    console.error(`[player-memory] ${key} recorded NOT VERIFIED after ${entry.fails} failed attempts (${entry.lastReason})`);
  } else {
    console.error(`[player-memory] ${key} failed attempt ${entry.fails}/2 (${entry.lastReason})`);
  }
}

function finishResult(msg) {
  if (msg && msg.error === 'STALE_SNAPSHOT') {
    emitAndExit({
      ok: false,
      error: 'STALE_SNAPSHOT',
      message: msg.detail || 'the snapshot moved since this act was built — re-observe and rebuild the act',
      snapshotVersion: typeof msg.snapshotVersion === 'number' ? msg.snapshotVersion : null,
    }, 1);
  }
  console.log(JSON.stringify(msg, null, 2));
}

// runAct's exit door: record media outcomes in the player memory and
// write frame grabs to --out before the result is printed.
function finishActResult(proposal, msg) {
  mediaRecord(proposal, msg);
  if (proposal.type === 'frameGrab' && msg && msg.ok && msg.data && msg.data.dataUrl) {
    const out = opt('--out', undefined);
    if (out) {
      try {
        const b64 = String(msg.data.dataUrl).split(',')[1] || '';
        const buf = Buffer.from(b64, 'base64');
        writeFileSync(out, buf);
        msg.data = { ...msg.data, savedTo: out, bytes: buf.length };
        delete msg.data.dataUrl;
        console.error(`[frame] wrote ${buf.length} bytes to ${out}`);
      } catch (e) {
        console.error('[frame] could not write --out file: ' + e.message);
      }
    }
  }
  finishResult(msg);
}

// Run one act through its lifecycle phases. The proposal is (re)sent ONLY
// in the receipt phase, when the extension has not yet acknowledged it —
// peer.unavailable means the relay never forwarded it, and a rejoin resend
// carries the same id, which the extension dedupes. After a grant the act
// is never resent under any circumstances.
async function runAct(ws, proposal, id) {
  const pump = createPump(ws, id);
  const finish = (msg) => finishActResult(proposal, msg);
  const sendPropose = () => ws.send(JSON.stringify({ v: 1, type: 'act.propose', id, proposal }));
  const isTimeout = (e) => e && e.pumpTimeout;
  pendingProposals++;
  try {
    sendPropose();

    // Phase A — receipt: did the extension take the proposal in at all?
    let early = null;
    const receiptDeadline = Date.now() + ACT_RECEIPT_MS;
    for (;;) {
      let got;
      try {
        got = await pump.next(['proposal.received', 'consent.grant', 'consent.deny', 'act.result', 'peer.joined'], receiptDeadline - Date.now());
      } catch (e) {
        if (isTimeout(e)) {
          throw new DriverError('PEER_DOWN', pump.peerUnavailable
            ? 'the extension is offline — it never acknowledged the proposal'
            : 'the extension did not acknowledge the proposal in time — it appears to be offline');
        }
        throw e;
      }
      if (got.type === 'peer.joined') {
        console.error('[relay] extension rejoined — resending the proposal (same id; the extension dedupes by id)');
        sendPropose();
        continue;
      }
      if (got.type === 'proposal.received') break;
      early = got; break; // an older extension that answers without acks
    }

    let verdict = null;
    if (early) {
      if (early.type === 'act.result') { finish(early); return; }
      if (early.type === 'consent.deny') throw denyError(early);
      verdict = early; // consent.grant
    }

    // Phase B — shown: a prompt must actually become visible.
    if (!verdict) {
      const shownDeadline = Date.now() + ACT_SHOWN_MS;
      for (;;) {
        let got;
        try {
          got = await pump.next(['consent.shown', 'consent.waiting', 'consent.grant', 'consent.deny', 'act.result'], shownDeadline - Date.now());
        } catch (e) {
          if (isTimeout(e)) {
            throw new DriverError('PROMPT_NOT_SHOWN', 'the extension received the proposal but the consent prompt never appeared — no panel card or in-page banner became visible');
          }
          throw e;
        }
        if (got.type === 'consent.shown' || got.type === 'consent.waiting') break;
        if (got.type === 'act.result') { finish(got); return; }
        if (got.type === 'consent.deny') throw denyError(got);
        verdict = got; break; // consent.grant (auto-allow: no prompt needed)
      }
    }

    // Phase C — verdict: heartbeats report the waiting state; a timeout
    // here is NO_ANSWER, and the proposal stays queued in the panel.
    if (!verdict) {
      const consentDeadline = Date.now() + ACT_CONSENT_MS;
      for (;;) {
        let got;
        try {
          got = await pump.next(['consent.grant', 'consent.deny', 'act.result', 'consent.waiting'], consentDeadline - Date.now());
        } catch (e) {
          if (isTimeout(e)) {
            throw new DriverError('NO_ANSWER', 'the consent prompt was shown but not answered in time — the proposal is still queued in the extension panel, not denied or forgotten');
          }
          throw e;
        }
        if (got.type === 'consent.waiting') {
          console.error(`[waiting] consent prompt open, unanswered for ${Math.round((got.waitedMs || 0) / 1000)}s — waiting for the user`);
          continue;
        }
        if (got.type === 'act.result') { finish(got); return; }
        if (got.type === 'consent.deny') throw denyError(got);
        verdict = got; break; // consent.grant
      }
    }

    console.error(`[consent] consent.grant${verdict.scope ? ` scope=${verdict.scope}` : ''}`);

    // Phase D — applied/failed: the act.result. A timeout here means the
    // result was lost, NOT that the action failed — report
    // APPLIED_UNCONFIRMED and never, ever resend the act.
    let result;
    try {
      // Long-running acts (waitFor with a declared timeout) get a result
      // budget that covers the wait plus slack — the phase timeout must
      // never fire before the act's own bounded timeout does.
      const resultBudget = Math.max(ACT_RESULT_MS, (proposal.timeoutMs || 0) + 20000);
      result = await pump.next(['act.result'], resultBudget);
    } catch (e) {
      if (isTimeout(e)) {
        emitAndExit({ ok: false, error: 'APPLIED_UNCONFIRMED', message: 'the action may already have applied — observe before retrying' }, 1);
      }
      throw e;
    }
    finish(result);
  } finally {
    pendingProposals--;
  }
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

    if (CMD === 'watch') {
      // Stream live media progress (the extension pushes media.progress
      // while media plays) as JSON lines — no polling observes.
      const durS = Number(opt('--duration', '0'));
      console.error('[watch] streaming media progress events' + (durS > 0 ? ` for ${durS}s` : ' (Ctrl-C to stop)'));
      await new Promise((resolve) => {
        const onMsg = (raw) => {
          let m;
          try { m = JSON.parse(String(raw)); } catch { return; }
          if (m && m.type === 'media.progress') console.log(JSON.stringify(m));
        };
        ws.on('message', onMsg);
        const done = () => { ws.off('message', onMsg); resolve(); };
        if (durS > 0) setTimeout(done, durS * 1000);
        process.once('SIGINT', done);
      });
      console.log(JSON.stringify({ ok: true, command: 'watch', done: true }, null, 2));
      return;
    }

    if (CMD === 'observe') {
      const req = { v: 1, type: 'observe.request', id: `obs-${Date.now()}` };
      const offRaw = opt('--text-offset', undefined);
      if (offRaw !== undefined) {
        const off = Number(offRaw);
        if (!Number.isFinite(off) || off < 0) {
          throw new DriverError('USAGE', '--text-offset must be a non-negative number (take text_next_offset from the previous observe)');
        }
        req.textOffset = off;
      }
      const res = await sendResilient(ws, req, ['observe.result'], 30000);
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
      const targetLabel = normalizeLabel(opt('--target', ''));
      // Tab actions are T2 by default (they reshape the user's window);
      // everything else keeps the T1 default. --tier overrides either.
      const TAB_TYPES = ['listTabs', 'switchTab', 'closeTab', 'closeInactiveTabs', 'openTab', 'pinTab'];
      const isTabType = TAB_TYPES.includes(type);
      const proposal = {
        actionTier: opt('--tier', isTabType || type === 'fetch' || type === 'media' || type === 'frameGrab' ? 'T2' : 'T1'),
        type,
        target: { ref: opt('--ref', null), label: targetLabel },
        value: opt('--value', undefined),
        key: pressKey,
        url: opt('--url', undefined),
        site: opt('--site', ''),
        description: type === 'key' ? `press '${pressKey}'` : `${type} '${targetLabel}'`,
      };
      // Snapshot versioning: declare the observe version this act was
      // built against (printed by `observe`). The extension refuses with
      // STALE_SNAPSHOT if the version has moved — never a wrong-element
      // click. Omit the flag and the act proceeds on stable-id + label
      // verification alone (older flow).
      const svRaw = opt('--snapshot-version', undefined);
      if (svRaw !== undefined) {
        const sv = Number(svRaw);
        if (!Number.isFinite(sv) || sv < 0) {
          throw new DriverError('USAGE', '--snapshot-version must be a non-negative number (take it from the observe output)');
        }
        proposal.snapshotVersion = sv;
      }
      // Fallback targeting: clickAt (viewport coordinates, e.g. read off
      // a screenshot) and clickSelector (a CSS selector). Both pass the
      // same consent gate as every act; the result names what was clicked.
      if (type === 'clickAt') {
        const x = Number(opt('--x', undefined));
        const y = Number(opt('--y', undefined));
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new DriverError('USAGE', '--type clickAt requires numeric --x and --y (viewport coordinates)');
        }
        proposal.point = { x, y };
        proposal.description = `click at (${x}, ${y})`;
      } else if (type === 'clickSelector') {
        const selector = opt('--selector', undefined);
        if (!selector) {
          throw new DriverError('USAGE', '--type clickSelector requires --selector <css>');
        }
        proposal.selector = selector;
        proposal.description = `click selector '${selector}'`;
      } else if (type === 'hover') {
        if (!targetLabel && !proposal.target.ref) {
          throw new DriverError('USAGE', '--type hover requires --target <label> (or --ref)');
        }
        proposal.description = `hover over '${targetLabel}'`;
      } else if (type === 'select') {
        // Dropdown selection by option value (--value) or visible text
        // (--option-text). The consent card names the option, not just
        // the field.
        const optionText = opt('--option-text', undefined);
        if (proposal.value === undefined && optionText === undefined) {
          throw new DriverError('USAGE', '--type select requires --value <option value> or --option-text <visible text>');
        }
        if (proposal.value !== undefined) proposal.optionValue = proposal.value;
        if (optionText !== undefined) proposal.optionText = optionText;
        proposal.description = `select '${optionText !== undefined ? optionText : proposal.value}' in '${targetLabel}'`;
      } else if (type === 'setValue') {
        if (proposal.value === undefined) {
          throw new DriverError('USAGE', '--type setValue requires --value <text>');
        }
        // The value itself never appears in the consent description (or
        // the audit trail) — the field and the fact are enough.
        proposal.description = `set the value of '${targetLabel}'`;
      } else if (type === 'drag') {
        // From: --target/--ref (element) or --from-x/--from-y (point).
        // To: --to-target (element label) or --to-x/--to-y (point).
        const fx = Number(opt('--from-x', undefined));
        const fy = Number(opt('--from-y', undefined));
        const tx = Number(opt('--to-x', undefined));
        const ty = Number(opt('--to-y', undefined));
        const toLabel = normalizeLabel(opt('--to-target', ''));
        if (Number.isFinite(fx) && Number.isFinite(fy)) {
          proposal.dragFrom = { point: { x: fx, y: fy } };
        } else if (targetLabel || proposal.target.ref) {
          proposal.dragFrom = { ref: proposal.target.ref, label: targetLabel };
        } else {
          throw new DriverError('USAGE', '--type drag requires a source: --target <label> or --from-x/--from-y');
        }
        if (Number.isFinite(tx) && Number.isFinite(ty)) {
          proposal.dragTo = { point: { x: tx, y: ty } };
        } else if (toLabel) {
          proposal.dragTo = { label: toLabel };
        } else {
          throw new DriverError('USAGE', '--type drag requires a destination: --to-target <label> or --to-x/--to-y');
        }
        const fromName = proposal.dragFrom.point ? `(${fx}, ${fy})` : `'${targetLabel}'`;
        const toName = proposal.dragTo.point ? `(${tx}, ${ty})` : `'${toLabel}'`;
        proposal.description = `drag ${fromName} to ${toName}`;
      } else if (isTabType) {
        // Tab actions: ids come from a prior listTabs act (its result
        // carries data.tabs). The extension resolves each tab's real
        // site before the consent gate — the whitelist keys off truth,
        // not the driver's claim.
        const tabIdRaw = opt('--tab-id', undefined);
        if (tabIdRaw !== undefined) {
          const n = Number(tabIdRaw);
          if (!Number.isFinite(n)) {
            throw new DriverError('USAGE', '--tab-id must be a number (take it from a listTabs result)');
          }
          proposal.tabId = n;
        }
        if (type === 'listTabs') {
          proposal.description = 'list open tabs';
        } else if (type === 'closeInactiveTabs') {
          proposal.description = 'close inactive tabs (keeps active, pinned, and playing audio)';
        } else if (type === 'openTab') {
          if (!proposal.url) {
            throw new DriverError('USAGE', '--type openTab requires --url <url>');
          }
          proposal.description = `open ${proposal.url} in a new tab`;
        } else {
          if (proposal.tabId === undefined) {
            throw new DriverError('USAGE', `--type ${type} requires --tab-id <n> (take it from a listTabs result)`);
          }
          const verb = type === 'switchTab' ? 'switch to' : type === 'closeTab' ? 'close' : 'pin';
          proposal.description = `${verb} tab ${proposal.tabId}`;
        }
      } else if (type === 'fetch') {
        // In-page fetch: runs in the page's context (its session). The
        // extension enforces HTTPS-only and never sends credentials
        // cross-origin; the description names exactly what will be hit.
        if (!proposal.url) {
          throw new DriverError('USAGE', '--type fetch requires --url <https url>');
        }
        const method = (opt('--method', 'GET') || 'GET').toUpperCase();
        proposal.method = method;
        const body = opt('--body', undefined);
        if (body !== undefined) proposal.body = body;
        const ct = opt('--content-type', undefined);
        if (ct !== undefined) proposal.contentType = ct;
        proposal.description = `fetch ${method} ${proposal.url} in this page`;
      } else if (type === 'waitFor') {
        const kind = opt('--wait', undefined);
        const KINDS = ['element', 'text', 'navigation', 'networkIdle', 'mediaEnded'];
        if (!KINDS.includes(kind)) {
          throw new DriverError('USAGE', '--type waitFor requires --wait element|text|navigation|networkIdle|mediaEnded');
        }
        const w = { kind };
        const sel = opt('--selector', undefined);
        if (sel !== undefined) w.selector = sel;
        const wt = opt('--wait-text', undefined);
        if (wt !== undefined) w.text = wt;
        if (targetLabel) w.label = targetLabel;
        if (kind === 'text' && !w.text) {
          throw new DriverError('USAGE', '--wait text requires --wait-text <text>');
        }
        if (kind === 'element' && !w.selector && !w.label && !w.text) {
          throw new DriverError('USAGE', '--wait element requires --selector, --target, or --wait-text (a label)');
        }
        proposal.wait = w;
        const tmo = Number(opt('--timeout', '30000'));
        if (!Number.isFinite(tmo) || tmo < 250 || tmo > 120000) {
          throw new DriverError('USAGE', '--timeout must be between 250 and 120000 ms');
        }
        proposal.timeoutMs = tmo;
        proposal.description = `wait for ${kind}${w.text ? ` '${w.text}'` : w.selector ? ` '${w.selector}'` : w.label ? ` '${w.label}'` : ''} (up to ${Math.round(tmo / 1000)}s)`;
      } else if (type === 'media') {
        const action = opt('--media', undefined);
        if (!['play', 'pause', 'seek'].includes(action)) {
          throw new DriverError('USAGE', '--type media requires --media play|pause|seek');
        }
        proposal.media = { action };
        if (action === 'seek') {
          const to = Number(opt('--seek-to', ''));
          if (!Number.isFinite(to)) {
            throw new DriverError('USAGE', '--media seek requires --seek-to <seconds>');
          }
          proposal.media.seekTo = to;
        }
        proposal.description = action === 'seek'
          ? `seek media to ${proposal.media.seekTo}s`
          : `${action} media${targetLabel ? ` '${targetLabel}'` : ''}`;
        // The NOT VERIFIED gate: two verified failures on this player
        // and the driver refuses locally — no proposal is even sent.
        mediaGate(proposal);
      } else if (type === 'captions') {
        const from = opt('--from', undefined);
        const toS = opt('--to', undefined);
        if (from !== undefined) {
          const f = Number(from);
          if (!Number.isFinite(f) || f < 0) throw new DriverError('USAGE', '--from must be a non-negative number of seconds');
          proposal.from = f;
        }
        if (toS !== undefined) {
          const t2 = Number(toS);
          if (!Number.isFinite(t2) || t2 < 0) throw new DriverError('USAGE', '--to must be a non-negative number of seconds');
          proposal.to = t2;
        }
        const lang = opt('--language', undefined);
        if (lang !== undefined) proposal.language = lang;
        const ti = opt('--track-index', undefined);
        if (ti !== undefined) proposal.trackIndex = Number(ti);
        proposal.description = `read captions ${proposal.from || 0}s–${proposal.to != null ? proposal.to + 's' : 'end'}${lang ? ` [${lang}]` : ''}`;
      } else if (type === 'frameGrab') {
        const at = opt('--at', undefined);
        if (at !== undefined) {
          const a2 = Number(at);
          if (!Number.isFinite(a2) || a2 < 0) throw new DriverError('USAGE', '--at must be a non-negative number of seconds');
          proposal.at = a2;
        }
        proposal.description = `grab a frame of the video${at !== undefined ? ` at ${at}s` : ''}`;
      }
      const id = `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.error('[sent] act.propose — following the consent lifecycle…');
      await runAct(ws, proposal, id);
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
