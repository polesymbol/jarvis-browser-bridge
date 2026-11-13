// Driver CLI contract tests — run: node driver/test/driver.cli.test.mjs
// Pins the output contract downstream tooling relies on:
//   * stdout is NEVER empty; failures are {"ok":false,"error","message"}
//     on stdout with a non-zero exit code.
//   * --key is always the connector key; a keypress travels in --press-key.
//   * `status` prints peerConnected / workerAlive / pendingProposals /
//     sessionTimeRemaining as JSON, including on its error paths.
//   * The act consent lifecycle is reported distinctly: PEER_DOWN,
//     PROMPT_NOT_SHOWN, NO_ANSWER, DENIED, APPLIED_UNCONFIRMED — never one
//     opaque timeout, and an act is never resent after a grant.
// No external services: real relays on ephemeral ports + fake extensions.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import WebSocket from "ws";
import { createRelay } from "../../relay/server.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const KEY = "test-connector-key-0123456789abcdef";
const STATUS_KEY = "status-key-0123456789abcdef";

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok || !extra ? "" : " — " + extra));
  if (!ok) failures++;
}
function parseStdout(out) {
  try { return JSON.parse(out); } catch { return null; }
}

function runDriver(args, envOverrides = {}, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.KEY;
    Object.assign(env, envOverrides);
    const p = spawn("node", [ROOT + "driver/driver.js", ...args], { cwd: ROOT, env });
    let out = "", err = "";
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function closedPort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

async function startRelay() {
  const { httpServer } = createRelay(0);
  await new Promise((r) => httpServer.on("listening", r));
  return { httpServer, port: httpServer.address().port };
}

// Legacy fake extension (pre-ack protocol): pairs, grants act proposals and
// reports a result echoing the pressed key — no lifecycle acks at all. The
// driver must stay compatible with it.
function fakeExtension(port, key) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const captured = [];
    ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "pair.request", role: "extension", key })));
    ws.on("error", reject);
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "pair.confirm") { resolve({ ws, captured }); return; }
      if (m.type === "act.propose") {
        captured.push(m.proposal || {});
        ws.send(JSON.stringify({ v: 1, type: "consent.grant", id: m.id, scope: "once" }));
        const keyName = m.proposal && m.proposal.key;
        setTimeout(() => {
          try { ws.send(JSON.stringify({ v: 1, type: "act.result", id: m.id, ok: true, detail: "pressed " + keyName })); } catch {}
        }, 60);
      }
    });
  });
}

