/**
 * Tab-actions test — loads the REAL background.js in a vm over a mutable
 * tab database. Run: node extension/test/tabs.test.mjs
 *
 * Proves:
 *  - listTabs returns title/url/audible/active for every tab;
 *  - closeInactiveTabs closes only inactive, unpinned, silent tabs;
 *  - a tab action on a non-whitelisted site prompts (with the tab's REAL
 *    site resolved before the gate);
 *  - closing the ACTIVE tab forces a prompt even on a whitelisted site,
 *    and executes after an explicit consent;
 *  - the last tab in a window is never closed, and a tab that became
 *    active after a grant is not closed under that grant;
 *  - whitelisted closeTab on a background tab auto-executes;
 *  - openTab / switchTab / pinTab do their jobs; the panel's own
 *    close-inactive path uses the same guarded implementation.
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

let tabsDb = [];
const removedTabs = [];
let focusedWindow = null;
function resetTabs() {
  tabsDb = [
    { id: 1, windowId: 1, url: "https://example.com/a", title: "A", active: true, pinned: false, audible: false },
    { id: 2, windowId: 1, url: "https://example.com/a", title: "A copy", active: false, pinned: false, audible: false },
    { id: 3, windowId: 1, url: "https://music.example.com/", title: "Music", active: false, pinned: false, audible: true },
    { id: 4, windowId: 1, url: "https://docs.example.com/", title: "Docs", active: false, pinned: true, audible: false },
    { id: 5, windowId: 1, url: "https://news.example.com/", title: "News", active: false, pinned: false, audible: false },
  ];
  removedTabs.length = 0;
}
resetTabs();

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
    sendMessage: () => Promise.resolve({}),
    getURL: (p) => "chrome-extension://test/" + p,
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, onClicked: { addListener: () => {} } },
  notifications: { create: (id, opts, cb) => { if (cb) cb(); }, clear: () => {},
    getAll: (cb) => cb({}), onButtonClicked: { addListener: () => {} },
    onClicked: { addListener: () => {} }, onClosed: { addListener: () => {} } },
  permissions: { request: () => Promise.resolve(true), contains: () => Promise.resolve(false),
    remove: () => Promise.resolve(true) },
  windows: { update: (id) => { focusedWindow = id; return Promise.resolve({}); } },
  tabs: {
    query: (q) => {
      let out = tabsDb.slice();
      if (q && q.windowId !== undefined) out = out.filter((t) => t.windowId === q.windowId);
      if (q && q.active) out = out.filter((t) => t.active);
      return Promise.resolve(out.map(clone));
    },
    get: (id) => {
      const t = tabsDb.find((t) => t.id === id);
      return t ? Promise.resolve(clone(t)) : Promise.reject(new Error("no tab " + id));
    },
    remove: (ids) => {
      (Array.isArray(ids) ? ids : [ids]).forEach((id) => {
        removedTabs.push(id);
        const i = tabsDb.findIndex((t) => t.id === id);
        if (i >= 0) tabsDb.splice(i, 1);
      });
      return Promise.resolve();
    },
    create: (props) => {
      const t = Object.assign({ id: 100 + tabsDb.length, windowId: 1, title: "", audible: false, pinned: false, active: false }, props);
      tabsDb.push(t);
      return Promise.resolve(clone(t));
    },
    update: (id, props) => {
      const t = tabsDb.find((t) => t.id === id);
      Object.assign(t, props);
      if (props.active) tabsDb.forEach((o) => { if (o.windowId === t.windowId && o.id !== id) o.active = false; });
      return Promise.resolve(clone(t));
    },
    sendMessage: () => Promise.resolve({ ok: true, detail: "clicked" }),
    captureVisibleTab: () => Promise.resolve("data:,"),
    onCreated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} }, onActivated: { addListener: () => {} },
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
async function propose(over) {
  sandbox.handleProposal(Object.assign({
    proposalId: "t-x", actionTier: "T2", type: "closeTab",
    site: "", description: "tab action",
  }, over), "relay");
  await tick(110);
}

// ---------------------------------------------------------- list + closeInactive (direct execution)
const listed = await sandbox.executeTabAction({ type: "listTabs" });
check("listTabs returns title/url/audible/active for every tab",
  listed.data.tabs.length === 5 &&
  listed.data.tabs.every((t) => "title" in t && "url" in t && "audible" in t && "active" in t) &&
  listed.data.tabs.find((t) => t.id === 3).audible === true &&
  listed.data.tabs.find((t) => t.id === 1).active === true);

const ci = await sandbox.executeTabAction({ type: "closeInactiveTabs" });
check("closeInactiveTabs closes only the inactive, unpinned, silent tabs",
  JSON.stringify(removedTabs.slice().sort()) === "[2,5]" && ci.data.kept === 3 &&
  tabsDb.length === 3 && tabsDb.some((t) => t.id === 1) && tabsDb.some((t) => t.id === 3) && tabsDb.some((t) => t.id === 4));

// ---------------------------------------------------------- proposal flow
resetTabs();
await propose({ proposalId: "t-1", tabId: 5, description: "close tab 5" });
check("a tab action on a non-whitelisted site prompts, keyed to the tab's real site",
  sandbox.state.pending.has("t-1") &&
  sandbox.state.pending.get("t-1").proposal.site === "https://news.example.com/");
sandbox.state.pending.get("t-1").resolve({ choice: "deny" });
await tick(40);

// whitelist example.com for T2 incl. tab actions
await ui({ kind: "jbb.ui.addWhitelist", domain: "example.com" });
await ui({ kind: "jbb.ui.updateWhitelist", domain: "example.com", tiers: ["T1", "T2"],
  actions: ["click", "type", "scroll", "navigate", "clickAt", "clickSelector", "key",
            "hover", "select", "drag", "setValue",
            "listTabs", "switchTab", "closeTab", "closeInactiveTabs", "openTab", "pinTab"] });

await propose({ proposalId: "t-2", tabId: 1, description: "close tab 1" });
check("closing the ACTIVE tab forces a prompt even on a whitelisted site",
  sandbox.state.pending.has("t-2"));
sandbox.state.pending.get("t-2").resolve({ choice: "once" });
await tick(90);
check("after an explicit consent the active tab closes", removedTabs.includes(1));

resetTabs();
await propose({ proposalId: "t-3", tabId: 2, description: "close tab 2" });
check("whitelisted closeTab on a background tab auto-executes",
  !sandbox.state.pending.has("t-3") && removedTabs.includes(2));
const auditLog = store["jbb.audit"] || [];
check("the auto close is audited as whitelist-authorized",
  auditLog.some((e) => e.proposalId === "t-3" && e.result === "executed" && e.via === "whitelist"));

// ---------------------------------------------------------- execution guards (direct)
tabsDb = [{ id: 9, windowId: 2, url: "https://solo.example.com/", title: "Solo", active: true, pinned: false, audible: false }];
let err = await sandbox.executeTabAction({ type: "closeTab", tabId: 9, _forceAsk: true }).then(() => "", (e) => e.message);
check("the last tab in a window is never closed", /last tab/.test(err) && tabsDb.length === 1);

resetTabs();
tabsDb.find((t) => t.id === 5).active = true; // user started looking at it after the grant
err = await sandbox.executeTabAction({ type: "closeTab", tabId: 5 }).then(() => "", (e) => e.message);
check("a tab that became active after its grant is not closed under it",
  /now the one you're looking at/.test(err) && tabsDb.some((t) => t.id === 5));

// ---------------------------------------------------------- open / switch / pin (direct)
resetTabs();
const opened = await sandbox.executeTabAction({ type: "openTab", url: "https://new.example.com/page" });
check("openTab creates a background tab and reports its id",
  tabsDb.some((t) => t.url === "https://new.example.com/page" && t.active === false) && opened.data.tab.id > 0);
await sandbox.executeTabAction({ type: "switchTab", tabId: 3 });
check("switchTab activates the tab and focuses its window",
  tabsDb.find((t) => t.id === 3).active === true && focusedWindow === 1);
await sandbox.executeTabAction({ type: "pinTab", tabId: 5 });
check("pinTab pins", tabsDb.find((t) => t.id === 5).pinned === true);

// ---------------------------------------------------------- panel path
resetTabs();
const res = await ui({ kind: "jbb.ui.closeInactiveTabs" });
check("the panel's close-inactive uses the same guarded implementation",
  !!res && res.ok === true && res.closed === 2 && res.kept === 3);

console.log(failures === 0 ? "ALL TAB TESTS PASSED" : failures + " TAB CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
