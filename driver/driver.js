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
 *   KEY_ROTATED is reported when the extension has retired its connector
 *   key — rotated by the user, or expired (lifetime elapsed / big-task
 *   budget reached; the relay poisons both the same way, so the driver
 *   cannot and need not tell them apart) — at pairing time via pair.error,
 *   or live via a key.rotated notice. It is distinct from a wrong key,
 *   which simply finds no peer.
 *
 * The connector key is the shared secret the user linked in chat. It is passed
 * via argv/env here for testing only — never logged, never echoed, and never
 * included in any output, including error messages.
 */

import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { writeSync, readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
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
      'commands: observe | act | abort | status | watch | listen | plan | cancel',
      'plan: --file <steps.json> (ordered steps, max 20; user approves once; T3 steps still ask)',
      'cancel: --proposal-id <id> (withdraw a queued proposal before a decision — it will never apply, unlike NO_ANSWER)',
      'listen flags: --duration <seconds> --out <file.webm> (proposes audio capture — T2 — then writes the streamed Opus/WebM chunks to the file)',
      'observe flags: --text-offset <n> (page through snapshot text: the result carries text_offset/text_total_chars/text_next_offset) --interactive-offset <n> --interactive-limit <n> (page through snapshot interactives: the result carries interactive_offset/interactive_total/interactive_next_offset)',
      'watch flags: --duration <seconds> (stream media.progress events as JSON lines; 0 = until Ctrl-C)',
      'act flags: --type click|type|key|scroll|navigate|clickAt|clickSelector|hover|select|setValue|drag|listTabs|switchTab|closeTab|closeInactiveTabs|openTab|pinTab|fetch|waitFor|media|captions|frameGrab|audioCapture --target <label> --ref <ref> --value <text> --press-key <name> --url <url> --tier T0|T1|T2|T3 --snapshot-version <n> --x <n> --y <n> --selector <css> --option-text <text> --to-target <label> --from-x <n> --from-y <n> --to-x <n> --to-y <n> --tab-id <n> --method <verb> --body <text> --content-type <mime> --header "Name: Value" (repeatable, fetch, same-origin only) --wait element|text|navigation|networkIdle|mediaEnded --wait-text <text> --timeout <ms> --media play|pause|seek --seek-to <s> --from <s> --to <s> --language <code> --track-index <n> --at <s> --out <file> --direction up|down|top|bottom --amount <px>',
      '--key is always the connector key; the keypress name goes in --press-key (e.g. --press-key Enter)',
    ],
  }, 0);
}

const RELAY = opt('--relay', 'ws://127.0.0.1:8787');
const KEY = opt('--key', '');
const CMD = args.find((a) => ['observe', 'act', 'abort', 'status', 'watch', 'listen', 'plan', 'cancel'].includes(a));

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
  failNow('USAGE', 'command required: observe | act | abort | status | watch | listen | plan | cancel', 2);
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
        reject(new DriverError('KEY_ROTATED', 'key rotated or expired — pair again with a fresh key'));
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
        resolve({ kind: 'error', error: new DriverError('KEY_ROTATED', 'key rotated or expired — pair again with a fresh key') });
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
    // The relay refuses a retired key explicitly — never let that degrade
    // into a timeout or a lonely-room guess. Rotation and expiry poison
    // the room identically, so the wording covers both.
    const retired = (confirm.error || 'KEY_ROTATED') === 'KEY_ROTATED';
    throw new DriverError(confirm.error || 'KEY_ROTATED',
      retired ? 'key rotated or expired — pair again with a fresh key'
              : (confirm.message || 'pairing refused'));
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
      pump.fatal = new DriverError('KEY_ROTATED', 'key rotated or expired — pair again with a fresh key');
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
  // Never print a bare ok:false (Fix 8): a result that failed without a
  // reported reason gets one, so the agent can act on it instead of
  // guessing whether anything happened.
  if (msg && msg.ok === false && !msg.detail && !msg.error) {
    msg = { ...msg, error: 'act failed with no reported reason — the result may have been lost in transit; observe before retrying' };
  }
  console.log(JSON.stringify(msg, null, 2));
}

