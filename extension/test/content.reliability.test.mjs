// Reliability behavioral tests for extension/content.js — run:
//   node extension/test/content.reliability.test.mjs
// Covers the 2026-11-13 reliability prompt's content-side fixes:
//   Fix 1 — a click whose element was replaced by a re-render re-resolves
//     by the selector the snapshot remembered (and retries while the
//     element is still missing); a blank page waits for the re-mount
//     instead of failing on the first miss.
//   Fix 3 — post-click verification: VERIFIED when the state changed,
//     UNCONFIRMED when a stateful element's state did not, N/A for a
//     plain link/button with no state to check.
//   Fix 4 — checked / selected / disabled in the snapshot.
//   Fix 9 — a tab whose visible text lives in a shadow root is labelled
//     by that text, not by its tag ("div").
import fs from "node:fs";

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || !extra ? "" : " — " + extra));
  if (!ok) failures++;
}

// --- stub DOM -------------------------------------------------------------
function mkEl(tag, opts = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    children: opts.children || [],
    shadowRoot: opts.shadowRoot || null,
    innerText: opts.innerText || "",
    textContent: opts.textContent || opts.innerText || "",
    value: opts.value,
    type: opts.type,
    id: opts.id || "",
    isConnected: true,
    parentElement: opts.parentElement || null,
    checked: !!opts.checked,
    disabled: !!opts.disabled,
    scrollHeight: opts.scrollHeight || 0,
    clientHeight: opts.clientHeight || 0,
    scrollTop: 0,
    _attrs: { ...(opts.attrs || {}) },
    _style: opts.style || {},
    _classes: new Set(opts.classes || []),
    clicked: false,
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 }),
    getAttribute: function (n) { return this._attrs[n] != null ? this._attrs[n] : null; },
    setAttribute: function (n, v) { this._attrs[n] = v; },
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: {
      contains: function (c) { return el._classes.has(c); },
      add: function (c) { el._classes.add(c); },
      remove: function (c) { el._classes.delete(c); },
    },
    click: function () {
      this.clicked = true;
      // A checkbox toggles on click, like a real one.
      if (this.tagName === "INPUT" && (this.type === "checkbox" || this.type === "radio")) {
        this.checked = !this.checked;
      }
      if (opts.onClick) opts.onClick(this);
    },
    scrollIntoView: () => {},
    focus: () => {},
    dispatchEvent: () => true,
    getRootNode: function () { return { host: null }; },
  };
  return el;
}

// The live element list — the "current DOM" the stub queries read. Tests
// mutate it to simulate SPA re-renders.
let live = [];
function matchesSel(el, sel) {
  if (!el || !sel) return false;
  if (sel === "*") return true;
  const m = sel.match(/^([a-z0-9]*)?(#[\w-]+)?(\[[^\]]+\])?(:nth-of-type\(\d+\))?$/i);
  if (!m) return false;
  const [, tag, idSel, attrSel] = m;
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (idSel && ("#" + (el.id || "")) !== idSel) return false;
  if (attrSel) {
    const am = attrSel.match(/^\[([\w-]+)="([^"]*)"\]$/);
    if (!am) return false;
    if ((el.getAttribute(am[1]) || "") !== am[2]) return false;
  }
  return true;
}

const body = mkEl("body", { innerText: "Seller Central — Business Reports" });
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
  title: "Seller Central",
  body,
  documentElement: mkEl("html"),
  querySelectorAll: (sel) => {
    if (sel === "video, audio") return [];
    if (sel === "*") return live.slice();
    if (sel.includes(":nth-of-type")) return []; // structural paths: not trusted in the stub
    if (sel.includes(",")) return live.slice(); // INTERACTIVE_SELECTOR: the stub's live list holds interactives only
    return live.filter((el) => matchesSel(el, sel));
  },
  querySelector: (sel) => {
    const all = global.document.querySelectorAll(sel);
    return all.length ? all[0] : null;
  },
};
global.location = { href: "https://sellercentral.amazon.com/reports", origin: "https://sellercentral.amazon.com" };
let listener = null;
global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: () => {},
  },
};
global.window.__proto__ = global;
global.Event = class { constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; } };

const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
new Function("window", "document", "location", "chrome", src)(
  global.window, global.document, global.location, global.chrome
);

function act(action) {
  return new Promise((resolve) => {
    listener({ kind: "jbb.content.act", action }, null, (resp) => resolve(resp));
  });
}
const byLabel = (snap, l) => (snap.interactives || []).find((i) => i.label === l);

