/**
 * Snapshot-versioning test — loads the REAL background.js in a vm with a
 * stubbed chrome.* surface.
 * Run: node extension/test/snapshot.version.test.mjs
 *
 * Proves:
 *  - every observe response carries a monotonically increasing
 *    snapshotVersion (on the message and inside the snapshot);
 *  - an act declaring an old version is refused with STALE_SNAPSHOT +
 *    the current version BEFORE consent is asked (no pending created,
 *    nothing executes);
 *  - an act declaring the current version proceeds to consent, and a
 *    successful application bumps the version and reports it back;
 *  - a version-less act (older driver) is NOT stale-refused — it
 *    proceeds on stable-id + label verification alone.
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
let actResponse = { ok: true, detail: "clicked 'Lesson 2'" };
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
  tabs: {
    query: () => Promise.resolve([{ id: 1, windowId: 1, url: "https://example.com/", active: true }]),
    get: () => Promise.resolve({ id: 1, windowId: 1, url: "https://example.com/" }),
    sendMessage: () => Promise.resolve(actResponse),
    update: () => Promise.resolve({}),
    captureVisibleTab: () => Promise.resolve("data:,"),
    onActivated: { addListener: () => {} }, onUpdated: { addListener: () => {} },
  },
  scripting: { executeScript: (args) => {
    if (args && typeof args.func === "function") {
      const r = args.func();
      return Promise.resolve([{ frameId: 0, result: r }]);
    }
    return Promise.resolve([{ result: true }]); // injection + banner probes
  } },
  offscreen: { hasDocument: (cb) => cb(true), createDocument: (o, cb) => { if (cb) cb(); },
               closeDocument: () => Promise.resolve() },
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
sandbox.__jbbBuildSnapshot = () => ({
  title: "Course", url: "https://example.com/",
  interactives: [{ ref: "e1", label: "Lesson 2", type: "button", name: null }],
  text: "", media: [],
});
vm.createContext(sandbox);
vm.runInContext(protoSrc, sandbox, { filename: "protocol.js" });
vm.runInContext(bgSrc, sandbox, { filename: "background.js" });
await tick(60);

function observe(id) {
  sent.length = 0;
  sandbox.handleRelayMessage(JSON.stringify({ v: 1, type: "observe.request", id }));
  return tick(60).then(() =>
    sent.map((m) => { try { return JSON.parse(m.data); } catch { return null; } })
        .find((m) => m && m.type === "observe.result"));
}
function relaySends() {
  return sent.filter((m) => m && m.kind === "jbb.relay.send")
    .map((m) => { try { return JSON.parse(m.data); } catch { return null; } })
    .filter(Boolean);
}
const proposal = (over) => Object.assign({
  actionTier: "T1", type: "click",
  target: { ref: "f0:e1", label: "Lesson 2" },
  site: "https://example.com/", description: "click 'Lesson 2'",
}, over);

// --- observes carry increasing versions
const o1 = await observe("o1");
check("observe #1 carries snapshotVersion 1 (message + snapshot)",
  o1 && o1.snapshotVersion === 1 && o1.snapshot.snapshotVersion === 1);
const o2 = await observe("o2");
check("observe #2 bumps to version 2", o2 && o2.snapshotVersion === 2);

// --- an act built against v1 is refused STALE_SNAPSHOT before consent
sent.length = 0;
sandbox.handleProposal(proposal({ proposalId: "stale-1", snapshotVersion: 1 }), "relay");
await tick();
const staleResult = relaySends().find((m) => m.type === "act.result" && m.proposalId === "stale-1");
check("stale act refused with STALE_SNAPSHOT + current version",
  !!staleResult && staleResult.ok === false && staleResult.error === "STALE_SNAPSHOT" && staleResult.snapshotVersion === 2);
check("stale act never reached consent (no pending created)", !sandbox.state.pending.has("stale-1"));

// --- an act built against v2 proceeds; applying it bumps the version
sent.length = 0;
sandbox.handleProposal(proposal({ proposalId: "fresh-1", snapshotVersion: 2 }), "relay");
await tick();
check("current-version act proceeds to consent", sandbox.state.pending.has("fresh-1"));
sandbox.state.pending.get("fresh-1").resolve({ choice: "once" });
await tick(80);
const freshResult = relaySends().find((m) => m.type === "act.result" && m.proposalId === "fresh-1");
check("applied act reports ok + the bumped version 3",
  !!freshResult && freshResult.ok === true && freshResult.snapshotVersion === 3);
check("worker state version is now 3", sandbox.state.snapshotVersion === 3);

// --- a version-less act (older driver) is not stale-refused
sandbox.handleProposal(proposal({ proposalId: "legacy-1" }), "relay");
await tick();
check("version-less act proceeds to consent (stable-id + label checks only)",
  sandbox.state.pending.has("legacy-1"));

// --- matchQuality from the content script rides the act.result
actResponse = { ok: true, detail: "clicked 'Lesson 2'", matchQuality: "fuzzy" };
sent.length = 0;
sandbox.handleProposal(proposal({ proposalId: "fuzzy-1" }), "relay");
await tick();
check("fuzzy act proceeds to consent", sandbox.state.pending.has("fuzzy-1"));
sandbox.state.pending.get("fuzzy-1").resolve({ choice: "once" });
await tick(80);
const fuzzyResult = relaySends().find((m) => m.type === "act.result" && m.proposalId === "fuzzy-1");
check("act.result carries matchQuality: fuzzy",
  !!fuzzyResult && fuzzyResult.ok === true && fuzzyResult.matchQuality === "fuzzy");

console.log(failures === 0 ? "ALL SNAPSHOT VERSION TESTS PASSED" : failures + " SNAPSHOT VERSION CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