// Lifecycle fake extension: speaks the ack protocol in scripted modes.
function fakeLifecycleExt(port, key, mode) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const state = { ws, proposeCount: 0, timers: [] };
    ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "pair.request", role: "extension", key })));
    ws.on("error", reject);
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      const send = (o) => { try { ws.send(JSON.stringify({ v: 1, ...o })); } catch {} };
      const after = (ms, fn) => { state.timers.push(setTimeout(fn, ms)); };
      if (m.type === "pair.confirm") { resolve(state); return; }
      if (m.type === "plan.propose") {
        state.lastPlan = m.plan;
        if (mode === "plandeny") {
          after(60, () => send({ type: "plan.denied", planId: m.id, reason: "user denied the plan" }));
        } else {
          after(60, () => send({ type: "plan.approved", planId: m.id,
            sites: ["example.com"], stepCount: (m.plan.steps || []).length, expiresAt: Date.now() + 1800000 }));
        }
        return;
      }
      if (m.type === "act.propose" && m.proposal && m.proposal.type === "audioCapture" &&
          m.proposal.capture && m.proposal.capture.action === "stop") {
        state.stopProposals = (state.stopProposals || 0) + 1;
        return;
      }
      if (m.type === "status.request") {
        if (mode === "statusReport") {
          send({ type: "status.report",
            pending: [{ proposalId: "prop-7", ageSec: 45, type: "click", label: "Segment View",
                        site: "https://sellercentral.amazon.com" }],
            heldCount: 0, keyEpoch: 3, keyExpiresAt: Date.now() + 3600000,
            signin: { blocked: true, email: "user@example.com",
                      action: "open the side panel and acknowledge the Chrome sign-in" },
            tabUrl: "https://sellercentral.amazon.com/analytics" });
        }
        return;
      }
      if (m.type === "proposal.cancel") {
        if (mode === "cancelAck") {
          send({ type: "proposal.cancelled", proposalId: m.proposalId,
            detail: "proposal withdrawn before a decision — it will not apply" });
        }
        return;
      }
      if (m.type !== "act.propose" && m.type !== "observe.request") return;
      if (m.type === "observe.request") {
        state.lastObserve = m;
        state.observeCount = (state.observeCount || 0) + 1;
        if (mode === "observeFlap" && state.observeCount === 1) return; // transport died mid-request: no reply ever comes
        if (mode === "observeEmptyFirst" && state.observeCount === 1) {
          // First answer is an empty shell — the driver must retry once.
          send({ type: "observe.result", id: m.id, snapshotVersion: 5,
            snapshot: { title: "Loading", text: "", text_chunk: "", text_offset: 0,
                        text_total_chars: 0, text_next_offset: null, interactives: [] } });
          return;
        }
        if (mode === "observeEmptyFirst") {
          send({ type: "observe.result", id: m.id, snapshotVersion: 5,
            snapshot: { title: "Long page", text: "full page text — the loaded listing",
              text_chunk: "full page text — the loaded listing", text_offset: 0,
              text_total_chars: 41, text_next_offset: null,
              interactives: [{ ref: "e1", label: "Home", type: "link" }] } });
          return;
        }
        send({ type: "observe.result", id: m.id, snapshotVersion: 5,
          snapshot: { title: "Long page", text: "tail chunk — COURSE COMPLETED",
            text_chunk: "tail chunk — COURSE COMPLETED",
            text_offset: m.textOffset || 0, text_total_chars: 31234, text_next_offset: null,
            interactives: [{ ref: "e1", label: "Next", type: "link" }] } });
        return;
      }
      state.proposeCount++;
      state.lastProposal = m.proposal;
      const pid = m.id;
      send({ type: "proposal.received", proposalId: pid });
      if (mode === "capture") {
        after(30, () => send({ type: "consent.shown", proposalId: pid, via: "panel" }));
        after(80, () => send({ type: "consent.grant", proposalId: pid, scope: "once" }));
        after(150, () => send({ type: "act.result", proposalId: pid, ok: true,
          detail: "listening to example.com — audio streams to the driver in chunks; nothing is stored",
          data: { captureId: "cap-test", site: "example.com" } }));
        after(400, () => send({ type: "audio.chunk", captureId: "cap-test", seq: 0,
          mimeType: "audio/webm;codecs=opus", data: Buffer.from("CHUNK1").toString("base64") }));
        after(700, () => send({ type: "audio.chunk", captureId: "cap-test", seq: 1,
          mimeType: "audio/webm;codecs=opus", data: Buffer.from("CHUNK2").toString("base64") }));
        return;
      }
      if (mode === "notshown") return; // received, but no prompt ever appears
      after(30, () => send({ type: "consent.shown", proposalId: pid, via: "panel" }));
      if (mode === "grant" || mode === "plan") {
        after(80, () => send({ type: "consent.grant", proposalId: pid, scope: "once" }));
        after(180, () => send({ type: "act.result", proposalId: pid, ok: true, detail: "done" }));
      } else if (mode === "deny") {
        after(80, () => send({ type: "consent.deny", proposalId: pid, reason: "user denied" }));
      } else if (mode === "waiting") {
        let n = 0;
        state.timers.push(setInterval(() => { n++; send({ type: "consent.waiting", proposalId: pid, waitedMs: n * 400 }); }, 400));
      } else if (mode === "noresult") {
        after(80, () => send({ type: "consent.grant", proposalId: pid, scope: "once" }));
        // act.result never arrives
      } else if (mode === "stale") {
        // The background refuses BEFORE consent: received, then an
        // act.result carrying STALE_SNAPSHOT + the current version.
        after(40, () => send({ type: "act.result", proposalId: pid, ok: false,
          error: "STALE_SNAPSHOT", snapshotVersion: 9,
          detail: "stale snapshot: act built against v3, current snapshot is v9 — re-observe and rebuild the act" }));
      } else if (mode === "mediafail") {
        after(80, () => send({ type: "consent.grant", proposalId: pid, scope: "once" }));
        after(180, () => send({ type: "act.result", proposalId: pid, ok: true,
          detail: "did not start — paused: true, reason: autoplay-blocked",
          data: { action: "play", verified: false, reason: "autoplay-blocked", paused: true,
                  currentTime: 0, duration: 2100, playerKey: "deck-player@cdn.example.com" } }));
      } else if (mode === "mediaok") {
        after(80, () => send({ type: "consent.grant", proposalId: pid, scope: "once" }));
        after(180, () => send({ type: "act.result", proposalId: pid, ok: true,
          detail: "playing — currentTime advancing (0.4s → 1.2s of 2100s)",
          data: { action: "play", verified: true, paused: false, currentTime: 1.2, duration: 2100,
                  playerKey: "deck-player@cdn.example.com" } }));
      } else if (mode === "revoke") {
        // The user rotates the key mid-consent: the extension revokes its
        // key at the relay, which notifies the driver and tears the room
        // down. The driver must surface KEY_ROTATED, not a phase timeout.
        after(150, () => { try { ws.send(JSON.stringify({ v: 1, type: "key.revoked", key })); } catch {} });
      }
    });
  });
}
function stopExt(state) {
  (state.timers || []).forEach((t) => { clearTimeout(t); clearInterval(t); });
  try { state.ws.close(); } catch {}
}

