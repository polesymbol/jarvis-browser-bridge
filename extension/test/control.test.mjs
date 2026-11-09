// Control test — loads the REAL background.js in a vm.
// Run: node extension/test/control.test.mjs
//
// Proves Prompt 15's control surface:
//  - Levels: Light auto-allows T2 anywhere; Strict ignores a live
//    whitelist entry; Balanced (default) honours it.
//  - Temporary grant: "until I leave this site" covers the host, and
//    navigating the granted tab to another host ends it.
//  - Take-over: proposals queue (heartbeat, no prompt, no execution),
//    and hand-back runs them through the gate in order.
//  - Plans: an approved plan's T1 step runs prompt-free; its T3 step
//    still asks; a 21-step plan is refused before it ever prompts.
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

const runtimeSent = [];
const tabListeners = { onUpdated: [], onRemoved: [] };
const tabsDb = [
  { id: 1, windowId: 1, url: "https://example.com/a", title: "A", active: true, pinned: false, audible: false },
];
const store = {};
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
    sendMessage: (msg) => { runtimeSent.push(clone(msg)); return Promise.resolve({}); },
    getURL: (p) => "chrome-extension://test/" + p,
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, onClicked: { addListener: () => {} } },
  notifications: { create: (id, opts, cb) => { if (cb) cb(); }, clear: () => {},
    getAll: (cb) => cb({}), onButtonClicked: { addListener: () => {} },
    onClicked: { addListener: () => {} }, onClosed: { addListener: () => {} } },
  permissions: { request: () => Promise.resolve(true),
    contains: (req, cb) => { if (cb) cb(false); return Promise.resolve(false); },
    remove: () => Promise.resolve(true) },
  windows: { update: () => Promise.resolve({}) },
  tabs: {
    query: (q) => Promise.resolve(tabsDb.filter((t) => !q || !q.active || t.active).map(clone)),
    get: (id) => Promise.resolve(clone(tabsDb.find((t) => t.id === id))),
    remove: () => Promise.resolve(),
    create: () => Promise.resolve({}),
    update: () => Promise.resolve({}),
    sendMessage: () => Promise.resolve({ ok: true, detail: "clicked" }),
    captureVisibleTab: () => Promise.resolve("data:,"),
    onCreated: { addListener: () => {} },
    onRemoved: { addListener: (fn) => tabListeners.onRemoved.push(fn) },
    onUpdated: { addListener: (fn) => tabListeners.onUpdated.push(fn) },
    onActivated: { addListener: () => {} },
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
await tick(90);

function relayPayloads() {
  return runtimeSent.filter((m) => m.kind === "jbb.relay.send")
    .map((m) => { try { return JSON.parse(m.data); } catch { return null; } })
    .filter(Boolean);
}
function actResult(id) {
  return relayPayloads().find((m) => m.type === "act.result" && m.proposalId === id);
}
async function propose(over) {
  sandbox.handleProposal(Object.assign({
    proposalId: "x-x", actionTier: "T1", type: "click",
    site: "https://example.com/a", description: "click thing",
    target: { ref: null, label: "Thing" },
  }, over), "relay");
  await tick(110);
}
function ui(msg) { uiListener(msg, {}, () => {}); }
async function setMode(mode) { ui({ kind: "jbb.ui.setMode", mode }); await tick(30); }

// ---------------------------------------------------------- levels
await setMode("light");
await propose({ proposalId: "lv-1", actionTier: "T2", type: "openTab", url: "https://news.example.com/x", site: "https://news.example.com/x" });
check("Light: a T2 action on an ungranted site runs with no prompt",
  !sandbox.state.pending.has("lv-1") && !!actResult("lv-1") && actResult("lv-1").ok === true);

await setMode("balanced");
await propose({ proposalId: "lv-2" });
check("Balanced: an ungranted site asks", sandbox.state.pending.has("lv-2"));
sandbox.state.pending.get("lv-2").resolve({ choice: "whitelist" });
await tick(60);
await propose({ proposalId: "lv-3" });
check("Balanced: the whitelist entry then auto-allows",
  !sandbox.state.pending.has("lv-3") && !!actResult("lv-3") && actResult("lv-3").ok === true);
await setMode("strict");
await propose({ proposalId: "lv-4" });
check("Strict: the same whitelist entry is ignored — it asks",
  sandbox.state.pending.has("lv-4"));
sandbox.state.pending.get("lv-4").resolve({ choice: "deny" });
await tick(40);
await setMode("balanced");

// ---------------------------------------------------------- temporary grant
// Clear the whitelist so the temp grant is what covers tp-2.
sandbox.state.whitelist = {};
await propose({ proposalId: "tp-0" });
sandbox.state.pending.get("tp-0").resolve({ choice: "untilLeave" });
await tick(80);
check("temporary grant is created by the until-leave choice",
  !!sandbox.state.tempGrant && sandbox.state.tempGrant.host === "example.com");
await propose({ proposalId: "tp-2" });
check("the temporary grant covers the next action on the host",
  !sandbox.state.pending.has("tp-2") && !!actResult("tp-2") && actResult("tp-2").ok === true);
tabListeners.onUpdated.forEach((fn) => fn(1, { url: "https://other.example.net/away" }, tabsDb[0]));
await tick(40);
check("navigating the granted tab to another host ends the grant",
  sandbox.state.tempGrant === null);
await propose({ proposalId: "tp-3" });
check("after leaving, the site asks again", sandbox.state.pending.has("tp-3"));
sandbox.state.pending.get("tp-3").resolve({ choice: "deny" });
await tick(40);

// ---------------------------------------------------------- take-over
ui({ kind: "jbb.ui.setTakeover", on: true });
await tick(30);
await propose({ proposalId: "to-1" });
check("take-over: the proposal queues — no prompt, no execution",
  sandbox.state.holdQueue.length === 1 && !sandbox.state.pending.has("to-1") &&
  !actResult("to-1") &&
  relayPayloads().some((m) => m.type === "proposal.queued" && m.proposalId === "to-1"));
ui({ kind: "jbb.ui.setTakeover", on: false });
await tick(120);
check("hand-back: the queued proposal enters the normal gate",
  sandbox.state.holdQueue.length === 0 && sandbox.state.pending.has("to-1"));
sandbox.state.pending.get("to-1").resolve({ choice: "once" });
await tick(60);
check("hand-back: once approved, the queued action runs",
  !!actResult("to-1") && actResult("to-1").ok === true);

// ---------------------------------------------------------- plans
sandbox.handleRelayMessage(JSON.stringify({
  v: 1, type: "plan.propose", id: "plan-1",
  plan: { title: "Lesson flow", steps: [
    { type: "click", actionTier: "T1", site: "https://example.com/a", description: "open lesson" },
    { type: "click", actionTier: "T3", site: "https://example.com/a", description: "pay now" },
  ] },
}));
await tick(60);
check("a well-formed plan waits for approval", sandbox.state.planPending.has("plan-1"));
ui({ kind: "jbb.ui.planResolve", planId: "plan-1", approved: true });
await tick(40);
check("approval is relayed to the driver",
  relayPayloads().some((m) => m.type === "plan.approved" && m.planId === "plan-1"));
await propose({ proposalId: "pl-1", planId: "plan-1" });
check("an approved plan's T1 step runs with no prompt",
  !sandbox.state.pending.has("pl-1") && !!actResult("pl-1") && actResult("pl-1").ok === true);
await propose({ proposalId: "pl-2", planId: "plan-1", actionTier: "T3", description: "pay now" });
check("the plan NEVER covers a T3 step — it asks", sandbox.state.pending.has("pl-2"));
sandbox.state.pending.get("pl-2").resolve({ choice: "deny" });
await tick(40);

sandbox.handleRelayMessage(JSON.stringify({
  v: 1, type: "plan.propose", id: "plan-big",
  plan: { title: "Too big", steps: Array.from({ length: 21 }, (_, i) => (
    { type: "click", actionTier: "T1", site: "https://example.com/a", description: "step " + i })) },
}));
await tick(60);
const bigDenial = relayPayloads().find((m) => m.type === "plan.denied" && m.planId === "plan-big");
check("a 21-step plan is refused up front, before any approval prompt",
  !!bigDenial && /maximum is 20/.test(bigDenial.reason || "") && !sandbox.state.planPending.has("plan-big"));

console.log(failures === 0 ? "ALL CONTROL TESTS PASSED" : failures + " CONTROL CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
