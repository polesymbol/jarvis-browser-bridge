/**
 * Session-summary test — loads the REAL background.js in a vm, runs a
 * small session (pair → granted click → whitelist type → denied scroll →
 * navigate), ends it from the panel, and checks the summary.
 * Run: node extension/test/session-summary.test.mjs
 *
 * Proves:
 *  - audit entries for finished actions carry type / proposalId / via;
 *  - End session builds the summary once: counts per action type and
 *    per site, the denials listed, a plain-language sentence — stored
 *    on-machine for the panel;
 *  - a second End with no live session builds nothing.
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
let uiListener = null;
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
    onMessage: { addListener: (fn) => { uiListener = fn; } },
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
    query: () => Promise.resolve([{ id: 1, windowId: 1, url: "https://example.com/page", active: true }]),
    get: () => Promise.resolve({ id: 1, windowId: 1, url: "https://example.com/page" }),
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

function ui(msg) {
  return new Promise((resolve) => {
    const ret = uiListener(msg, {}, (res) => resolve(res));
    if (ret !== true) setTimeout(() => resolve(undefined), 60);
  }).then(async (r) => { await tick(30); return r; });
}
const P = (over) => Object.assign({
  proposalId: "s-x", actionTier: "T1", type: "click",
  target: { ref: "f0:e1", label: "X" },
  site: "https://example.com/page", description: "click 'X'",
}, over);
async function propose(over) {
  sandbox.handleProposal(P(over), "relay");
  await tick(70);
}

// --- session opens at pairing
sandbox.handleRelayMessage(JSON.stringify({ v: 1, type: "pair.confirm", protocol: 1 }));
await tick(40);
check("pairing opens the session window", sandbox.state.sessionStartedAt > 0);

// --- 1) consent-granted click
await propose({ proposalId: "s-1" });
sandbox.state.pending.get("s-1").resolve({ choice: "once" });
await tick(100);
// --- 2) whitelist-auto type
await ui({ kind: "jbb.ui.addWhitelist", domain: "example.com" });
await propose({ proposalId: "s-2", type: "type", description: "type into 'Search'" });
check("whitelist action auto-allowed (no prompt)", !sandbox.state.pending.has("s-2"));
// --- 3) user-denied scroll
await propose({ proposalId: "s-3", type: "scroll", site: "https://other.com/x", description: "scroll down" });
sandbox.state.pending.get("s-3").resolve({ choice: "deny" });
await tick(80);
// --- 4) navigate (auto-allowed too: the whitelist entry covers it)
await propose({ proposalId: "s-4", type: "navigate", url: "https://example.com/other", description: "open the other page" });
check("navigate auto-allowed by the same whitelist entry", !sandbox.state.pending.has("s-4"));
await tick(80);

// --- audit entries carry the feed fields
const auditLog = store["jbb.audit"] || [];
const wlEntry = auditLog.find((e) => e.proposalId === "s-2" && e.result === "executed");
check("executed whitelist entry carries type + via=whitelist",
  !!wlEntry && wlEntry.type === "type" && wlEntry.via === "whitelist");

// --- end the session from the panel
const res = await ui({ kind: "jbb.ui.endSession" });
const s = res && res.summary;
check("End session returns a summary", !!s);
check("counts: 3 executed (click + type + navigate)",
  !!s && s.executed === 3 && s.byType.click === 1 && s.byType.type === 1 && s.byType.navigate === 1);
check("per-site counts", !!s && s.bySite["example.com"] === 3);
check("the denial is listed", !!s && s.denied.length === 1 && /scroll/.test(s.denied[0].action));
check("plain-language sentence with real counts",
  !!s && /opened 1 page/.test(s.sentence) && /clicked 1 time/.test(s.sentence) && /1 action was denied or blocked/.test(s.sentence));
check("summary persisted on-machine for the panel",
  !!store["jbb.lastSummary"] && store["jbb.lastSummary"].executed === 3);

// --- ending again with no live session builds nothing new
const res2 = await ui({ kind: "jbb.ui.endSession" });
check("second End with no live session returns no summary", !!res2 && !res2.summary);

console.log(failures === 0 ? "ALL SESSION SUMMARY TESTS PASSED" : failures + " SUMMARY CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
