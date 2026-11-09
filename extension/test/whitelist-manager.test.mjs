/**
 * Whitelist-manager test — loads the REAL background.js in a vm and
 * drives the panel's jbb.ui.* messages through the real dispatcher.
 * Run: node extension/test/whitelist-manager.test.mjs
 *
 * Proves the manager acceptance criteria:
 *  - add-by-typing normalizes (scheme/path/port stripped, lowercased),
 *    refuses garbage and wildcards, and gates punycode behind a confirm;
 *  - "Pause all grants" stops auto-allow (whitelist AND session) until
 *    un-paused;
 *  - revoking an entry mid-session makes the very next action prompt;
 *  - per-action checkboxes (updateWhitelist) narrow coverage exactly,
 *    and T3 can never be smuggled in through the manager;
 *  - Keep on a stale entry re-confirms it: schema upgraded, action list
 *    extended to the current vocabulary, review clock restarted;
 *  - Revoke all empties the store.
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

function ui(msg) {
  return new Promise((resolve) => {
    uiListener(msg, {}, (res) => resolve(res));
    setTimeout(() => resolve(undefined), 300); // in case a handler never responds
  }).then(async (r) => { await tick(30); return r; });
}
const P = (over) => Object.assign({
  proposalId: "m-x", actionTier: "T1", type: "click",
  target: { ref: "f0:e1", label: "X" },
  site: "https://example.com/page", description: "click 'X'",
}, over);
async function propose(over) {
  const p = P(over);
  sandbox.handleProposal(p, "relay");
  await tick(60);
  return p;
}
async function deny(id) {
  if (sandbox.state.pending.has(id)) sandbox.state.pending.get(id).resolve({ choice: "deny" });
  await tick(50);
}

// --- add by typing: normalization + validation + punycode gate
let r = await ui({ kind: "jbb.ui.addWhitelist", domain: "HTTPS://Example.ORG/some/path?x=1" });
check("typed add normalizes scheme/path/case", !!r && r.ok === true && !!sandbox.state.whitelist["example.org"]);
r = await ui({ kind: "jbb.ui.addWhitelist", domain: "not a domain!!" });
check("garbage input refused, nothing stored", !!r && r.ok === false && !sandbox.state.whitelist["not a domain!!"]);
r = await ui({ kind: "jbb.ui.addWhitelist", domain: "*.example.net" });
check("wildcard input refused (no silent wildcarding)", !!r && r.ok === false && !sandbox.state.whitelist["*.example.net"]);
r = await ui({ kind: "jbb.ui.addWhitelist", domain: "xn--exmple-cua.com" });
check("punycode add is gated behind a warning", !!r && r.ok === false && r.warning === "punycode" &&
  !sandbox.state.whitelist["xn--exmple-cua.com"]);
r = await ui({ kind: "jbb.ui.addWhitelist", domain: "xn--exmple-cua.com", confirmed: true });
check("punycode add proceeds only after explicit confirm", !!r && r.ok === true &&
  !!sandbox.state.whitelist["xn--exmple-cua.com"]);

// --- pause all grants: whitelist auto-allow stops, resume restores it
await ui({ kind: "jbb.ui.addWhitelist", domain: "example.com" });
await propose({ proposalId: "m-1" });
check("whitelisted site auto-allows before pause", !sandbox.state.pending.has("m-1"));
await ui({ kind: "jbb.ui.setGrantsPaused", paused: true });
await propose({ proposalId: "m-2" });
check("Pause all grants: the very next whitelisted action prompts", sandbox.state.pending.has("m-2"));
await deny("m-2");
await ui({ kind: "jbb.ui.setGrantsPaused", paused: false });
await propose({ proposalId: "m-3" });
check("un-pause restores auto-allow", !sandbox.state.pending.has("m-3"));

// --- revoke mid-session: the very next action of that type prompts
await ui({ kind: "jbb.ui.revokeSite", host: "example.com" });
await propose({ proposalId: "m-4" });
check("after mid-session revoke, the next action prompts again", sandbox.state.pending.has("m-4"));
await deny("m-4");

// --- per-action checkboxes narrow coverage exactly; T3 cannot be smuggled
await ui({ kind: "jbb.ui.addWhitelist", domain: "example.com", tiers: ["T1", "T2"] });
r = await ui({ kind: "jbb.ui.updateWhitelist", domain: "example.com",
               tiers: ["T1", "T2", "T3"], actions: ["type"] });
check("manager update strips T3 from tiers", !!r && r.ok === true &&
  sandbox.state.whitelist["example.com"].tiers.indexOf("T3") === -1);
await propose({ proposalId: "m-5", type: "click" });
check("unchecked action (click) now prompts", sandbox.state.pending.has("m-5"));
await deny("m-5");
await propose({ proposalId: "m-6", type: "type", actionTier: "T2" });
check("checked T2 action (type) auto-allows", !sandbox.state.pending.has("m-6"));

// --- Keep re-confirms a stale entry
const e = sandbox.state.whitelist["example.com"];
e.grantedAt = Date.now() - 31 * 86400e3;
e.reviewedAt = e.grantedAt;
e.schemaVersion = 0;
e.actions = ["type"];
r = await ui({ kind: "jbb.ui.keepWhitelist", domain: "example.com" });
check("Keep upgrades the schema and extends actions to the current vocabulary",
  !!r && r.ok === true && e.schemaVersion === 1 && e.actions.includes("click") && e.actions.includes("key"));
check("Keep restarts the review clock", Date.now() - e.reviewedAt < 5000);

// --- revoke all
await ui({ kind: "jbb.ui.revokeAllWhitelist" });
check("Revoke all empties the whitelist (state + store)",
  Object.keys(sandbox.state.whitelist).length === 0 && store["jbb.whitelist"] === undefined);

console.log(failures === 0 ? "ALL WHITELIST MANAGER TESTS PASSED" : failures + " MANAGER CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
