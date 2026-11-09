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
      if (m.type === "pair.confirm") { resolve(state); return; }
      if (m.type !== "act.propose" && m.type !== "observe.request") return;
      const send = (o) => { try { ws.send(JSON.stringify({ v: 1, ...o })); } catch {} };
      const after = (ms, fn) => { state.timers.push(setTimeout(fn, ms)); };
      if (m.type === "observe.request") {
        state.lastObserve = m;
        send({ type: "observe.result", id: m.id, snapshotVersion: 5,
          snapshot: { title: "Long page", text_chunk: "tail chunk — COURSE COMPLETED",
            text_offset: m.textOffset || 0, text_total_chars: 31234, text_next_offset: null } });
        return;
      }
      state.proposeCount++;
      state.lastProposal = m.proposal;
      const pid = m.id;
      send({ type: "proposal.received", proposalId: pid });
      if (mode === "notshown") return; // received, but no prompt ever appears
      after(30, () => send({ type: "consent.shown", proposalId: pid, via: "panel" }));
      if (mode === "grant") {
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
    j.message === "key rotated — pair again",
    "stdout=" + r.out);
  stopExt(e);
  // And pairing with the rotated key afterwards is refused explicitly,
  // distinct from a wrong key (which would pair into a lonely room).
  const r2 = await runDriver(["--relay", lArg, "--key", key, "status"], FAST);
  const j2 = parseStdout(r2.out);
  check("pairing with a rotated key -> KEY_ROTATED plus status fields",
    r2.code !== 0 && !!j2 && j2.ok === false && j2.error === "KEY_ROTATED" &&
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
  stopExt(e);
}
L.httpServer.close();

console.log(failures === 0 ? "ALL DRIVER TESTS PASSED" : failures + " DRIVER TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
