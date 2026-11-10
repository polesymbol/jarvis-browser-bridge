/**
 * Transport-topology guard tests for the offscreen relay socket.
 * Run: node extension/test/transport.guard.test.mjs
 *
 * Invariants (Pratik's brief, 2026-11-09):
 *  - The relay WebSocket lives in the offscreen document. The service
 *    worker holds NO socket: it connects/sends via runtime messages and
 *    consumes forwarded protocol strings.
 *  - Transport messages are accepted only from the offscreen document —
 *    a forged jbb.relay.* message from anywhere else is an injection path.
 *  - The keepalive watchdog recreates the offscreen document
 *    IMMEDIATELY when the document itself is gone (hasDocument is ground
 *    truth — Chrome reaps idle offscreen documents and a dead document
 *    reports nothing), and after >20s down/silent otherwise. The v0.2.31
 *    thresholds (45s silence + 30s sustained) left the bridge dead for
 *    75+ seconds per cycle in the 2026-11-09 live flap.
 *  - The offscreen keeps the socket warm with an application-level
 *    heartbeat data frame (intermediaries don't always count protocol
 *    pings as activity), and the worker retries a relay send once when
 *    the document races away mid-post.
 *  - The offscreen document is TRANSPORT ONLY: it pairs, forwards, queues,
 *    reconnects with backoff — and can never approve, deny, or apply an
 *    action. No consent vocabulary may exist in its code.
 *  - The audio chime keeps working from the same document.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const off = fs.readFileSync(path.join(dir, "../offscreen.js"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

const manifest = JSON.parse(fs.readFileSync(path.join(dir, "../manifest.json"), "utf8"));
check("manifest declares the 'offscreen' permission (without it chrome.offscreen is undefined and NOTHING can connect — the v0.2.30 live failure)",
  (manifest.permissions || []).includes("offscreen"));
check("a missing offscreen API surfaces as a connect error, never silence",
  bg.includes("Cannot connect: this build cannot create its offscreen transport document"));

// ---------------------------------------------------------- worker holds no socket
check("worker: constructs no WebSocket", !bg.includes("new WebSocket("));
check("worker: no direct socket handle remains", !bg.includes("state.ws"));
check("worker: sends via the offscreen transport",
  bg.includes('postToOffscreen({ kind: "jbb.relay.send", data: JSON.stringify(msg) })'));
check("worker: expresses connect intent via postRelayConnect",
  bg.includes("function postRelayConnect()") && bg.includes('kind: "jbb.relay.connect"'));

// ---------------------------------------------------------- ingress is sender-verified
check("worker: forwarded relay messages reach handleRelayMessage",
  bg.includes('if (msg.kind === "jbb.relay.message") handleRelayMessage(msg.data);'));
check("worker: transport kinds require the offscreen sender",
  bg.includes('sender.url.indexOf("offscreen.html") === -1'));

// ---------------------------------------------------------- watchdog
check("watchdog: exists and is hooked into the keepalive alarm",
  bg.includes("function relayWatchdog()") && bg.includes("relayWatchdog();"));
check("watchdog: recreates the document after >20s down",
  bg.includes("now - state.relayDownSince > 20000") && bg.includes("closeDocument"));
check("watchdog: offscreen silence counts as down",
  bg.includes("now - state.offscreenSeenAt > 30000"));
check("watchdog: a GONE document is recreated immediately (hasDocument fast path)",
  bg.includes("chrome.offscreen.hasDocument") &&
  bg.includes("offscreen document gone — recreating it immediately") &&
  bg.includes("lastDocRecreateAt"));
check("worker: a relay send that races a document recreate is retried once",
  bg.includes('msg.kind === "jbb.relay.send"') && bg.includes("}, 800);"));

// ---------------------------------------------------------- offscreen owns the socket
check("offscreen: constructs the WebSocket", off.includes("new WebSocket(rUrl)"));
check("offscreen: pairs with the protocol v1 literal",
  off.includes('type: "pair.request", role: "extension", key: rKey'));
check("offscreen: forwards raw messages to the worker",
  off.includes('kind: "jbb.relay.message", data: raw'));
check("offscreen: reports connection state + says hello on load",
  off.includes('kind: "jbb.relay.state"') && off.includes('kind: "jbb.relay.hello"'));
check("offscreen: reconnects with capped exponential backoff",
  off.includes("Math.min(rBackoff * 2, 30000)") && off.includes("scheduleReconnect()"));
check("offscreen: queues sends until pair.confirm, then flushes",
  off.includes("sendQ.push(data)") && off.includes('"pair.confirm"'));
check("offscreen: application-level heartbeat keeps the socket warm",
  off.includes('"transport.ping"') && off.includes("}, 20000);"));

// ---------------------------------------------------------- transport only, never a judge
check("offscreen: no consent machinery (never approves/denies/applies)",
  !off.includes("decideAction") && !off.includes("consent.grant") &&
  !off.includes("consent.deny") && !off.includes("act.result") &&
  !off.includes("executeProposal") && !off.includes("resolveConsent"));
check("offscreen: chime path intact (tone variants ride the same message)",
  off.includes('msg.kind === "jbb.offscreen.playTone"') && off.includes("playChime(msg.tone)"));

// ---------------------------------------------------------- document lifetime (v0.3.1)
check("worker: document created with a no-lifetime-limit reason alongside audio (Chrome closes AUDIO_PLAYBACK-only documents 30s after audio stops — that timer was the connect flap)",
  bg.includes('create(["AUDIO_PLAYBACK", "USER_MEDIA"], false)'));
check("worker: a rejected reason set falls back to audio-only instead of dead-ending the bridge",
  bg.includes('create(["AUDIO_PLAYBACK"], true)') && bg.includes("retrying with AUDIO_PLAYBACK only"));
check("worker: a connect post that races a document recreate is retried once too",
  bg.includes('msg.kind === "jbb.relay.connect"'));
check("worker: killing a session no longer blanks the saved relay URL (Connect reads state.relayUrl — blanking made it a dead button)",
  !bg.includes('state.relayUrl = "";'));
check("worker: revive reconnects immediately when a relay URL is saved",
  bg.includes("if (state.relayUrl) connectRelay(state.relayUrl);"));

console.log(failures === 0 ? "ALL TRANSPORT GUARD TESTS PASSED" : failures + " TRANSPORT GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
