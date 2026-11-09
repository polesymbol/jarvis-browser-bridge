/**
 * Per-site whitelist test — loads the REAL background.js in a vm with a
 * stubbed chrome.* surface.
 * Run: node extension/test/whitelist.test.mjs
 *
 * Proves the acceptance criteria from the whitelist brief:
 *  - "Always allow on this site" writes a tier-scoped, schema-versioned,
 *    key-epoch-bound entry; later same-tier actions on that exact domain
 *    stop prompting (across the persisted store, not just in memory);
 *  - the audit record names the whitelist ("allowed by whitelist: <domain>");
 *  - a T3 action on the same whitelisted site STILL asks (hard carve-out);
 *  - a subdomain (lookalike) does NOT inherit the grant;
 *  - other tiers and action types added later are NOT covered;
 *  - a stale schemaVersion or a rotated key epoch stops coverage;
 *  - rotating the key wipes the entries outright.
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
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 40));

const store = {};
const sent = [];
const chrome = {
  storage: { local: {
    get(keys, cb) {
      const out = {};
      const list = keys == null ? Object.keys(store) : typeof keys === "string" ? [keys] : keys;
      list.forEach((k) => { if (store[k] !== undefined) out[k] = clone(store[k]); });
      setTimeout(() => cb(out), 0);
    },
    set(obj, cb) { Object.keys(obj).forEach((k) => { store[k] = clone(obj[k]); }); if (cb) setTimeout(cb, 0); },
    remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete store[k]; }); if (cb) setTimeout(cb, 0); },
  } },
  runtime: {
    lastError: null,
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    sendMessage: (msg) => { sent.push(msg); return Promise.resolve({}); },
    getURL: (p) => "chrome-extension://test/" + p,
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, onClicked: { addListener: () => {} } },
  notifications: { create: (id, opts, cb) => { if (cb) cb(); }, clear: () => {},
    getAll: (cb) => cb({}), onButtonClicked: { addListener: () => {} },
    onClicked: { addListener: () => {} }, onClosed: { addListener: () => {} } },
  permissions: { request: () => Promise.resolve(true), contains: () => Promise.resolve(false),
    remove: () => Promise.resolve(true) },
  tabs: {
    query: () => Promise.resolve([{ id: 1, windowId: 1, url: "https://example.com/", active: true }]),
    get: () => Promise.resolve({ id: 1, windowId: 1, url: "https://example.com/" }),
    sendMessage: () => Promise.resolve({ ok: true, detail: "clicked 'X'" }),
    update: () => Promise.resolve({}),
    captureVisibleTab: () => Promise.resolve("data:,"),
    onActivated: { addListener: () => {} }, onUpdated: { addListener: () => {} },
  },
  scripting: { executeScript: () => Promise.resolve([{ result: true }]) },
  offscreen: { hasDocument: (cb) => cb(true), createDocument: (o, cb) => { if (cb) cb(); },
               getContexts: () => Promise.resolve([{}]), closeDocument: () => Promise.resolve() },
  sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() },
  commands: { onCommand: { addListener: () => {} } },
  identity: { getProfileUserInfo: (cb) => cb({ email: "" }) },
};
const sandbox = {
  chrome, console, URL, Date, JSON, Math, Promise, Uint8Array, ArrayBuffer,
  setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: globalThis.crypto,
  WebSocket: class { constructor() { throw new Error("worker must not dial"); } },
  importScripts: () => {},
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(protoSrc, sandbox, { filename: "protocol.js" });
vm.runInContext(bgSrc, sandbox, { filename: "background.js" });
await tick(80);

const P = (over) => Object.assign({
  proposalId: "w-x", actionTier: "T1", type: "click",
  target: { ref: "f0:e1", label: "X" },
  site: "https://example.com/page", description: "click 'X'",
}, over);
function relaySends() {
  return sent.filter((m) => m && m.kind === "jbb.relay.send")
    .map((m) => { try { return JSON.parse(m.data); } catch { return null; } })
    .filter(Boolean);
}
async function propose(over) {
  const p = P(over);
  sandbox.handleProposal(p, "relay");
  await tick(60);
  return p;
}

// --- first T1 action on the site asks
await propose({ proposalId: "w-1" });
check("first T1 action on an unknown site asks", sandbox.state.pending.has("w-1"));

// --- "Always allow on this site" writes the entry and executes
sandbox.state.pending.get("w-1").resolve({ choice: "whitelist" });
await tick(120);
const entry = (store["jbb.whitelist"] || {})["example.com"];
check("whitelist entry persisted for the exact domain",
  !!entry && entry.domain === "example.com");
check("entry is tier-scoped (T1), schema-versioned, and bound to the key epoch",
  !!entry && JSON.stringify(entry.tiers) === '["T1"]' && entry.schemaVersion === 1 &&
  entry.keyId === sandbox.state.keyEpoch && entry.actions.includes("click"));
const r1 = relaySends().find((m) => m.type === "act.result" && m.proposalId === "w-1");
check("the granted action executed", !!r1 && r1.ok === true);

// --- the same action no longer prompts, and the audit says why
sent.length = 0;
await propose({ proposalId: "w-2" });
check("second T1 click on the whitelisted site does NOT prompt",
  !sandbox.state.pending.has("w-2"));
const r2 = relaySends().find((m) => m.type === "act.result" && m.proposalId === "w-2");
check("auto-allowed action executed", !!r2 && r2.ok === true);
const auditText = JSON.stringify(store["jbb.audit"] || []);
check("audit record names the whitelist and the exact domain",
  auditText.includes("allowed by whitelist: example.com"));

// --- T3 on the same site STILL asks (hard carve-out)
await propose({ proposalId: "w-3", actionTier: "T3", description: "pay now" });
check("T3 action on the whitelisted site still asks",
  sandbox.state.pending.has("w-3"));
sandbox.state.pending.get("w-3").resolve({ choice: "deny" });
await tick(60);

// --- a lookalike subdomain does not inherit
await propose({ proposalId: "w-4", site: "https://sub.example.com/page" });
check("subdomain does not inherit the grant (asks)",
  sandbox.state.pending.has("w-4"));
sandbox.state.pending.get("w-4").resolve({ choice: "deny" });
await tick(60);

// --- tier and type coverage are exact
await propose({ proposalId: "w-5", actionTier: "T2" });
check("T2 action is not covered by a T1 entry (asks)",
  sandbox.state.pending.has("w-5"));
sandbox.state.pending.get("w-5").resolve({ choice: "deny" });
await tick(60);
await propose({ proposalId: "w-6", type: "teleport" });
check("an action type not in the entry's list is not covered (asks)",
  sandbox.state.pending.has("w-6"));
sandbox.state.pending.get("w-6").resolve({ choice: "deny" });
await tick(60);

// --- stale schema / rotated epoch stop coverage
sandbox.state.whitelist["example.com"].schemaVersion = 0;
await propose({ proposalId: "w-7" });
check("an entry from an older schemaVersion asks again",
  sandbox.state.pending.has("w-7"));
sandbox.state.pending.get("w-7").resolve({ choice: "deny" });
await tick(60);
sandbox.state.whitelist["example.com"].schemaVersion = 1;
sandbox.state.keyEpoch = 99;
await propose({ proposalId: "w-8" });
check("an entry bound to a previous key epoch asks again",
  sandbox.state.pending.has("w-8"));
sandbox.state.pending.get("w-8").resolve({ choice: "deny" });
await tick(60);
sandbox.state.keyEpoch = 1;

// --- rotation wipes the entries outright
await new Promise((res) => sandbox.rotateConnectorKey(res));
await tick(700);
check("rotating the key wipes the whitelist store",
  store["jbb.whitelist"] === undefined && Object.keys(sandbox.state.whitelist).length === 0);

console.log(failures === 0 ? "ALL WHITELIST TESTS PASSED" : failures + " WHITELIST CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
