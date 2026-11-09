/**
 * Pending-proposal persistence test — loads the REAL background.js in a vm
 * with a stubbed chrome.* surface, twice, over ONE shared storage object.
 * Run: node extension/test/pending.persistence.test.mjs
 *
 * Proves the property the offscreen-transport move must not break:
 * a proposal that is awaiting consent in worker #1 is still listed and
 * answerable in worker #2 (a full service-worker restart), because
 * pendings persist in chrome.storage.local and hydrate on boot/alarm.
 * It also proves the worker never constructs a WebSocket itself — the
 * socket is the offscreen document's job now.
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

let wsConstructions = 0;

function boot(store) {
  const sent = [];
  const listeners = { alarm: [] };
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
      onStartup: { addListener: () => {} },
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
    },
    scripting: { executeScript: () => Promise.resolve([{ result: true }]) },
    offscreen: { hasDocument: (cb) => cb(true),
                 createDocument: (opts, cb) => { if (cb) cb(); },
                 closeDocument: () => Promise.resolve() },
    sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() },
    commands: { onCommand: { addListener: () => {} } },
    identity: { getProfileUserInfo: (cb) => cb({ email: "" }) },
  };
  const sandbox = {
    chrome, console, URL, Date, JSON, Math, Promise, Uint8Array, ArrayBuffer,
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto,
    WebSocket: class { constructor() { wsConstructions++; throw new Error("worker must not dial"); } },
    importScripts: () => {},
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(protoSrc, sandbox, { filename: "protocol.js" });
  vm.runInContext(bgSrc, sandbox, { filename: "background.js" });
  return { ctx: sandbox, sent, listeners };
}

const store = {}; // the one chrome.storage.local both workers share

// ------------------------------------------------------------ worker #1: a proposal arrives
const w1 = boot(store);
await tick(60);
w1.ctx.handleProposal({
  proposalId: "persist-1", actionTier: "T1", type: "click",
  target: { ref: null, label: "Buy" },
  site: "https://example.com/", description: "Click Buy on example.com",
}, "relay");
await tick(60);

check("worker #1 tracks the pending proposal", w1.ctx.state.pending.has("persist-1"));
check("the pending proposal persisted to storage",
  !!(store["jbb.pending"] && store["jbb.pending"]["persist-1"]));

// ------------------------------------------------------------ worker #2: full restart, same storage
const w2 = boot(store);
await tick(60);
w2.ctx.hydratePendings();
await tick(60);

check("worker #2 rehydrates the pending proposal", w2.ctx.state.pending.has("persist-1"));

// ------------------------------------------------------------ and it is still answerable
const entry = w2.ctx.state.pending.get("persist-1");
entry.resolve({ choice: "deny", reason: "user denied" });
await tick(60);

const denySent = w2.sent.some((m) => m && m.kind === "jbb.relay.send" &&
  typeof m.data === "string" && m.data.includes('"consent.deny"') && m.data.includes("persist-1"));
check("worker #2 answers it: consent.deny leaves via the offscreen transport", denySent);
check("answering removed it from worker #2's map", !w2.ctx.state.pending.has("persist-1"));
check("answering removed it from storage",
  !(store["jbb.pending"] && store["jbb.pending"]["persist-1"]));

// ------------------------------------------------------------ transport isolation, behaviorally
check("neither worker ever constructed a WebSocket", wsConstructions === 0);

console.log(failures === 0 ? "ALL PENDING PERSISTENCE TESTS PASSED" : failures + " PENDING PERSISTENCE CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
