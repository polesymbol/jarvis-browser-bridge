/**
 * Key-expiry tests — loads the REAL background.js in a vm with a stubbed
 * chrome.* surface (same harness shape as pending.persistence.test.mjs).
 * Run: node extension/test/keyexpiry.test.mjs
 *
 * Proves the v0.2.33 expiry contract:
 *  - a key whose lifetime elapsed retires when NO driver is connected:
 *    key + meta + usage wiped, KEYEXPIRED recorded, ephemeral grants
 *    dropped — and the whitelist SURVIVES (expiry is hygiene; rotation
 *    is distrust and still wipes it — also asserted here);
 *  - a deadline that passes MID-TASK only arms; the peer.left disconnect
 *    is the boundary where it fires;
 *  - a pre-expiry key (no meta) never expires;
 *  - the big-task budget (cumulative connected time) retires a key whose
 *    lifetime is "never";
 *  - a deadline that passed while the browser was closed pairs briefly
 *    to poison the room (key.revoked) before wiping, so a late driver
 *    gets KEY_ROTATED instead of silence.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bgSrc = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const protoSrc = fs.readFileSync(path.join(dir, "../protocol.js"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));

function boot(store) {
  const sent = [];
  const listeners = { alarm: [], startup: [] };
  const chrome = {
    storage: { local: {
      get(keys, cb) {
        const out = {};
        const list = keys == null ? Object.keys(store)
          : typeof keys === "string" ? [keys] : keys;
        list.forEach((k) => { if (store[k] !== undefined) out[k] = clone(store[k]); });
        setTimeout(() => cb(out), 0);
      },
      set(obj, cb) {
        Object.keys(obj).forEach((k) => { store[k] = clone(obj[k]); });
        if (cb) setTimeout(cb, 0);
      },
      remove(keys, cb) {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete store[k]; });
        if (cb) setTimeout(cb, 0);
      },
    } },
    runtime: {
      lastError: null,
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve({}); },
      getURL: (p) => "chrome-extension://test/" + p,
    },
    alarms: { create: () => {}, onAlarm: { addListener: (fn) => listeners.alarm.push(fn) } },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {},
              onClicked: { addListener: () => {} } },
    notifications: { create: (id, opts, cb) => { if (cb) cb(); }, clear: () => {},
      getAll: (cb) => cb({}), onButtonClicked: { addListener: () => {} },
      onClicked: { addListener: () => {} }, onClosed: { addListener: () => {} } },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: "https://example.com/", active: true }]),
      get: () => Promise.resolve({ id: 1, url: "https://example.com/" }),
      sendMessage: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      captureVisibleTab: () => Promise.resolve("data:,"),
      onActivated: { addListener: () => {} }, onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    scripting: { executeScript: () => Promise.resolve([{ result: true }]) },
    offscreen: { hasDocument: (cb) => cb(true),
                 createDocument: (opts, cb) => { if (cb) cb(); },
                 closeDocument: () => Promise.resolve() },
    sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() },
    commands: { onCommand: { addListener: () => {} } },
    identity: { getProfileUserInfo: (cb) => cb({ email: "" }) },
    permissions: { contains: (o, cb) => cb(false) },
  };
  const sandbox = {
    chrome, console, URL, Date, JSON, Math, Promise, Uint8Array, ArrayBuffer,
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto,
    WebSocket: class { constructor() { throw new Error("worker must not dial"); } },
    importScripts: () => {},
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(protoSrc, sandbox, { filename: "protocol.js" });
  vm.runInContext(bgSrc, sandbox, { filename: "background.js" });
  // loadPersisted hangs off onStartup/onInstalled in the real worker.
  listeners.startup.forEach((fn) => fn());
  return { ctx: sandbox, sent, listeners };
}

const KEY = "jbb_" + "a".repeat(64);
const HOUR = 3600 * 1000;
function baseStore(extra) {
  return Object.assign({
    "jbb.connectorKey": KEY,
    "jbb.keyMeta": { createdAt: Date.now() - 25 * HOUR, ttlMs: 24 * HOUR }, // due an hour ago
    "jbb.keyUsage": { connectedMs: 0, acts: 3 },
    "jbb.session": { site: "example.com", grantedAt: Date.now(), expiresAt: Date.now() + HOUR, label: "1h", epoch: 1 },
    "jbb.whitelist": { "example.com": { domain: "example.com", tiers: ["T1"], actions: ["click"],
                       grantedAt: Date.now(), lastUsedAt: Date.now(), keyId: 1, schemaVersion: 1 } },
    "jbb.settings": { mode: "balanced", relayUrl: "", killed: false, soundOn: false },
  }, extra || {});
}

// ------------------------------------------------- 1. due, no peer, no relay URL: retires at once
{
  const store = baseStore();
  const w = boot(store);
  await tick(200);
  check("due key with no driver retires: key wiped", store["jbb.connectorKey"] === undefined);
  check("meta + usage wiped with it", store["jbb.keyMeta"] === undefined && store["jbb.keyUsage"] === undefined);
  check("KEYEXPIRED recorded with the reason",
    !!store["jbb.keyExpired"] && /lifetime/.test(store["jbb.keyExpired"].reason || ""));
  check("session grant dropped", store["jbb.session"] === undefined);
  check("whitelist SURVIVES expiry", !!store["jbb.whitelist"] && !!store["jbb.whitelist"]["example.com"]);
  check("expiry audited", (store["jbb.audit"] || []).some((e) => e.result === "expired"));
}

// ------------------------------------------------- 2. due mid-task: arms only; peer.left fires it
{
  const store = baseStore();
  const w = boot(store);
  w.ctx.state.peerPresent = true;           // a driver is mid-task before loadPersisted's check lands
  w.ctx.state.peerSince = Date.now();
  await tick(200);
  check("mid-task deadline only ARMS (key still stored)", store["jbb.connectorKey"] === KEY);
  check("armed reason recorded", typeof w.ctx.state.keyExpiryArmed === "string");
  check("arming audited once", (store["jbb.audit"] || []).filter((e) => e.result === "expiring").length === 1);
  w.ctx.handleRelayMessage(JSON.stringify({ v: 1, type: "peer.left", role: "driver" }));
  await tick(250);
  check("the disconnect fires the armed expiry", store["jbb.connectorKey"] === undefined && !!store["jbb.keyExpired"]);
}

// ------------------------------------------------- 3. legacy key (no meta): never expires
{
  const store = baseStore();
  delete store["jbb.keyMeta"];
  const w = boot(store);
  await tick(200);
  w.ctx.checkKeyExpiry();
  await tick(120);
  check("pre-expiry key (no meta) is untouched", store["jbb.connectorKey"] === KEY && store["jbb.keyExpired"] === undefined);
}

// ------------------------------------------------- 4. big-task budget retires a never-expiring key
{
  const store = baseStore({
    "jbb.keyMeta": { createdAt: Date.now(), ttlMs: 0 },
    "jbb.keyUsage": { connectedMs: 5 * HOUR, acts: 0 },
  });
  const w = boot(store);
  await tick(200);
  check("5h cumulative connected time retires the key",
    store["jbb.connectorKey"] === undefined && /big-task budget/.test((store["jbb.keyExpired"] || {}).reason || ""));
}

// ------------------------------------------------- 5. deadline passed while closed: pair-to-revoke poison flow
{
  const store = baseStore({
    "jbb.settings": { mode: "balanced", relayUrl: "wss://relay.example", killed: false, soundOn: false },
  });
  const w = boot(store);
  await tick(200);
  check("offline expiry enters the pair-to-revoke flow", w.ctx.state.pendingRevoke === true);
  check("key not yet wiped (revocation goes first)", store["jbb.connectorKey"] === KEY);
  w.ctx.handleRelayMessage(JSON.stringify({ v: 1, type: "pair.confirm", role: "extension", peer: false }));
  await tick(700);
  const revokedSent = w.sent.some((m) => m && m.kind === "jbb.relay.send" &&
    typeof m.data === "string" && m.data.includes('"key.revoked"') && m.data.includes(KEY));
  check("key.revoked for the dead key went out on the paired socket", revokedSent);
  check("after the beat: key wiped + KEYEXPIRED set",
    store["jbb.connectorKey"] === undefined && !!store["jbb.keyExpired"]);
}

// ------------------------------------------------- 6. rotation still wipes everything + stamps the new key's meta
{
  const store = baseStore({
    "jbb.keyMeta": { createdAt: Date.now(), ttlMs: 24 * HOUR },
  });
  const w = boot(store);
  await tick(120);
  await new Promise((resolve) => w.ctx.rotateConnectorKey(() => resolve(), 7 * 24 * HOUR));
  await tick(150);
  check("rotation stores a NEW key", !!store["jbb.connectorKey"] && store["jbb.connectorKey"] !== KEY);
  check("rotation stamps the chosen lifetime on the successor",
    !!store["jbb.keyMeta"] && store["jbb.keyMeta"].ttlMs === 7 * 24 * HOUR);
  check("rotation zeroes the usage budget",
    !!store["jbb.keyUsage"] && store["jbb.keyUsage"].acts === 0 && store["jbb.keyUsage"].connectedMs === 0);
  check("rotation still WIPES the whitelist (distrust != hygiene)", store["jbb.whitelist"] === undefined);
}

console.log(failures === 0 ? "ALL KEY-EXPIRY TESTS PASSED" : failures + " KEY-EXPIRY CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
