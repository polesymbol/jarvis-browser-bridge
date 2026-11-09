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
 *  - The keepalive watchdog recreates the offscreen document when the
 *    transport is down/silent for >30s.
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
check("watchdog: recreates the document after >30s down",
  bg.includes("now - state.relayDownSince > 30000") && bg.includes("closeDocument"));
check("watchdog: offscreen silence counts as down",
  bg.includes("now - state.offscreenSeenAt > 45000"));

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

// ---------------------------------------------------------- transport only, never a judge
check("offscreen: no consent machinery (never approves/denies/applies)",
  !off.includes("decideAction") && !off.includes("consent.grant") &&
  !off.includes("consent.deny") && !off.includes("act.result") &&
  !off.includes("executeProposal") && !off.includes("resolveConsent"));
check("offscreen: chime path intact (tone variants ride the same message)",
  off.includes('msg.kind === "jbb.offscreen.playTone"') && off.includes("playChime(msg.tone)"));

console.log(failures === 0 ? "ALL TRANSPORT GUARD TESTS PASSED" : failures + " TRANSPORT GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