// ==================================================================== part 1
const { httpServer, port } = await startRelay();
const relayArg = `ws://127.0.0.1:${port}`;

{
  const r = await runDriver(["--help"]);
  const j = parseStdout(r.out);
  check("help exits 0 with JSON usage mentioning --press-key",
    r.code === 0 && !!j && j.ok === true && JSON.stringify(j).includes("--press-key"));
}
{
  const r = await runDriver(["--relay", relayArg, "observe"], { KEY: "" });
  const j = parseStdout(r.out);
  check("KEY= observe exits non-zero", r.code !== 0, "code=" + r.code);
  check("KEY= observe stdout is non-empty error JSON",
    r.out.trim().length > 0 && !!j && j.ok === false && j.error === "KEY_MISSING" && typeof j.message === "string",
    "stdout=" + JSON.stringify(r.out));
}
{
  const r = await runDriver(["--relay", relayArg, "--key", "short", "observe"]);
  const j = parseStdout(r.out);
  check("short --key exits non-zero with KEY_INVALID JSON",
    r.code !== 0 && !!j && j.ok === false && j.error === "KEY_INVALID" && r.out.trim().length > 0);
}
{
  const r = await runDriver(["--relay", relayArg, "--key", KEY]);
  const j = parseStdout(r.out);
  check("no command exits non-zero with USAGE JSON",
    r.code !== 0 && !!j && j.ok === false && j.error === "USAGE" && r.out.trim().length > 0);
}
{
  const dead = await closedPort();
  const r = await runDriver(["--relay", `ws://127.0.0.1:${dead}`, "--key", KEY, "observe"]);
  const j = parseStdout(r.out);
  check("unreachable relay exits non-zero with RELAY_UNREACHABLE JSON",
    r.code !== 0 && !!j && j.ok === false && j.error === "RELAY_UNREACHABLE" && r.out.trim().length > 0);
}
{
  const r = await runDriver(["--relay", relayArg, "--key", STATUS_KEY, "status"]);
  const j = parseStdout(r.out);
  check("status (no peer) exits 0 with the four fields",
    r.code === 0 && !!j && j.ok === true && j.peerConnected === "no" && j.workerAlive === "no" &&
    j.pendingProposals === 0 && j.sessionTimeRemaining === null,
    "stdout=" + r.out);
}
{
  const r = await runDriver(["--relay", relayArg, "status"], { KEY: "" });
  const j = parseStdout(r.out);
  check("status with KEY= exits non-zero, error JSON plus the four fields",
    r.code !== 0 && !!j && j.ok === false && j.error === "KEY_MISSING" &&
    j.peerConnected === "no" && j.workerAlive === "no" && j.pendingProposals === 0 && j.sessionTimeRemaining === null,
    "stdout=" + r.out);
}
{
  const dead = await closedPort();
  const r = await runDriver(["--relay", `ws://127.0.0.1:${dead}`, "--key", KEY, "status"]);
  const j = parseStdout(r.out);
  check("status with unreachable relay exits non-zero, error JSON plus the four fields",
    r.code !== 0 && !!j && j.ok === false && j.error === "RELAY_UNREACHABLE" &&
    j.peerConnected === "no" && j.workerAlive === "no" && j.pendingProposals === 0 && j.sessionTimeRemaining === null,
    "stdout=" + r.out);
}

