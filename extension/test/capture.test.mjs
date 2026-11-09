// Audio-capture test — loads the REAL background.js in a vm.
// Run: node extension/test/capture.test.mjs
//
// Proves the chain of custody:
//  - start needs consent AND the user-granted tabCapture permission
//    (without the permission the act fails with plain instructions and
//    the capture engine is never engaged);
//  - the worker hands the offscreen a stream id, the offscreen's
//    "active" state completes the start, the tab gets its indicator;
//  - chunks are relayed ONLY when they come from the offscreen sender
//    and only for the live capture id;
//  - stop is auto-allowed (no grant needed), clears state, drops the
//    indicator, and stops the engine.
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

let permGranted = true;
const runtimeSent = [];
const tabMsgs = [];
const tabsDb = [
  { id: 1, windowId: 1, url: "https://example.com/a", title: "A", active: true, pinned: false, audible: true },
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
  permissions: {
    request: () => Promise.resolve(true),
    contains: (req, cb) => { if (cb) cb(permGranted); return Promise.resolve(permGranted); },
    remove: () => Promise.resolve(true),
  },
  tabCapture: { getMediaStreamId: (opts, cb) => { if (cb) cb("stream-xyz"); return Promise.resolve("stream-xyz"); } },
  windows: { update: () => Promise.resolve({}) },
  tabs: {
    query: (q) => Promise.resolve(tabsDb.filter((t) => !q || !q.active || t.active).map(clone)),
    get: (id) => Promise.resolve(clone(tabsDb.find((t) => t.id === id))),
    remove: () => Promise.resolve(),
    create: () => Promise.resolve({}),
    update: () => Promise.resolve({}),
    sendMessage: (tabId, msg) => { tabMsgs.push({ tabId, msg: clone(msg) }); return Promise.resolve({ ok: true }); },
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
await tick(90);
sandbox.state.connected = true;

const OFFSCREEN = { url: "chrome-extension://test/offscreen.html" };
function fromOffscreen(msg) { uiListener(msg, OFFSCREEN, () => {}); }
function relayPayloads() {
  return runtimeSent.filter((m) => m.kind === "jbb.relay.send")
    .map((m) => { try { return JSON.parse(m.data); } catch { return null; } })
    .filter(Boolean);
}
async function propose(over) {
  sandbox.handleProposal(Object.assign({
    proposalId: "c-x", actionTier: "T2", type: "audioCapture",
    site: "https://example.com/a", description: "audio capture",
  }, over), "relay");
  await tick(120);
}

// ---------------------------------------------------------- start (permission on)
await propose({ proposalId: "c-1", capture: { action: "start" } });
check("capture start prompts first (T2, not whitelisted)",
  sandbox.state.pending.has("c-1"));
sandbox.state.pending.get("c-1").resolve({ choice: "once" });
await tick(120);
const startMsg = runtimeSent.find((m) => m.kind === "jbb.capture.start");
check("consent + permission → the offscreen gets a stream id",
  !!startMsg && startMsg.streamId === "stream-xyz" && !!startMsg.captureId);
fromOffscreen({ kind: "jbb.capture.state", active: true, captureId: startMsg.captureId });
await tick(80);
const res1 = relayPayloads().find((m) => m.type === "act.result" && m.proposalId === "c-1");
check("start completes when the engine reports active",
  !!res1 && res1.ok === true && !!sandbox.state.capture && sandbox.state.capture.host === "example.com");
check("the captured tab gets its on-screen indicator",
  tabMsgs.some((t) => t.msg.kind === "jbb.capture.indicator" && t.msg.active === true));

// ---------------------------------------------------------- chunks: sender-verified
fromOffscreen({ kind: "jbb.capture.chunk", captureId: startMsg.captureId, seq: 7, mimeType: "audio/webm;codecs=opus", data: "QUJD" });
await tick(30);
const chunkRelayed = relayPayloads().find((m) => m.type === "audio.chunk");
check("chunks from the offscreen are relayed to the driver",
  !!chunkRelayed && chunkRelayed.seq === 7 && chunkRelayed.data === "QUJD");
const before = relayPayloads().filter((m) => m.type === "audio.chunk").length;
uiListener({ kind: "jbb.capture.chunk", captureId: startMsg.captureId, seq: 8, mimeType: "x", data: "RkFLRQ==" },
  { url: "chrome-extension://test/sidepanel.html" }, () => {});
await tick(30);
check("chunks from anywhere else are dropped",
  relayPayloads().filter((m) => m.type === "audio.chunk").length === before);

// ---------------------------------------------------------- stop: always allowed
tabMsgs.length = 0;
await propose({ proposalId: "c-2", capture: { action: "stop" } });
check("stopping never prompts — it just stops",
  !sandbox.state.pending.has("c-2") && sandbox.state.capture === null &&
  runtimeSent.some((m) => m.kind === "jbb.capture.stop") &&
  tabMsgs.some((t) => t.msg.kind === "jbb.capture.indicator" && t.msg.active === false));

// ---------------------------------------------------------- start without the permission
permGranted = false;
runtimeSent.length = 0;
await propose({ proposalId: "c-3", capture: { action: "start" } });
sandbox.state.pending.get("c-3").resolve({ choice: "once" });
await tick(150);
const res3 = relayPayloads().find((m) => m.type === "act.result" && m.proposalId === "c-3");
check("without the user's permission, capture refuses with plain instructions and never engages the engine",
  !!res3 && res3.ok === false && /side panel/.test(res3.detail || "") &&
  !runtimeSent.some((m) => m.kind === "jbb.capture.start") && sandbox.state.capture === null);

console.log(failures === 0 ? "ALL CAPTURE TESTS PASSED" : failures + " CAPTURE CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
