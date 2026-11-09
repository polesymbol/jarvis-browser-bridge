// Driver CLI contract tests — run: node driver/test/driver.cli.test.mjs
// Pins the output contract downstream tooling relies on:
//   * stdout is NEVER empty; failures are {"ok":false,"error","message"}
//     on stdout with a non-zero exit code.
//   * --key is always the connector key; a keypress travels in --press-key.
//   * `status` prints peerConnected / workerAlive / pendingProposals /
//     sessionTimeRemaining as JSON.
// No external services: a real relay on an ephemeral port + a fake extension.
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

function runDriver(args, envOverrides = {}, timeoutMs = 20000) {
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

// Fake extension: pairs, then (in active mode) grants act proposals and
// reports a result echoing the pressed key. Proposals are captured so the
// test can prove the keypress name arrived as proposal.key and pairing used
// the real connector key (same room = same key hash at the relay).
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

const { httpServer } = createRelay(0);
await new Promise((r) => httpServer.on("listening", r));
const port = httpServer.address().port;
const relayArg = `ws://127.0.0.1:${port}`;

// --- help: valid JSON, no key required, documents --press-key -------------
{
  const r = await runDriver(["--help"]);
  const j = parseStdout(r.out);
  check("help exits 0 with JSON usage mentioning --press-key",
    r.code === 0 && !!j && j.ok === true && JSON.stringify(j).includes("--press-key"));
}

// --- missing / empty KEY ---------------------------------------------------
{
  const r = await runDriver(["--relay", relayArg, "observe"], { KEY: "" });
  const j = parseStdout(r.out);
  check("KEY= observe exits non-zero", r.code !== 0, "code=" + r.code);
  check("KEY= observe stdout is non-empty error JSON",
    r.out.trim().length > 0 && !!j && j.ok === false && j.error === "KEY_MISSING" && typeof j.message === "string",
    "stdout=" + JSON.stringify(r.out));
}

// --- short KEY -------------------------------------------------------------
{
  const r = await runDriver(["--relay", relayArg, "--key", "short", "observe"]);
  const j = parseStdout(r.out);
  check("short --key exits non-zero with KEY_INVALID JSON",
    r.code !== 0 && !!j && j.ok === false && j.error === "KEY_INVALID" && r.out.trim().length > 0);
}

// --- missing command --------------------------------------------------------
{
  const r = await runDriver(["--relay", relayArg, "--key", KEY]);
  const j = parseStdout(r.out);
  check("no command exits non-zero with USAGE JSON",
    r.code !== 0 && !!j && j.ok === false && j.error === "USAGE" && r.out.trim().length > 0);
}

// --- unreachable relay -------------------------------------------------------
{
  const dead = await closedPort();
  const r = await runDriver(["--relay", `ws://127.0.0.1:${dead}`, "--key", KEY, "observe"]);
  const j = parseStdout(r.out);
  check("unreachable relay exits non-zero with RELAY_UNREACHABLE JSON",
    r.code !== 0 && !!j && j.ok === false && j.error === "RELAY_UNREACHABLE" && r.out.trim().length > 0);
}

// --- status with no peer -----------------------------------------------------
{
  const r = await runDriver(["--relay", relayArg, "--key", STATUS_KEY, "status"]);
  const j = parseStdout(r.out);
  check("status (no peer) exits 0 with the four fields",
    r.code === 0 && !!j && j.ok === true && j.peerConnected === "no" && j.workerAlive === "no" &&
    j.pendingProposals === 0 && j.sessionTimeRemaining === null,
    "stdout=" + r.out);
}

// --- status error paths still carry the four fields -------------------------
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

// --- peer-backed checks ------------------------------------------------------
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
  check("act --type key --press-key Enter exits 0 with act.result JSON",
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
  // abort must also honour the never-empty-stdout contract. Runs last: the
  // relay tears the room down on session.abort.
  const r = await runDriver(["--relay", relayArg, "--key", KEY, "abort"]);
  const j = parseStdout(r.out);
  check("abort exits 0 with non-empty JSON on stdout",
    r.code === 0 && !!j && j.ok === true && r.out.trim().length > 0, "stdout=" + JSON.stringify(r.out));
}

try { ext.ws.close(); } catch {}
httpServer.close();
console.log(failures === 0 ? "ALL DRIVER TESTS PASSED" : failures + " DRIVER TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