let lastActResult = null;
let suppressActPrint = false; // listen: the start result is plumbing, not output

// runAct's exit door: record media outcomes in the player memory and
// write frame grabs to --out before the result is printed.
function finishActResult(proposal, msg) {
  lastActResult = msg;
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
  if (suppressActPrint) {
    console.error(`[act] ${msg.ok ? 'ok' : 'failed'} — ${msg.detail || ''}`);
  } else {
    finishResult(msg);
  }
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
        got = await pump.next(['proposal.received', 'consent.grant', 'consent.deny', 'act.result', 'peer.joined', 'proposal.cancelled'], receiptDeadline - Date.now());
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
      if (got.type === 'proposal.cancelled') {
        throw new DriverError('CANCELLED', got.detail || 'the proposal was cancelled — it will not apply');
      }
      if (got.type === 'proposal.received') break;
      early = got; break; // an older extension that answers without acks
    }

    let verdict = null;
    if (early) {
      if (early.type === 'act.result') { finish(early); return; }
      if (early.type === 'consent.deny') throw denyError(early);
      if (early.type === 'proposal.cancelled') {
        throw new DriverError('CANCELLED', early.detail || 'the proposal was cancelled — it will not apply');
      }
      verdict = early; // consent.grant
    }

    // Phase B — shown: a prompt must actually become visible.
    if (!verdict) {
      let shownDeadline = Date.now() + ACT_SHOWN_MS;
      for (;;) {
        let got;
        try {
          got = await pump.next(['consent.shown', 'consent.waiting', 'consent.grant', 'consent.deny', 'act.result', 'proposal.queued', 'proposal.cancelled'], shownDeadline - Date.now());
        } catch (e) {
          if (isTimeout(e)) {
            throw new DriverError('PROMPT_NOT_SHOWN', 'the extension received the proposal but the consent prompt never appeared — no panel card or in-page banner became visible');
          }
          throw e;
        }
        if (got.type === 'proposal.queued') {
          // Take-over: the user is driving. The proposal is HELD, not
          // refused — queued heartbeats keep this wait alive until
          // hand-back runs it through the gate.
          console.error('[queued] user has taken over in the panel — this action is held until they hand back');
          shownDeadline = Date.now() + 60000;
          continue;
        }
        if (got.type === 'proposal.cancelled') {
          throw new DriverError('CANCELLED', got.detail || 'the proposal was cancelled — it will not apply');
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
      let consentDeadline = Date.now() + ACT_CONSENT_MS;
      for (;;) {
        let got;
        try {
          got = await pump.next(['consent.grant', 'consent.deny', 'act.result', 'consent.waiting', 'proposal.queued', 'proposal.cancelled'], consentDeadline - Date.now());
        } catch (e) {
          if (isTimeout(e)) {
            throw new DriverError('NO_ANSWER', 'the consent prompt was shown but not answered in time — the proposal is still queued in the extension panel, not denied or forgotten');
          }
          throw e;
        }
        if (got.type === 'proposal.queued') {
          console.error('[queued] user has taken over in the panel — this action is held until they hand back');
          consentDeadline = Date.now() + 60000;
          continue;
        }
        if (got.type === 'proposal.cancelled') {
          throw new DriverError('CANCELLED', got.detail || 'the proposal was cancelled — it will not apply');
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
  // One retry on a refused/dropped first connection: a transient relay
  // or network hiccup used to fail the whole command (the 2026-11-10
  // session lost a status check to a single RELAY_UNREACHABLE). If the
  // retry also fails, the error stands — reported, not papered over.
  let ws;
  try {
    ws = await connect(CMD === 'status' ? 8000 : 15000);
  } catch (e) {
    if (!e || e.code !== 'RELAY_UNREACHABLE') throw e;
    console.error('[relay] first connection attempt failed — retrying once');
    await new Promise((r) => setTimeout(r, 1000));
    ws = await connect(CMD === 'status' ? 8000 : 15000);
  }
  try {
    if (CMD === 'status') {
      const confirm = await pair(ws, 8000);
      // The extension's service worker holds its relay socket open while it
      // is alive, so "peer present at the relay" is the worker-alive signal
      // protocol v1 exposes. Session grants live inside the extension and
      // protocol v1 has no message to query their remaining time, so that
      // field is reported as null (unknown), never invented.
      // Extension report (Fix 12/14/16): when a peer is present, ask the
      // extension itself for the pending proposals, key epoch + expiry,
      // and the sign-in block. A legacy extension never answers — the
      // query times out quietly and the fields stay null, never invented.
      let extension = null;
      if (confirm.peer) {
        try {
          const pump = createPump(ws, `status-${Date.now()}`);
          ws.send(JSON.stringify({ v: 1, type: 'status.request', id: `status-${Date.now()}` }));
          const rep = await pump.next(['status.report'], 5000);
          extension = {
            pending: rep.pending || [],
            heldCount: typeof rep.heldCount === 'number' ? rep.heldCount : null,
            keyEpoch: typeof rep.keyEpoch === 'number' ? rep.keyEpoch : null,
            keyExpiresAt: rep.keyExpiresAt || null,
            signinBlocked: !!(rep.signin && rep.signin.blocked),
            signinEmail: (rep.signin && rep.signin.email) || null,
            signinAction: (rep.signin && rep.signin.action) || null,
            tabUrl: rep.tabUrl || null,
          };
        } catch { extension = null; }
      }
      console.log(JSON.stringify({
        ok: true,
        command: 'status',
        ...statusSnapshot(!!confirm.peer),
        extension,
      }, null, 2));
      return;
    }

    if (CMD === 'cancel') {
      const proposalId = opt('--proposal-id', undefined);
      if (!proposalId) throw new DriverError('USAGE', 'cancel requires --proposal-id <id> (take it from status.extension.pending)');
      const confirm = await pair(ws, 8000);
      if (!confirm.peer) {
        throw new DriverError('PEER_DOWN', 'the extension is not connected to the relay — open Chrome with the extension installed, check the side panel says Connected, then retry');
      }
      const pump = createPump(ws, proposalId);
      ws.send(JSON.stringify({ v: 1, type: 'proposal.cancel', proposalId }));
      let ack;
      try {
        ack = await pump.next(['proposal.cancelled'], 5000);
      } catch {
        throw new DriverError('PEER_TIMEOUT', 'the extension did not answer the cancel request — the proposal may still be queued; check status');
      }
      console.log(JSON.stringify({
        ok: true,
        command: 'cancel',
        proposalId,
        detail: ack.detail || 'proposal withdrawn before a decision — it will not apply',
      }, null, 2));
      return;
    }

    const pairConfirm = await pair(ws);

    // Fail fast on a KNOWN-down peer (field fix 2026-11-10): with the
    // extension absent, every command used to burn its full timeout
    // (observe: 30s, twice) and report PEER_TIMEOUT for what was known
    // at pair time. Give the extension a short grace to join — it may
    // be mid-reconnect — then say PEER_DOWN plainly and exit.
    if (!pairConfirm.peer) {
      const graceRaw = process.env.JBB_PEER_WAIT_MS;
      const graceMs = graceRaw === undefined ? 5000 : Math.max(0, Number(graceRaw) || 0);
      let joined = false;
      if (graceMs > 0) {
        try { await waitFor(ws, ['peer.joined'], graceMs); joined = true; }
        catch { joined = false; }
      }
      if (!joined) {
        throw new DriverError('PEER_DOWN',
          'no peer in this room — the extension is not connected to the relay, or the key is wrong/stale (a wrong key pairs into a different, empty room). Open Chrome with the extension installed and check the side panel says Connected; if it already says Connected, the key is wrong — Rotate a fresh key in Setup and pair again with it (failed fast instead of waiting out the full timeout)');
      }
      console.error('[relay] peer joined during the grace wait — continuing');
    }

    if (CMD === 'plan') {
      // Propose an ordered plan; the user approves it ONCE in the panel;
      // the steps then run under the plan — no per-step prompts except
      // T3 steps, which ask individually (the pump handles that as a
      // normal consent wait). Stops at the first failed step: later
      // steps were written against a state that no longer holds.
      const file = opt('--file', undefined);
      if (!file) throw new DriverError('USAGE', 'plan requires --file <steps.json>');
      let spec;
      try { spec = JSON.parse(readFileSync(file, 'utf8')); }
      catch (e) { throw new DriverError('USAGE', `cannot read plan file: ${e.message}`); }
      const rawSteps = Array.isArray(spec) ? spec : spec.steps;
      const title = Array.isArray(spec) ? 'driver plan' : (spec.title || 'driver plan');
      if (!Array.isArray(rawSteps) || !rawSteps.length) {
        throw new DriverError('USAGE', 'plan file must contain a non-empty steps array');
      }
      if (rawSteps.length > 20) {
        throw new DriverError('USAGE', `plan has ${rawSteps.length} steps — the maximum is 20`);
      }
      const T2_TYPES = ['listTabs', 'switchTab', 'closeTab', 'closeInactiveTabs', 'openTab', 'pinTab', 'fetch', 'media', 'frameGrab', 'audioCapture'];
      const wireSteps = rawSteps.map((s, i) => {
        if (!s || !s.type) throw new DriverError('USAGE', `step ${i + 1} has no type`);
        return {
          type: s.type,
          actionTier: s.tier || (T2_TYPES.includes(s.type) ? 'T2' : 'T1'),
          site: s.site || '',
          description: s.description || s.type,
        };
      });
      const planId = `plan-${Date.now()}`;
      const verdict = await new Promise((resolve, reject) => {
        const to = setTimeout(() => {
          ws.off('message', onMsg);
          reject(new DriverError('PLAN_NO_ANSWER', 'the plan was not answered in time — it is still waiting in the extension panel, not denied or forgotten'));
        }, 120000);
        const onMsg = (raw) => {
          let m;
          try { m = JSON.parse(String(raw)); } catch { return; }
          if (!m || m.planId !== planId) return;
          if (m.type === 'plan.approved' || m.type === 'plan.denied') {
            clearTimeout(to);
            ws.off('message', onMsg);
            resolve(m);
          }
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ v: 1, type: 'plan.propose', id: planId, plan: { title, steps: wireSteps } }));
      });
      if (verdict.type === 'plan.denied') {
        emitAndExit({ ok: false, error: 'PLAN_DENIED', message: verdict.reason || 'the user denied the plan' }, 1);
      }
      console.error(`[plan] approved: ${wireSteps.length} steps on ${(verdict.sites || []).join(', ')}`);
      const results = [];
      suppressActPrint = true;
      try {
        for (let i = 0; i < rawSteps.length; i++) {
          const s = rawSteps[i];
          const w = wireSteps[i];
          const proposal = {
            actionTier: w.actionTier,
            type: w.type,
            target: { ref: s.ref || null, label: s.label || '' },
            site: w.site,
            description: w.description,
            planId,
          };
          if (s.value !== undefined) proposal.value = s.value;
          if (s.url) proposal.url = s.url;
          if (typeof s.tabId === 'number') proposal.tabId = s.tabId;
          if (s.selector) proposal.selector = s.selector;
          await runAct(ws, proposal, `act-${Date.now()}-p${i + 1}`);
          const r = lastActResult || { ok: false, detail: 'no result' };
          results.push({ step: i + 1, type: w.type, ok: !!r.ok, detail: r.detail || '' });
          console.error(`[plan] step ${i + 1}/${rawSteps.length} ${w.type}: ${r.ok ? 'ok' : 'FAILED — ' + (r.detail || '')}`);
          if (!r.ok) break;
        }
      } finally {
        suppressActPrint = false;
      }
      const completed = results.length === rawSteps.length && results.every((r) => r.ok);
      console.log(JSON.stringify({ ok: completed, command: 'plan', planId, title, steps: results, completed }, null, 2));
      if (!completed) process.exitCode = 1;
      return;
    }

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

    if (CMD === 'listen') {
      // Propose audio capture (T2 consent in the extension), then write
      // the streamed chunks to a file the agent can transcribe. The
      // chunk collector attaches BEFORE the proposal so nothing is lost
      // between the start handshake and the stream.
      const durS = Number(opt('--duration', '0'));
      const outPath = opt('--out', `capture-${Date.now()}.webm`);
      const outStream = createWriteStream(outPath);
      let chunks = 0, bytes = 0;
      const onMsg = (raw) => {
        let m;
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m && m.type === 'audio.chunk' && typeof m.data === 'string') {
          const buf = Buffer.from(m.data, 'base64');
          outStream.write(buf);
          chunks++;
          bytes += buf.length;
        }
      };
      ws.on('message', onMsg);
      const proposal = {
        actionTier: 'T2', type: 'audioCapture', capture: { action: 'start' },
        target: { ref: null, label: '' }, site: opt('--site', ''),
        description: 'start audio capture on this tab — audio streams to the driver only, never stored',
      };
      suppressActPrint = true;
      try {
        await runAct(ws, proposal, `act-${Date.now()}-listen`);
      } finally {
        suppressActPrint = false;
      }
      if (!lastActResult || !lastActResult.ok) {
        ws.off('message', onMsg);
        outStream.end();
        emitAndExit({
          ok: false, error: 'CAPTURE_NOT_STARTED',
          message: (lastActResult && lastActResult.detail) || 'audio capture did not start',
        }, 1);
      }
      console.error(`[listen] capturing to ${outPath}${durS > 0 ? ` for ${durS}s` : ' (Ctrl-C to stop)'}`);
      await new Promise((resolve) => {
        if (durS > 0) setTimeout(resolve, durS * 1000);
        process.once('SIGINT', resolve);
      });
      // Stop is fire-and-forget: stopping a capture never needs consent
      // (the extension allows it unconditionally).
      try {
        ws.send(JSON.stringify({
          v: 1, type: 'act.propose', id: `act-${Date.now()}-stop`,
          proposal: {
            actionTier: 'T2', type: 'audioCapture', capture: { action: 'stop' },
            target: { ref: null, label: '' }, site: '', description: 'stop audio capture',
          },
        }));
      } catch { /* socket already going away */ }
      await new Promise((r) => setTimeout(r, 600));
      ws.off('message', onMsg);
      await new Promise((r) => outStream.end(r));
      console.log(JSON.stringify({ ok: true, command: 'listen', file: outPath, chunks, bytes }, null, 2));
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
      // Interactive pagination (Fix 5): --interactive-offset / --limit
      // page the snapshot's interactives (the result carries
      // interactive_offset/interactive_total/interactive_next_offset).
      const iOffRaw = opt('--interactive-offset', undefined);
      if (iOffRaw !== undefined) {
        const io = Number(iOffRaw);
        if (!Number.isFinite(io) || io < 0) {
          throw new DriverError('USAGE', '--interactive-offset must be a non-negative number (take interactive_next_offset from the previous observe)');
        }
        req.interactiveOffset = io;
      }
      const iLimRaw = opt('--interactive-limit', undefined);
      if (iLimRaw !== undefined) {
        const il = Number(iLimRaw);
        if (!Number.isFinite(il) || il < 1) {
          throw new DriverError('USAGE', '--interactive-limit must be a positive number (max 500)');
        }
        req.interactiveLimit = il;
      }
      const observeMs = Number(process.env.JBB_OBSERVE_MS) || 30000;
      let res;
      try {
        res = await sendResilient(ws, req, ['observe.result'], observeMs);
      } catch (e) {
        if (!e || e.code !== 'PEER_TIMEOUT') throw e;
        // The extension's transport can flap mid-request (its offscreen
        // document is mortal; the request or the reply dies with it) and
        // the relay never says peer.unavailable for a request it already
        // forwarded, so the resend trigger in sendResilient never fires.
        // Observe is read-only — ONE retry across the heal is always safe.
        console.error('[observe] no reply — retrying once in case the extension transport flapped');
        await new Promise((r) => setTimeout(r, 3000));
        req.id = `obs-${Date.now()}`;
        res = await sendResilient(ws, req, ['observe.result'], observeMs);
      }
      // Empty observe (Fix 7): a loaded page sometimes answers with an
      // empty snapshot (url: None, text_len: 0, or a tiny shell) and a
      // retry moments later returns the full page. Never hand the agent
      // an empty first answer — retry once, then return whatever came
      // back (a genuinely empty page must still be reportable, so the
      // retry's own failure keeps the first result).
      const snapEmpty = (r) => {
        const s = r && r.snapshot;
        if (!s) return true;
        const frameText = (s.frames || []).reduce((n, f) => n + ((f.text || "").length), 0);
        return ((s.text || "").length + frameText) < 100 && ((s.interactives || []).length === 0);
      };
      if (snapEmpty(res)) {
        console.error('[observe] empty snapshot — retrying once (loaded pages sometimes answer empty first)');
        await new Promise((r) => setTimeout(r, 2000));
        req.id = `obs-${Date.now()}`;
        try { res = await sendResilient(ws, req, ['observe.result'], observeMs); }
        catch (e) { /* keep the first (empty) result rather than failing on the retry */ }
      }
      // Tab-wander report (Fix 2): the snapshot carries tabMoved when
      // the tab left the page on its own since the last observe — say it
      // loudly on stderr, because the JSON below is the NEW page's
      // content and acting on it as if it were the intended page is how
      // clicks landed on about:blank and the Assistant sidebar.
      if (res && res.snapshot && res.snapshot.tabMoved) {
        console.error(`[wander] the tab moved on its own — was ${res.snapshot.tabMoved.from}, now ${res.snapshot.tabMoved.to}. This snapshot is the NEW page; re-observe the intended page before acting.`);
      }
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
        actionTier: opt('--tier', isTabType || type === 'fetch' || type === 'media' || type === 'frameGrab' || type === 'audioCapture' ? 'T2' : 'T1'),
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
      } else if (type === 'scroll') {
        // Scroll carries its direction + distance IN the proposal — the
        // content script can only report (and do) what it is told. Until
        // v0.3.0 the driver sent neither, and every scroll reported
        // "scrolled undefined" while moving nothing.
        const direction = opt('--direction', 'down');
        if (!['up', 'down', 'top', 'bottom'].includes(direction)) {
          throw new DriverError('USAGE', '--direction must be up, down, top or bottom');
        }
        const amountRaw = opt('--amount', undefined);
        const amount = amountRaw === undefined ? 600 : Number(amountRaw);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new DriverError('USAGE', '--amount must be a positive number of pixels');
        }
        proposal.direction = direction;
        proposal.amount = amount;
        proposal.description = `scroll ${direction}`;
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
        // --header 'Name: Value' (repeatable): the app headers the
        // page's own XHRs send on top of cookies (CSRF tokens and the
        // like) — without them, session-gated APIs refuse a fetch that
        // carries only cookies. The extension honors them SAME-ORIGIN
        // ONLY and never prints their values.
        const headerArgs = [];
        for (let hi = 0; hi < args.length; hi++) {
          if (args[hi] === '--header' && args[hi + 1]) headerArgs.push(args[hi + 1]);
        }
        if (headerArgs.length) {
          const hdrs = {};
          for (const hstr of headerArgs) {
            const ci = hstr.indexOf(':');
            if (ci <= 0) throw new DriverError('USAGE', `--header must look like 'Name: Value' (got '${hstr}')`);
            hdrs[hstr.slice(0, ci).trim()] = hstr.slice(ci + 1).trim();
          }
          proposal.headers = hdrs;
          proposal.description += ` with ${headerArgs.length} page-session header(s)`;
        }
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
      } else if (type === 'audioCapture') {
        const capAction = opt('--capture', undefined);
        if (!['start', 'stop'].includes(capAction)) {
          throw new DriverError('USAGE', '--type audioCapture requires --capture start|stop');
        }
        proposal.capture = { action: capAction };
        proposal.description = capAction === 'start'
          ? 'start audio capture on this tab — audio streams to the driver only, never stored'
          : 'stop audio capture';
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