// --- fixture ---------------------------------------------------------------
const genBtn = mkEl("button", { id: "gen-dl", innerText: "Generate Download", attrs: { "aria-label": "Generate Download" } });
const canadaBox = mkEl("input", {
  type: "checkbox", checked: true, attrs: { "aria-label": "Canada" },
});
const dateCell = mkEl("div", { innerText: "15", attrs: { "aria-selected": "false", role: "gridcell" } });
const plainBtn = mkEl("button", { innerText: "Menu" });
const disabledBtn = mkEl("button", { innerText: "Export", disabled: true });
const tabChild = mkEl("span", { innerText: "Repeat Purchase" });
const tabHost = mkEl("div", {
  innerText: "", attrs: { role: "tab" },
  shadowRoot: { children: [tabChild], querySelectorAll: (sel) => (sel === "*" ? [tabChild] : [tabChild]) },
});
live = [genBtn, canadaBox, dateCell, plainBtn, disabledBtn, tabHost];

const snap = global.window.__jbbBuildSnapshot();

// --- Fix 4: state in the snapshot -------------------------------------------
check("checkbox snapshot entry carries checked: true",
  byLabel(snap, "Canada") && byLabel(snap, "Canada").checked === true,
  JSON.stringify(byLabel(snap, "Canada")));
check("disabled button snapshot entry carries disabled: true",
  byLabel(snap, "Export") && byLabel(snap, "Export").disabled === true,
  JSON.stringify(byLabel(snap, "Export")));
check("aria-selected date cell snapshot entry carries selected: false",
  byLabel(snap, "15") && byLabel(snap, "15").selected === false,
  JSON.stringify(byLabel(snap, "15")));

// --- Fix 9: shadow-text label ----------------------------------------------
check("tab whose text lives in a shadow root is labelled by that text, not 'div'",
  snap.interactives.some((i) => i.label === "Repeat Purchase" && i.type === "tab"),
  JSON.stringify(snap.interactives.map((i) => [i.label, i.type])));

// --- Fix 1: selector re-resolution after a re-render -----------------------
{
  const ref = byLabel(snap, "Generate Download").ref;
  // The SPA redraws: the stamped node is replaced by a twin with the same
  // id and label. The old ref is dead; the remembered selector must find it.
  genBtn.isConnected = false;
  const genBtn2 = mkEl("button", { id: "gen-dl", innerText: "Generate Download", attrs: { "aria-label": "Generate Download" } });
  live = live.map((el) => (el === genBtn ? genBtn2 : el));
  const r = await act({ type: "click", target: { ref, label: "Generate Download" } });
  check("click re-resolves by the remembered selector after a re-render",
    r.ok === true && r.matchQuality === "re-resolved" && genBtn2.clicked === true,
    JSON.stringify(r));
}
{
  // The element is missing at first, appears 600ms later (a slow redraw):
  // the act retries instead of failing on the first miss.
  const lateBtn = mkEl("button", { innerText: "Late arrival" });
  setTimeout(() => { live.push(lateBtn); }, 600);
  const started = Date.now();
  const r = await act({ type: "click", target: { ref: "e999", label: "Late arrival" } });
  check("click retries across re-renders and lands when the element appears",
    r.ok === true && lateBtn.clicked === true && Date.now() - started >= 500,
    JSON.stringify(r) + " elapsed=" + (Date.now() - started));
}
{
  // Blank page at execution time (about:blank / shell after a navigation
  // during the consent wait): wait for the re-mount instead of failing.
  const savedText = body.innerText;
  body.innerText = "";
  const mountBtn = mkEl("button", { innerText: "Mounted action" });
  setTimeout(() => { body.innerText = savedText; live.push(mountBtn); }, 500);
  const r = await act({ type: "click", target: { ref: "e998", label: "Mounted action" } });
  check("click waits for a blank page to re-mount instead of failing fast",
    r.ok === true && mountBtn.clicked === true, JSON.stringify(r));
}

// --- Fix 3: post-click verification ----------------------------------------
{
  const r = await act({ type: "click", target: { label: "Canada" } });
  check("unchecking a checkbox reports VERIFIED with before/after state",
    r.ok === true && r.data && r.data.verification === "VERIFIED" &&
    r.data.stateBefore.checked === true && r.data.stateAfter.checked === false,
    JSON.stringify(r));
}
{
  const r = await act({ type: "click", target: { label: "15" } });
  check("a date click the page silently rejected reports UNCONFIRMED, not success",
    r.ok === true && r.data && r.data.verification === "UNCONFIRMED" && /UNCONFIRMED/.test(r.detail || ""),
    JSON.stringify(r));
}
{
  const r = await act({ type: "click", target: { label: "Menu" } });
  check("a plain button click reports N/A (no state to verify against)",
    r.ok === true && r.data && r.data.verification === "N/A",
    JSON.stringify(r));
}

console.log(failures === 0 ? "ALL RELIABILITY CONTENT TESTS PASSED" : failures + " RELIABILITY CONTENT TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
