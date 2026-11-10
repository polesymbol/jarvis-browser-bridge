// Field-fix behavioral tests for extension/content.js — run:
//   node extension/test/content.fieldfixes.test.mjs
// Built from the 2026-11-10 Brand Analytics field report:
//   * dashboard controls (a role=tab inside shadow DOM, a cursor:pointer
//     div widget) must appear in the snapshot — before, only the outer
//     shell's native controls were visible;
//   * a click whose ref died in an SPA re-render re-resolves by its
//     approved label at execution time (exact + unique, else refused);
//   * scroll targets the inner scrollable container, not just the window;
//   * fetch refuses custom headers cross-origin and refuses browser-owned
//     headers (Cookie) even same-origin.
import fs from "node:fs";

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || !extra ? "" : " — " + extra));
  if (!ok) failures++;
}

function mkEl(tag, opts = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    children: opts.children || [],
    shadowRoot: opts.shadowRoot || null,
    innerText: opts.innerText || "",
    textContent: opts.textContent || "",
    value: opts.value,
    type: opts.type,
    isConnected: true,
    parentElement: opts.parentElement || null,
    scrollHeight: opts.scrollHeight || 0,
    clientHeight: opts.clientHeight || 0,
    scrollTop: 0,
    _attrs: { ...(opts.attrs || {}) },
    _style: opts.style || {},
    clicked: false,
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 }),
    getAttribute: function (n) { return this._attrs[n] || null; },
    setAttribute: function (n, v) { this._attrs[n] = v; },
    querySelector: () => null,
    querySelectorAll: () => [],
    click: function () { this.clicked = true; },
    scrollIntoView: () => {},
    focus: () => {},
    getRootNode: function () { return { host: null }; },
  };
  return el;
}

// --- fixture -------------------------------------------------------------
const tabEl = mkEl("div", { innerText: "Segment View", attrs: { role: "tab" } });
const shadowRootStub = {
  children: [tabEl],
  querySelectorAll: (sel) => (sel === "*" ? [tabEl] : [tabEl]),
};
const host = mkEl("div", { shadowRoot: shadowRootStub });
const cardBtn = mkEl("button", { innerText: "Inflation guide" });
const ptrDiv = mkEl("div", { innerText: "Quarterly", style: { cursor: "pointer" } });
const scroller = mkEl("div", {
  scrollHeight: 3000, clientHeight: 500,
  style: { overflowY: "auto" },
});
const innerBtn = mkEl("button", { innerText: "Inner action", parentElement: scroller });
const body = mkEl("body", { innerText: "Brand Analytics dashboard" });
scroller.parentElement = body;

const semantic = [cardBtn, innerBtn];
const allElements = [host, ptrDiv, scroller, cardBtn, innerBtn];

global.window = {
  innerWidth: 1280,
  innerHeight: 800,
  scrollY: 0,
  getComputedStyle: (el) => ({
    visibility: "visible", display: "block", cursor: "auto", overflowY: "visible",
    ...(el && el._style ? el._style : {}),
  }),
  HTMLInputElement: function () {},
  HTMLTextAreaElement: function () {},
};
global.document = {
  title: "Brand Analytics",
  body,
  documentElement: mkEl("html"),
  querySelectorAll: (sel) => {
    if (sel === "*") return allElements;
    if (sel === "video, audio") return [];
    return semantic; // INTERACTIVE_SELECTOR (any other string)
  },
  querySelector: () => null,
};
global.location = {
  href: "https://sellercentral.amazon.com/analytics",
  origin: "https://sellercentral.amazon.com",
};
let listener = null;
global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: () => {},
  },
};
global.window.__proto__ = global;

const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
new Function("window", "document", "location", "chrome", src)(
  global.window, global.document, global.location, global.chrome
);

// --- snapshot discovery ----------------------------------------------------
const snap = global.window.__jbbBuildSnapshot();
const byLabel = (l) => snap.interactives.find((i) => i.label === l);
check("shadow-DOM role=tab control appears in the snapshot, typed as tab",
  !!byLabel("Segment View") && byLabel("Segment View").type === "tab",
  JSON.stringify(snap.interactives.map((i) => [i.label, i.type])));
check("cursor:pointer div widget appears in the snapshot, typed clickable",
  !!byLabel("Quarterly") && byLabel("Quarterly").type === "clickable");
check("semantic controls still listed (no regression)",
  !!byLabel("Inflation guide") && !!byLabel("Inner action"));

// --- act dispatch ------------------------------------------------------------
function act(action) {
  return new Promise((resolve) => {
    listener({ kind: "jbb.content.act", action }, null, (resp) => resolve(resp));
  });
}

{
  const r = await act({ type: "click", target: { ref: "e999", label: "Inflation guide" } });
  check("click with a dead ref re-resolves by its exact label at execution time",
    r.ok === true && r.matchQuality === "re-resolved" && cardBtn.clicked === true,
    JSON.stringify(r));
}
{
  const r = await act({ type: "click", target: { ref: "e999", label: "No such card" } });
  check("re-resolution fails closed when the label matches nothing",
    r.ok === false && /matches 0 elements/.test(r.error || ""),
    JSON.stringify(r));
}
{
  const inner = byLabel("Inner action");
  const r = await act({ type: "scroll", direction: "down", amount: 600, target: { ref: inner.ref, label: "Inner action" } });
  check("targeted scroll moves the inner scrollable container",
    r.ok === true && /inner container/.test(r.detail || "") && scroller.scrollTop === 600,
    JSON.stringify(r) + " scrollTop=" + scroller.scrollTop);
}
{
  const r = await act({ type: "fetch", url: "https://other.example.com/api", headers: { "X-Csrf": "tok" } });
  check("fetch refuses custom headers cross-origin",
    r.ok === false && /custom headers are only sent on same-origin/.test(r.error || ""),
    JSON.stringify(r));
}
{
  const r = await act({ type: "fetch", url: "/seller-university/api/search?query=x", headers: { Cookie: "session=1" } });
  check("fetch refuses the browser-owned Cookie header even same-origin",
    r.ok === false && /browser-owned/.test(r.error || ""),
    JSON.stringify(r));
}

console.log(failures === 0 ? "ALL FIELD-FIX CONTENT TESTS PASSED" : failures + " FIELD-FIX CONTENT TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