const ext = await fakeExtension(port, KEY);
{
  const r = await runDriver(["--relay", relayArg, "--key", KEY, "status"]);
  const j = parseStdout(r.out);
  check("status (peer connected) reports yes/yes",
    r.code === 0 && !!j && j.peerConnected === "yes" && j.workerAlive === "yes" && j.pendingProposals === 0,
    "stdout=" + r.out);
}
{
  const r = await runDriver(["--relay", relayArg, "--key", KEY, "act", "--type", "key", "--press-key", "Enter", "--tier", "T1"]);
  const j = parseStdout(r.out);
  const prop = ext.captured[ext.captured.length - 1] || {};
  check("legacy extension (no acks): act --type key still completes",
    r.code === 0 && !!j && j.type === "act.result" && j.ok === true, "code=" + r.code + " stdout=" + r.out);
  check("keypress proposal carries key=Enter (connector --key untouched)",
    prop.type === "key" && prop.key === "Enter", "proposal=" + JSON.stringify(prop));
}
{
  const r = await runDriver(["--relay", relayArg, "--key", KEY, "act", "--type", "key", "--tier", "T1"]);
  const j = parseStdout(r.out);
  check("act --type key without --press-key exits non-zero with USAGE JSON",
    r.code !== 0 && !!j && j.ok === false && j.error === "USAGE" && r.out.trim().length > 0);
}
{
  const r = await runDriver(["--relay", relayArg, "--key", KEY, "abort"]);
  const j = parseStdout(r.out);
  check("abort exits 0 with non-empty JSON on stdout",
    r.code === 0 && !!j && j.ok === true && r.out.trim().length > 0, "stdout=" + JSON.stringify(r.out));
}
try { ext.ws.close(); } catch {}
httpServer.close();

// ==================================================================== part 2
// Consent lifecycle: distinct codes per state, heartbeats surfaced, and no
// act resend after a grant. Small phase timeouts via env keep this fast.
const L = await startRelay();
const lArg = `ws://127.0.0.1:${L.port}`;
const FAST = {
  JBB_ACT_RECEIPT_MS: "4000",
  JBB_ACT_SHOWN_MS: "2000",
  JBB_ACT_CONSENT_MS: "3500",
  JBB_ACT_RESULT_MS: "2000",
};
const actArgs = (key) => ["--relay", lArg, "--key", key, "act", "--type", "click", "--target", "Buy", "--tier", "T1"];

