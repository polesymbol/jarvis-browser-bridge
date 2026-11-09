// wait_for / fetch_in_page / media-progress test for extension/content.js.
// Run: node extension/test/content.advanced.test.mjs
//
// Exercises the REAL content script against a stub DOM + stub fetch:
//  - wait_for element/text/navigation/mediaEnded resolve when the
//    condition lands (element at ~300ms → result well under 2s), and a
//    wait that never matches still RESOLVES (matched:false) at its
//    bounded timeout — never hangs;
//  - fetch_in_page returns an authenticated same-origin JSON body with
//    credentials "include", sends NO credentials cross-origin, refuses
//    non-HTTPS, and truncates honestly past the wire cap;
//  - the media watcher reports progress for playing media and fires
//    immediately on play/ended events.
import fs from "node:fs";

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

class Ev {
  constructor(type, init = {}) { this.type = type; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
}
class El {
  constructor(tag, opts = {}) {
    this.tagName = tag.toUpperCase();
    this.children = []; this.shadowRoot = null;
    this.innerText = opts.innerText || "";
    this.textContent = opts.textContent || this.innerText;
    this.type = opts.type; this.isConnected = true;
    this._set = {}; this.events = []; this.listeners = {};
    this._hidden = !!opts.hidden;
    this._rect = opts.hidden ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
                              : { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 };
    if (opts.id) this._set.id = opts.id;
  }
  getBoundingClientRect() { return this._rect; }
  getAttribute(n) { return this._set[n] !== undefined ? this._set[n] : null; }
  setAttribute(n, v) { this._set[n] = v; }
  scrollIntoView() {}
  click() {}
  focus() {}
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatchEvent(ev) {
    this.events.push(ev);
    (this.listeners[ev.type] || []).slice().forEach((f) => f(ev));
    return !ev.defaultPrevented;
  }
  show() { this._hidden = false; this._rect = { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 }; }
}

// ---------------------------------------------------------- fixtures
const body = new El("body", { innerText: "Loading your courses…" });
const lateBtn = new El("button", { innerText: "Continue course", hidden: true, id: "late" });
const media = new El("video", {});
media.currentTime = 12; media.duration = 2100; media.paused = false; media.ended = false;
const interactives = [lateBtn];

const sentRuntime = [];
let listener = null;
global.window = {
  getComputedStyle: (e) => ({ visibility: e && e._hidden ? "hidden" : "visible", display: e && e._hidden ? "none" : "block" }),
  HTMLInputElement: function () {}, HTMLTextAreaElement: function () {},
  innerHeight: 800, innerWidth: 1200, scrollY: 0,
};
global.document = {
  title: "Academy", body, readyState: "complete",
  documentElement: { scrollHeight: 900 },
  querySelectorAll: (sel) => (sel === "video, audio" ? [media] : sel === "*" ? [] : interactives),
  querySelector: (sel) => {
    if (sel === "#late") return lateBtn._hidden ? lateBtn : lateBtn;
    const m = /\[data-jbb-id='([^']+)'\]/.exec(sel);
    return m ? interactives.find((e) => e.getAttribute("data-jbb-id") === m[1]) || null : null;
  },
  elementFromPoint: () => null,
};
global.location = { href: "https://academy.example.com/course", origin: "https://academy.example.com" };
global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg) => { sentRuntime.push(msg); return Promise.resolve({}); },
  },
};
global.window.__proto__ = global;
global.window.top = global.window;
global.Event = Ev;

// performance stub for networkIdle: last resource ended long ago.
global.performance = { now: () => 60000, getEntriesByType: () => [{ responseEnd: 1000 }] };

// fetch stub: captures init per URL.
const fetchCalls = [];
global.fetch = (url, init) => {
  fetchCalls.push({ url, init });
  const headers = { forEach: (fn) => { fn("application/json", "content-type"); } };
  if (url.includes("/api/me")) {
    return Promise.resolve({ status: 200, headers, url, body: null,
      text: () => Promise.resolve('{"name":"Pratik","plan":"pro"}') });
  }
  if (url.includes("/big")) {
    const chunk = new Uint8Array(100 * 1024).fill(97);
    let reads = 0;
    const reader = {
      read: () => (++reads <= 7
        ? Promise.resolve({ done: false, value: chunk })
        : Promise.resolve({ done: true })),
      cancel: () => Promise.resolve(),
    };
    return Promise.resolve({ status: 200, headers, url, body: { getReader: () => reader },
      text: () => Promise.reject(new Error("stream only")) });
  }
  return Promise.resolve({ status: 200, headers, url, body: null, text: () => Promise.resolve("{}") });
};

