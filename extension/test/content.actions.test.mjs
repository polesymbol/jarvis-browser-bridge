// Full-action-vocabulary test for extension/content.js.
// Run: node extension/test/content.actions.test.mjs
//
// Exercises the REAL content script against a stub DOM:
//  - press_key: keydown/keypress/keyup with key+code+modifiers on a
//    targeted element (and on the focused element with no target);
//    Enter submits the enclosing form; password fields refuse;
//  - hover: dispatches the mouse sequence and reports what appeared;
//    the new items are in the next snapshot;
//  - select_option: by value and by visible text, change event fires;
//  - set_value: the React case — a controlled input whose instance
//    setter swallows plain assignment still updates app state via the
//    native prototype setter; password fields refuse; the value never
//    appears in the result detail;
//  - drag: pointer/mouse down-move-up sequence from element to element.
import fs from "node:fs";

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

class Ev {
  constructor(type, init = {}) {
    this.type = type; this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable;
    this.key = init.key; this.code = init.code;
    this.ctrlKey = !!init.ctrlKey; this.altKey = !!init.altKey;
    this.shiftKey = !!init.shiftKey; this.metaKey = !!init.metaKey;
    this.clientX = init.clientX; this.clientY = init.clientY; this.button = init.button;
    this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
}
class Kbd extends Ev {}
class Mouse extends Ev {}
class Pointer extends Mouse {}

const eventSeq = [];
class El {
  constructor(tag, opts = {}) {
    this.tagName = tag.toUpperCase();
    this.children = []; this.shadowRoot = null;
    this.innerText = opts.innerText || "";
    this.textContent = opts.textContent || this.innerText;
    this.type = opts.type; this.href = opts.href; this.isConnected = true;
    this._set = {}; this.events = []; this.listeners = {};
    this.clicked = 0; this.form = opts.form || null;
    this._hidden = !!opts.hidden;
    this._rect = opts.hidden ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
                             : (opts.rect || { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 });
    if (opts.ariaLabel) this._set["aria-label"] = opts.ariaLabel;
    if (opts.placeholder) this._set.placeholder = opts.placeholder;
  }
  getBoundingClientRect() { return this._rect; }
  getAttribute(n) { return this._set[n] !== undefined ? this._set[n] : null; }
  setAttribute(n, v) { this._set[n] = v; }
  scrollIntoView() {}
  click() { this.clicked++; }
  focus() { global.document.activeElement = this; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatchEvent(ev) {
    this.events.push(ev); eventSeq.push({ el: this, ev });
    (this.listeners[ev.type] || []).slice().forEach((f) => f(ev));
    return !ev.defaultPrevented;
  }
}
class Input extends El {
  constructor(opts = {}) { super("input", opts); this._val = opts.value || ""; }
}
Object.defineProperty(Input.prototype, "value", {
  get() { return this._val; }, set(v) { this._val = v; }, configurable: true,
});
class Select extends El {
  constructor(opts = {}) {
    super("select", opts);
    this.options = opts.options || [];
    this.value = this.options.length ? this.options[0].value : "";
  }
}

// ---------------------------------------------------------- fixtures
const formStub = { submitted: 0, requestSubmit() { this.submitted++; } };
const search = new Input({ ariaLabel: "Search", form: formStub });

const react = new Input({ ariaLabel: "Coupon code" });
react._tracked = react._val;
Object.defineProperty(react, "value", {
  get() { return this._val; },
  set(v) { this._val = v; this._tracked = v; }, // React's instance tracker: assignment looks "seen"
  configurable: true,
});
const appState = { coupon: "(unset)" };
react.addEventListener("input", () => {
  if (react._val !== react._tracked) { appState.coupon = react._val; react._tracked = react._val; }
});

const pw = new Input({ ariaLabel: "Password", type: "password" });

const country = new Select({ ariaLabel: "Country", options: [
  { value: "", text: "Choose…", textContent: "Choose…" },
  { value: "IN", text: "India", textContent: "India" },
  { value: "US", text: "United States", textContent: "United States" },
] });

const menuBtn = new El("button", { innerText: "Products" });
const menuA = new El("a", { innerText: "New arrivals", hidden: true, href: "https://shop.example.com/new" });
const menuB = new El("a", { innerText: "Best sellers", hidden: true, href: "https://shop.example.com/best" });
menuBtn.addEventListener("mouseover", () => {
  [menuA, menuB].forEach((m) => {
    m._hidden = false;
    m._rect = { left: 10, top: 40, right: 110, bottom: 60, width: 100, height: 20 };
  });
});

const card = new El("div", { innerText: "Card A", rect: { left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 } });
const drop = new El("div", { innerText: "Drop zone", rect: { left: 300, top: 200, right: 400, bottom: 250, width: 100, height: 50 } });

const interactives = [search, react, pw, country, menuBtn, menuA, menuB, card, drop];
const body = new El("body", { innerText: "shop page" });

let listener = null;
global.window = {
  getComputedStyle: (e) => ({ visibility: e && e._hidden ? "hidden" : "visible", display: e && e._hidden ? "none" : "block" }),
  HTMLInputElement: Input, HTMLTextAreaElement: Input,
  PointerEvent: Pointer, MouseEvent: Mouse, KeyboardEvent: Kbd, Event: Ev,
  innerHeight: 800, innerWidth: 1200, scrollY: 0,
};
global.document = {
  title: "Shop", body, activeElement: null,
  documentElement: { scrollHeight: 900 },
  querySelectorAll: (sel) => (sel === "*" || sel === "video, audio" ? [] : interactives),
  querySelector: (sel) => {
    const m = /\[data-jbb-id='([^']+)'\]/.exec(sel);
    return m ? interactives.find((e) => e.getAttribute("data-jbb-id") === m[1]) || null : null;
  },
  elementFromPoint: (x, y) => (x >= 300 && y >= 200 ? drop : x < 100 && y < 50 ? card : null),
};
global.location = { href: "https://shop.example.com/" };
global.chrome = { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } };
global.window.__proto__ = global;
global.Event = Ev; global.KeyboardEvent = Kbd; global.MouseEvent = Mouse; global.PointerEvent = Pointer;