{
  // No extension at all for this key: suspended/offline -> PEER_DOWN.
  const r = await runDriver(actArgs("down-key-0123456789abcdef"), FAST);
  const j = parseStdout(r.out);
  check("extension offline -> PEER_DOWN",
    r.code !== 0 && !!j && j.ok === false && j.error === "PEER_DOWN", "stdout=" + r.out + " err=" + r.err);
}
{
  const key = "grant-key-0123456789abcdef";
  const e = await fakeLifecycleExt(L.port, key, "grant");
  const r = await runDriver(actArgs(key), FAST);
  const j = parseStdout(r.out);
  check("full lifecycle (received->shown->grant->result) exits 0",
    r.code === 0 && !!j && j.type === "act.result" && j.ok === true, "stdout=" + r.out);
  stopExt(e);
}
{
  const key = "deny-key-0123456789abcdef0";
  const e = await fakeLifecycleExt(L.port, key, "deny");
  const r = await runDriver(actArgs(key), FAST);
  const j = parseStdout(r.out);
  check("user verdict deny -> DENIED",
    r.code !== 0 && !!j && j.ok === false && j.error === "DENIED", "stdout=" + r.out);
  stopExt(e);
}
{
  const key = "notshown-key-0123456789abc";
  const e = await fakeLifecycleExt(L.port, key, "notshown");
  const r = await runDriver(actArgs(key), FAST);
  const j = parseStdout(r.out);
  check("received but prompt never shown -> PROMPT_NOT_SHOWN",
    r.code !== 0 && !!j && j.ok === false && j.error === "PROMPT_NOT_SHOWN", "stdout=" + r.out);
  stopExt(e);
}
{
  const key = "waiting-key-0123456789abcd";
  const e = await fakeLifecycleExt(L.port, key, "waiting");
  const r = await runDriver(actArgs(key), FAST);
  const j = parseStdout(r.out);
  check("shown, heartbeats, unanswered -> NO_ANSWER (never 'did not rejoin')",
    r.code !== 0 && !!j && j.ok === false && j.error === "NO_ANSWER" &&
    r.err.includes("[waiting]") && !r.out.includes("did not rejoin"),
    "stdout=" + r.out + " stderr=" + r.err.slice(-200));
  stopExt(e);
}
{
  const key = "noresult-key-0123456789ab";
  const e = await fakeLifecycleExt(L.port, key, "noresult");
  const r = await runDriver(actArgs(key), FAST);
  const j = parseStdout(r.out);
  check("granted but result lost -> APPLIED_UNCONFIRMED with the exact message",
    r.code !== 0 && !!j && j.ok === false && j.error === "APPLIED_UNCONFIRMED" &&
    j.message === "the action may already have applied — observe before retrying",
    "stdout=" + r.out);
  check("act was NOT resent after grant (exactly one act.propose)",
    e.proposeCount === 1, "proposeCount=" + e.proposeCount);
  stopExt(e);
}
{
  const key = "revoke-key-0123456789abcdef";
  const e = await fakeLifecycleExt(L.port, key, "revoke");
  const r = await runDriver(actArgs(key), FAST);
  const j = parseStdout(r.out);
  check("key rotated mid-consent -> KEY_ROTATED (not a timeout)",
    r.code !== 0 && !!j && j.ok === false && j.error === "KEY_ROTATED" &&
    j.message === "key rotated or expired — pair again with a fresh key",
    "stdout=" + r.out);
  stopExt(e);
  // And pairing with the rotated key afterwards is refused explicitly,
  // distinct from a wrong key (which would pair into a lonely room).
  // The presented message covers expiry too: the relay poisons a rotated
  // and an expired key identically, so the driver cannot distinguish.
  const r2 = await runDriver(["--relay", lArg, "--key", key, "status"], FAST);
  const j2 = parseStdout(r2.out);
  check("pairing with a rotated key -> KEY_ROTATED plus status fields",
    r2.code !== 0 && !!j2 && j2.ok === false && j2.error === "KEY_ROTATED" &&
    j2.message === "key rotated or expired — pair again with a fresh key" &&
    j2.peerConnected === "no" && j2.workerAlive === "no",
    "stdout=" + r2.out);
}
{
  const key = "stale-key-0123456789abcdef";
  const e = await fakeLifecycleExt(L.port, key, "stale");
  const r = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "click",
    "--target", "Buy\u00A0now\u200B", "--tier", "T1", "--snapshot-version", "3"], FAST);
  const j = parseStdout(r.out);
  check("stale act -> STALE_SNAPSHOT on stdout with the current version, non-zero exit",
    r.code !== 0 && !!j && j.ok === false && j.error === "STALE_SNAPSHOT" &&
    j.snapshotVersion === 9 && /stale snapshot/.test(j.message || ""),
    "stdout=" + r.out);
  check("--snapshot-version reaches the proposal",
    !!e.lastProposal && e.lastProposal.snapshotVersion === 3,
    "proposal=" + JSON.stringify(e.lastProposal));
  check("--target is normalized (NBSP + zero-width stripped) before it reaches the proposal",
    !!e.lastProposal && e.lastProposal.target.label === "Buy now",
    "proposal=" + JSON.stringify(e.lastProposal));
  stopExt(e);
}
{
  const key = "obsflap-key-0123456789abc";
  const e = await fakeLifecycleExt(L.port, key, "observeFlap");
  const r = await runDriver(["--relay", lArg, "--key", key, "observe"], { ...FAST, JBB_OBSERVE_MS: "700" });
  const j = parseStdout(r.out);
  check("observe survives a transport flap: first request lost, the retry answers",
    r.code === 0 && !!j && j.type === "observe.result" && e.observeCount === 2,
    "code=" + r.code + " stdout=" + r.out.slice(0, 200) + " observeCount=" + e.observeCount);
  stopExt(e);
}
{
  const key = "paging-key-0123456789abcdef";
  const e = await fakeLifecycleExt(L.port, key, "grant");
  const r = await runDriver(["--relay", lArg, "--key", key, "observe", "--text-offset", "30000"], FAST);
  check("observe --text-offset pages to the final chunk (completion message readable)",
    r.code === 0 && r.out.includes("COURSE COMPLETED") && r.out.includes('"text_total_chars": 31234'),
    "stdout=" + r.out.slice(0, 200));
  check("the offset reached the extension's observe.request",
    !!e.lastObserve && e.lastObserve.textOffset === 30000, "req=" + JSON.stringify(e.lastObserve));
  const r2 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "clickAt", "--x", "10", "--y", "20", "--tier", "T1"], FAST);
  check("clickAt act succeeds through the lifecycle with its point",
    r2.code === 0 && !!e.lastProposal && e.lastProposal.type === "clickAt" &&
    e.lastProposal.point.x === 10 && e.lastProposal.point.y === 20,
    "stdout=" + r2.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r3 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "clickSelector", "--selector", "#go", "--tier", "T1"], FAST);
  check("clickSelector proposal carries the selector",
    r3.code === 0 && !!e.lastProposal && e.lastProposal.type === "clickSelector" && e.lastProposal.selector === "#go",
    "stdout=" + r3.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r4 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "hover", "--target", "Products", "--tier", "T1"], FAST);
  check("hover proposal flows with its target",
    r4.code === 0 && !!e.lastProposal && e.lastProposal.type === "hover" &&
    e.lastProposal.target.label === "Products" && /hover over 'Products'/.test(e.lastProposal.description),
    "stdout=" + r4.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r5 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "select", "--target", "Country", "--value", "IN", "--tier", "T2"], FAST);
  check("select proposal carries the option value",
    r5.code === 0 && !!e.lastProposal && e.lastProposal.type === "select" && e.lastProposal.optionValue === "IN",
    "stdout=" + r5.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r6 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "select", "--target", "Country", "--tier", "T2"], FAST);
  check("select without an option is a USAGE error",
    r6.code !== 0 && JSON.parse(r6.out).error === "USAGE", "stdout=" + r6.out);
  const r7 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "setValue", "--target", "Coupon code", "--value", "DIWALI10", "--tier", "T2"], FAST);
  check("setValue proposal carries the value but its description never does",
    r7.code === 0 && !!e.lastProposal && e.lastProposal.type === "setValue" &&
    e.lastProposal.value === "DIWALI10" && !/DIWALI10/.test(e.lastProposal.description),
    "stdout=" + r7.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r8 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "drag", "--target", "Card A", "--to-target", "Drop zone", "--tier", "T1"], FAST);
  check("drag proposal carries element endpoints",
    r8.code === 0 && !!e.lastProposal && e.lastProposal.type === "drag" &&
    e.lastProposal.dragFrom.label === "Card A" && e.lastProposal.dragTo.label === "Drop zone",
    "stdout=" + r8.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r9 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "drag", "--from-x", "1", "--from-y", "2", "--to-x", "3", "--to-y", "4", "--tier", "T1"], FAST);
  check("drag proposal carries point endpoints",
    r9.code === 0 && !!e.lastProposal && e.lastProposal.dragFrom.point.x === 1 && e.lastProposal.dragTo.point.y === 4,
    "stdout=" + r9.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r10 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "drag", "--target", "Card A", "--tier", "T1"], FAST);
  check("drag without a destination is a USAGE error",
    r10.code !== 0 && JSON.parse(r10.out).error === "USAGE", "stdout=" + r10.out);
  const r11 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "listTabs"], FAST);
  check("listTabs proposal defaults to tier T2",
    r11.code === 0 && !!e.lastProposal && e.lastProposal.type === "listTabs" && e.lastProposal.actionTier === "T2",
    "stdout=" + r11.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r12 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "closeTab", "--tab-id", "42"], FAST);
  check("closeTab proposal carries the tab id",
    r12.code === 0 && !!e.lastProposal && e.lastProposal.type === "closeTab" && e.lastProposal.tabId === 42,
    "stdout=" + r12.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r13 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "closeTab"], FAST);
  check("closeTab without --tab-id is a USAGE error",
    r13.code !== 0 && JSON.parse(r13.out).error === "USAGE", "stdout=" + r13.out);
  const r14 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "openTab", "--url", "https://example.com/x"], FAST);
  check("openTab proposal carries the URL",
    r14.code === 0 && !!e.lastProposal && e.lastProposal.type === "openTab" && e.lastProposal.url === "https://example.com/x",
    "stdout=" + r14.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r15 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "fetch", "--url", "https://academy.example.com/api/me"], FAST);
  check("fetch proposal defaults to T2 and carries method + url",
    r15.code === 0 && !!e.lastProposal && e.lastProposal.type === "fetch" &&
    e.lastProposal.actionTier === "T2" && e.lastProposal.method === "GET" &&
    e.lastProposal.url === "https://academy.example.com/api/me",
    "stdout=" + r15.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r16 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "waitFor", "--wait", "text", "--wait-text", "COURSE COMPLETED", "--timeout", "45000"], FAST);
  check("waitFor proposal carries the condition + bounded timeout",
    r16.code === 0 && !!e.lastProposal && e.lastProposal.type === "waitFor" &&
    e.lastProposal.wait.kind === "text" && e.lastProposal.wait.text === "COURSE COMPLETED" &&
    e.lastProposal.timeoutMs === 45000,
    "stdout=" + r16.out + " proposal=" + JSON.stringify(e.lastProposal));
  const r17 = await runDriver(["--relay", lArg, "--key", key, "act", "--type", "waitFor"], FAST);
  check("waitFor without --wait is a USAGE error",
    r17.code !== 0 && JSON.parse(r17.out).error === "USAGE", "stdout=" + r17.out);
  // watch: the extension pushes media.progress; the driver streams it.
  setTimeout(() => { try { e.ws.send(JSON.stringify({ v: 1, type: "media.progress", tabId: 1, currentTime: 42, duration: 2100, paused: false, ended: false, event: "progress" })); } catch {} }, 500);
  setTimeout(() => { try { e.ws.send(JSON.stringify({ v: 1, type: "media.progress", tabId: 1, currentTime: 52, duration: 2100, paused: false, ended: false, event: "progress" })); } catch {} }, 1100);
  const r18 = await runDriver(["--relay", lArg, "--key", key, "watch", "--duration", "2"], FAST);
  check("watch streams media.progress events without polling",
    r18.code === 0 && r18.out.includes('"media.progress"') && r18.out.includes('"currentTime":42') && r18.out.includes('"duration":2100'),
    "stdout=" + r18.out.slice(0, 300));
  stopExt(e);

  // ------------------------------------------------------------ player memory
  // Two verified play failures on the same player → NOT VERIFIED, and
  // the third attempt is refused LOCALLY (no proposal is even sent).
  const fsx = await import("node:fs");
  const osx = await import("node:os");
  const pathx = await import("node:path");
  const memPath = pathx.join(osx.tmpdir(), `jbb-player-memory-${Date.now()}.json`);
  const MENV = { ...FAST, JBB_PLAYER_MEMORY: memPath };
  const mkey = "media-key-0123456789abcdef";
  const mArg = `ws://127.0.0.1:${(await startRelay()).port}`;
  const mf = await fakeLifecycleExt(Number(new URL(mArg).port), mkey, "mediafail");
  const playArgs = ["--relay", mArg, "--key", mkey, "act", "--type", "media", "--media", "play",
                    "--site", "https://academy.example.com/lesson", "--target", "Lesson video"];
  const p1 = await runDriver(playArgs, MENV);
  const p2 = await runDriver(playArgs, MENV);
  const memAfter2 = JSON.parse(fsx.readFileSync(memPath, "utf8"));
  const gateKey = Object.keys(memAfter2)[0];
  check("two failed plays are recorded against the player",
    p1.code === 0 && p2.code === 0 && !!gateKey && memAfter2[gateKey].fails === 2 &&
    memAfter2[gateKey].lastReason === "autoplay-blocked",
    "mem=" + JSON.stringify(memAfter2));
  const p3 = await runDriver(playArgs, MENV);
  let p3j = null; try { p3j = JSON.parse(p3.out); } catch {}
  check("the third attempt is refused locally as NOT_VERIFIED — no proposal sent, no wait burned",
    p3.code !== 0 && !!p3j && p3j.error === "NOT_VERIFIED" && mf.proposeCount === 2,
    "stdout=" + p3.out + " proposeCount=" + mf.proposeCount);
  stopExt(mf);
  const mo = await fakeLifecycleExt(Number(new URL(mArg).port), mkey, "mediaok");
  const memPath2 = pathx.join(osx.tmpdir(), `jbb-player-memory-ok-${Date.now()}.json`);
  const p4 = await runDriver(playArgs, { ...FAST, JBB_PLAYER_MEMORY: memPath2 });
  const memOk = fsx.existsSync(memPath2) ? JSON.parse(fsx.readFileSync(memPath2, "utf8")) : {};
  check("a verified play leaves no failure record",
    p4.code === 0 && Object.keys(memOk).length === 0, "mem=" + JSON.stringify(memOk));
  stopExt(mo);

  // ------------------------------------------------------------ listen
  const capKey = "capture-key-0123456789abcde";
  const capOut = pathx.join(osx.tmpdir(), `jbb-listen-${Date.now()}.webm`);
  const ce = await fakeLifecycleExt(Number(new URL(mArg).port), capKey, "capture");
  const lr = await runDriver(["--relay", mArg, "--key", capKey, "listen", "--duration", "2", "--out", capOut], FAST);
  let lrj = null; try { lrj = JSON.parse(lr.out); } catch {}
  const fileBytes = fsx.existsSync(capOut) ? fsx.readFileSync(capOut, "utf8") : "";
  check("listen proposes capture, streams chunks to a transcribable file, and stops it",
    lr.code === 0 && !!lrj && lrj.command === "listen" && lrj.chunks === 2 && lrj.bytes === 12 &&
    fileBytes === "CHUNK1CHUNK2" && (ce.stopProposals || 0) === 1,
    "stdout=" + lr.out + " file=" + JSON.stringify(fileBytes) + " stops=" + (ce.stopProposals || 0));
  stopExt(ce);

  // ------------------------------------------------------------ plan
  const planKey = "plan-key-0123456789abcdef01";
  const planFile = pathx.join(osx.tmpdir(), `jbb-plan-${Date.now()}.json`);
  fsx.writeFileSync(planFile, JSON.stringify({
    title: "Two clicks",
    steps: [
      { type: "click", label: "One", site: "https://example.com/a", description: "click one" },
      { type: "click", label: "Two", site: "https://example.com/a", description: "click two" },
    ],
  }));
  const pe = await fakeLifecycleExt(Number(new URL(mArg).port), planKey, "plan");
  const pr = await runDriver(["--relay", mArg, "--key", planKey, "plan", "--file", planFile], FAST);
  let prj = null; try { prj = JSON.parse(pr.out); } catch {}
  check("plan proposes once, then runs its steps under the approval",
    pr.code === 0 && !!prj && prj.command === "plan" && prj.completed === true &&
    prj.steps.length === 2 && prj.steps.every((s) => s.ok) && pe.proposeCount === 2,
    "stdout=" + pr.out + " proposes=" + pe.proposeCount);
  stopExt(pe);
  const pd = await fakeLifecycleExt(Number(new URL(mArg).port), planKey, "plandeny");
  const pdr = await runDriver(["--relay", mArg, "--key", planKey, "plan", "--file", planFile], FAST);
  check("a denied plan runs nothing and exits PLAN_DENIED",
    pdr.code === 1 && pdr.out.includes("PLAN_DENIED") && pd.proposeCount === 0,
    "stdout=" + pdr.out + " proposes=" + pd.proposeCount);
  stopExt(pd);
}
{
  // No extension pairs at all: observe must fail fast with PEER_DOWN
  // (field fix 2026-11-10) instead of burning the full observe timeout
  // to report PEER_TIMEOUT for a room known empty at pair time.
  const key = "peerdown-key-0123456789abcde";
  const started = Date.now();
  const r = await runDriver(["--relay", lArg, "--key", key, "observe"],
    { ...FAST, JBB_PEER_WAIT_MS: "300", JBB_OBSERVE_MS: "30000" });
  const j = parseStdout(r.out);
  check("observe with no extension paired fails fast as PEER_DOWN, not PEER_TIMEOUT",
    r.code !== 0 && !!j && j.ok === false && j.error === "PEER_DOWN" && (Date.now() - started) < 10000 &&
    /wrong key/.test(j.message || ""),
    "code=" + r.code + " stdout=" + r.out.slice(0, 200) + " elapsed=" + (Date.now() - started));
}
{
  // Fix 7: an empty first observe is retried once inside the driver.
  const key = "emptyobs-key-0123456789abcdef";
  const e = await fakeLifecycleExt(L.port, key, "observeEmptyFirst");
  const r = await runDriver(["--relay", lArg, "--key", key, "observe"], FAST);
  const j = parseStdout(r.out);
  check("observe retrying an empty first snapshot returns the full page",
    r.code === 0 && !!j && j.snapshot && (j.snapshot.text || "").includes("full page text"),
    "stdout=" + r.out.slice(0, 300));
  check("the empty observe was retried (two observe.requests reached the extension)",
    e.observeCount === 2, "observeCount=" + e.observeCount);
  stopExt(e);
}
{
  // Fix 12/14/16: status asks the extension and reports pending proposals,
  // key epoch + expiry, and the sign-in block.
  const key = "statusrep-key-0123456789abcdef";
  const e = await fakeLifecycleExt(L.port, key, "statusReport");
  const r = await runDriver(["--relay", lArg, "--key", key, "status"], FAST);
  const j = parseStdout(r.out);
  check("status with a live extension reports pending proposals + key epoch + sign-in block",
    r.code === 0 && !!j && j.extension && j.extension.pending.length === 1 &&
    j.extension.pending[0].label === "Segment View" && j.extension.pending[0].ageSec === 45 &&
    j.extension.keyEpoch === 3 && j.extension.signinBlocked === true &&
    j.extension.signinEmail === "user@example.com",
    "stdout=" + r.out.slice(0, 500));
  stopExt(e);
}
{
  // Fix 12: cancel withdraws a queued proposal.
  const key = "cancel-key-0123456789abcdef";
  const e = await fakeLifecycleExt(L.port, key, "cancelAck");
  const r = await runDriver(["--relay", lArg, "--key", key, "cancel", "--proposal-id", "prop-7"], FAST);
  const j = parseStdout(r.out);
  check("cancel exits 0 with the withdrawal detail",
    r.code === 0 && !!j && j.ok === true && j.command === "cancel" && /will not apply/.test(j.detail || ""),
    "stdout=" + r.out);
  stopExt(e);
}
L.httpServer.close();

console.log(failures === 0 ? "ALL DRIVER TESTS PASSED" : failures + " DRIVER TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