const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
new Function("window", "document", "location", "chrome", src)(
  global.window, global.document, global.location, global.chrome
);

function act(action) {
  return new Promise((resolve) => {
    listener({ kind: "jbb.content.act", action }, {}, resolve);
  });
}

// ---------------------------------------------------------- wait_for
setTimeout(() => lateBtn.show(), 300);
let t0 = Date.now();
let r = await act({ type: "waitFor", wait: { kind: "element", selector: "#late" }, timeoutMs: 5000 });
check("wait_for element resolves when the element appears (well under 2s, no observe polling)",
  r.ok && r.data.matched === true && r.data.condition === "element" && (Date.now() - t0) < 2000);

setTimeout(() => { body.innerText = "Welcome back — COURSE COMPLETED"; }, 300);
r = await act({ type: "waitFor", wait: { kind: "text", text: "COURSE COMPLETED" }, timeoutMs: 5000 });
check("wait_for text matches page text", r.ok && r.data.matched === true && r.data.condition === "text");

setTimeout(() => { global.location.href = "https://academy.example.com/course/2"; }, 250);
r = await act({ type: "waitFor", wait: { kind: "navigation" }, timeoutMs: 5000 });
check("wait_for navigation matches the URL change",
  r.ok && r.data.matched === true && /course\/2/.test(r.detail));
global.location.href = "https://academy.example.com/course";

setTimeout(() => { media.ended = true; }, 250);
r = await act({ type: "waitFor", wait: { kind: "mediaEnded" }, timeoutMs: 5000 });
check("wait_for mediaEnded matches", r.ok && r.data.matched === true && r.data.condition === "mediaEnded");
media.ended = false;

r = await act({ type: "waitFor", wait: { kind: "networkIdle" }, timeoutMs: 5000 });
check("wait_for networkIdle matches an idle page", r.ok && r.data.matched === true);

t0 = Date.now();
r = await act({ type: "waitFor", wait: { kind: "text", text: "NEVER APPEARS" }, timeoutMs: 600 });
check("wait_for always resolves at its bounded timeout (matched:false, no hang)",
  r.ok && r.data.matched === false && (Date.now() - t0) >= 550 && (Date.now() - t0) < 2500);

// ---------------------------------------------------------- fetch_in_page
r = await act({ type: "fetch", url: "https://academy.example.com/api/me" });
const meCall = fetchCalls.find((c) => c.url.includes("/api/me"));
check("fetch_in_page returns the authenticated JSON body the snapshot cannot see",
  r.ok && r.data.status === 200 && r.data.body.includes('"plan":"pro"') && r.data.headers["content-type"] === "application/json");
check("same-origin fetch carries the user's session (credentials include)",
  meCall.init.credentials === "include" && r.data.credentials === "include");

r = await act({ type: "fetch", url: "https://api.other.com/x" });
const xoCall = fetchCalls[fetchCalls.length - 1];
check("cross-origin fetch NEVER sends credentials",
  r.ok && xoCall.init.credentials === "omit" && r.data.credentials === "omit" && /no credentials sent/.test(r.detail));

r = await act({ type: "fetch", url: "http://insecure.example.com/api" });
check("non-HTTPS fetch is refused", !r.ok && /non-HTTPS/.test(r.error));

r = await act({ type: "fetch", url: "https://academy.example.com/big", method: "GET" });
check("oversized bodies truncate honestly at the wire cap",
  r.ok && r.data.truncated === true && r.data.body.length === 512000 && r.data.size > 512000);

// ---------------------------------------------------------- media progress
sentRuntime.length = 0;
global.window.__jbbMediaScan();
const prog = sentRuntime.find((m) => m.kind === "jbb.media.progress");
check("media watcher reports progress for playing media",
  !!prog && prog.currentTime === 12 && prog.duration === 2100 && prog.paused === false);
media.dispatchEvent(new Ev("ended"));
const endedMsg = sentRuntime[sentRuntime.length - 1];
check("media events fire immediately (ended)",
  !!endedMsg && endedMsg.kind === "jbb.media.progress" && endedMsg.event === "ended");

console.log(failures === 0 ? "ALL CONTENT ADVANCED TESTS PASSED" : failures + " CONTENT ADVANCED CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