const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
new Function("window", "document", "location", "chrome", src)(
  global.window, global.document, global.location, global.chrome
);

function act(action) {
  let resp = null;
  listener({ kind: "jbb.content.act", action }, {}, (r) => { resp = r; });
  return resp;
}
function actAsync(action) {
  return new Promise((resolve) => {
    listener({ kind: "jbb.content.act", action }, {}, resolve);
  });
}
global.window.__jbbBuildSnapshot();

// ---------------------------------------------------------- press_key
let r = act({ type: "key", key: "Enter", target: { label: "Search" } });
const kd = search.events.find((e) => e.type === "keydown");
check("press_key Enter: keydown/keypress-less/keyup sequence with key+code",
  r.ok && !!kd && kd.key === "Enter" && kd.code === "Enter" &&
  !search.events.some((e) => e.type === "keypress") && search.events.some((e) => e.type === "keyup"));
check("Enter submitted the enclosing form", formStub.submitted === 1 && /form submitted/.test(r.detail));
search.events.length = 0;
r = act({ type: "key", key: "Ctrl+a", target: { label: "Search" } });
const combo = search.events.find((e) => e.type === "keydown");
check("combo Ctrl+a parses modifiers and code",
  r.ok && combo.key === "a" && combo.code === "KeyA" && combo.ctrlKey === true && combo.shiftKey === false);
global.document.activeElement = search;
search.events.length = 0;
r = act({ type: "key", key: "Escape", target: {} });
check("no target → the focused element receives the key",
  r.ok && search.events.some((e) => e.type === "keydown" && e.key === "Escape"));
r = act({ type: "key", key: "Enter", target: { label: "Password" } });
check("press_key on a password field is refused", !r.ok && /password/.test(r.error));

// ---------------------------------------------------------- set_value (the React case)
react.value = "PLAIN"; // what a naive assignment does
react.dispatchEvent(new Ev("input", { bubbles: true }));
check("control: plain assignment is swallowed by the controlled input (app state unchanged)",
  appState.coupon === "(unset)");
react._val = ""; react._tracked = "";
r = await actAsync({ type: "setValue", value: "DIWALI10", target: { label: "Coupon code" } });
check("set_value updates the React app's state via the native setter",
  r.ok && appState.coupon === "DIWALI10");
check("set_value detail names the field, never the value",
  /Coupon code/.test(r.detail) && !/DIWALI10/.test(r.detail));
r = act({ type: "setValue", value: "x", target: { label: "Password" } });
check("set_value on a password field is refused", !r.ok && /password/.test(r.error));
r = act({ type: "type", value: "x", target: { label: "Password" } });
check("type into a password field is refused too", !r.ok && /password/.test(r.error));

// ---------------------------------------------------------- select_option
r = await actAsync({ type: "select", optionText: "India", target: { label: "Country" } });
check("select by visible text sets the value and fires change",
  r.ok && country.value === "IN" && country.events.some((e) => e.type === "change") && /India/.test(r.detail));
country.value = "";
r = await actAsync({ type: "select", optionValue: "US", target: { label: "Country" } });
check("select by value works", r.ok && country.value === "US");
r = act({ type: "select", optionValue: "ZZ", target: { label: "Country" } });
check("unknown option fails closed", !r.ok && /no option/.test(r.error));
r = await actAsync({ type: "select", optionValue: "IN", target: { label: "Search" } });
check("select on a non-<select> is refused", !r.ok && /not a <select>/.test(r.error));

// ---------------------------------------------------------- hover
const before = global.window.__jbbBuildSnapshot();
check("menu items are absent from the snapshot before hover",
  !before.interactives.some((i) => i.label === "New arrivals"));
r = await actAsync({ type: "hover", target: { label: "Products" } });
check("hover reports what appeared",
  r.ok && /appeared: New arrivals, Best sellers/.test(r.detail) &&
  Array.isArray(r.appeared) && r.appeared.length === 2);
const after = global.window.__jbbBuildSnapshot();
check("the appeared items are in the next snapshot",
  after.interactives.some((i) => i.label === "New arrivals") &&
  after.interactives.some((i) => i.label === "Best sellers"));

// ---------------------------------------------------------- drag
eventSeq.length = 0;
r = act({ type: "drag", dragFrom: { label: "Card A" }, dragTo: { label: "Drop zone" } });
const downIdx = eventSeq.findIndex((s) => s.el === card && s.ev.type === "mousedown");
const upIdx = eventSeq.findIndex((s) => s.el === drop && s.ev.type === "mouseup");
check("drag fires down on the source, moves, and up on the destination",
  r.ok && downIdx !== -1 && upIdx > downIdx &&
  eventSeq.some((s) => s.ev.type === "mousemove"));
const up = eventSeq[upIdx] && eventSeq[upIdx].ev;
check("drag lands at the destination center", !!up && up.clientX === 350 && up.clientY === 225);

console.log(failures === 0 ? "ALL CONTENT ACTION TESTS PASSED" : failures + " CONTENT ACTION CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
