// Relay key-revocation tests — run: node relay/test.revocation.mjs
// Rotation semantics at the relay:
//   * only the extension, only for its own room's key, can revoke;
//   * the connected driver gets an explicit key.rotated notice and the
//     room is torn down;
//   * later pair attempts with the revoked key get pair.error KEY_ROTATED
//     (never a silent lonely room);
//   * a fresh key pairs and works normally.
import WebSocket from "ws";
import { createRelay } from "./server.js";

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok || !extra ? "" : " — " + extra));
  if (!ok) failures++;
}

const { httpServer } = createRelay(0);
await new Promise((r) => httpServer.on("listening", r));
const port = httpServer.address().port;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function collect(ws) {
  const msgs = [];
  const waiters = [];
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i !== -1) { const [w] = waiters.splice(i, 1); w.resolve(m); }
    else msgs.push(m);
  });
  return {
    next(type, ms = 3000) {
      const i = msgs.findIndex((m) => m.type === type);
      if (i !== -1) return Promise.resolve(msgs.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error("timeout waiting for " + type)), ms);
      });
    },
  };
}
async function pair(key, role) {
  const ws = await connect();
  const c = collect(ws);
  ws.send(JSON.stringify({ v: 1, type: "pair.request", role, key }));
  return { ws, c };
}
const closed = (ws) => new Promise((r) => ws.on("close", r));

const RK = "rotate-key-0123456789abcdef";
const FK = "fresh-key-0123456789abcdef0";

// --- a driver cannot revoke (wrong role): message dropped, key stays valid
{
  const ext = await pair(RK, "extension");
  await ext.c.next("pair.confirm");
  const drv = await pair(RK, "driver");
  await drv.c.next("pair.confirm");
  drv.ws.send(JSON.stringify({ v: 1, type: "key.revoked", key: RK }));
  await new Promise((r) => setTimeout(r, 250));
  // Room is intact: a replacement driver still pairs with a confirm.
  const drv2 = await pair(RK, "driver");
  const conf = await drv2.c.next("pair.confirm");
  check("driver-sent key.revoked is ignored (no pair.error, room intact)", conf.peer === true);
  drv2.ws.close();
  // Re-pair the original driver slot for the real revocation below.
  var mainDrv = await pair(RK, "driver");
  await mainDrv.c.next("pair.confirm");
  var mainExt = ext;
}

// --- the extension revokes: driver is told, room torn down
{
  const drvClosed = closed(mainDrv.ws);
  const extClosed = closed(mainExt.ws);
  mainExt.ws.send(JSON.stringify({ v: 1, type: "key.revoked", key: RK }));
  const notice = await mainDrv.c.next("key.rotated");
  check("connected driver receives key.rotated notice", notice.type === "key.rotated");
  await Promise.race([drvClosed, new Promise((r) => setTimeout(r, 2000))]);
  await Promise.race([extClosed, new Promise((r) => setTimeout(r, 2000))]);
  check("room torn down on revocation (both sockets closed)",
    mainDrv.ws.readyState !== 1 && mainExt.ws.readyState !== 1);
}

// --- late pair with the revoked key: explicit pair.error, not silence
{
  const late = await connect();
  const c = collect(late);
  const lc = closed(late);
  late.send(JSON.stringify({ v: 1, type: "pair.request", role: "driver", key: RK }));
  const err = await c.next("pair.error");
  check("revoked key pair attempt -> pair.error KEY_ROTATED",
    err.error === "KEY_ROTATED" && err.message === "key rotated — pair again",
    JSON.stringify(err));
  await Promise.race([lc, new Promise((r) => setTimeout(r, 2000))]);
  check("revoked pair attempt socket is closed by the relay", late.readyState !== 1);
}

// --- a fresh key pairs and works
{
  const ext = await pair(FK, "extension");
  const c1 = await ext.c.next("pair.confirm");
  const drv = await pair(FK, "driver");
  const c2 = await drv.c.next("pair.confirm");
  check("fresh key pairs (peer sees each other)", c1.peer === false && c2.peer === true);
  drv.ws.send(JSON.stringify({ v: 1, type: "observe.request", id: "o1" }));
  const got = await ext.c.next("observe.request");
  check("fresh key room forwards messages", got.id === "o1");
  ext.ws.close(); drv.ws.close();
}

httpServer.close();
console.log(failures === 0 ? "ALL REVOCATION TESTS PASSED" : failures + " REVOCATION TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
