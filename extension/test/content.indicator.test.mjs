// Capture indicator test for extension/content.js.
// Run: node extension/test/content.indicator.test.mjs
//
// The non-negotiable: capture never runs without a visible indicator.
// The pill appears when capture starts, carries its own Stop button
// (which both notifies the background and removes the pill), and
// disappears when capture stops.
import fs from "node:fs";

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.style = { cssText: "" };
    this.listeners = {}; this.textContent = ""; this.id = "";
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((f) => f({})); }
  remove() { this.removed = true; }
}
const body = new Node("body");
body.innerText = "";
const runtimeSent = [];
let listener = null;
global.window = {
  getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  HTMLInputElement: function () {}, HTMLTextAreaElement: function () {},
  innerHeight: 800, innerWidth: 1200, scrollY: 0,
};
global.document = {
  title: "Lesson", body, readyState: "complete",
  documentElement: new Node("html"),
  createElement: (tag) => new Node(tag),
  querySelectorAll: () => [],
  querySelector: () => null,
};
global.location = { href: "https://academy.example.com/lesson", origin: "https://academy.example.com" };
global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg) => { runtimeSent.push(msg); return Promise.resolve({}); },
  },
};
global.window.top = global.window;
global.Event = class { constructor(t) { this.type = t; } };

const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
new Function("window", "document", "location", "chrome", src)(
  global.window, global.document, global.location, global.chrome
);

function indicator(active) {
  return new Promise((resolve) => {
    listener({ kind: "jbb.capture.indicator", active }, {}, resolve);
  });
}

await indicator(true);
const pill = body.children.find((c) => c.id === "jbb-capture-pill");
check("starting capture shows the indicator pill",
  !!pill && pill.children.some((c) => /listening to this tab/.test(c.textContent || "")));
const stopBtn = pill && pill.children.find((c) => c.tagName === "BUTTON");
check("the pill carries its own Stop button", !!stopBtn);
stopBtn.click();
check("Stop notifies the background and removes the pill",
  runtimeSent.some((m) => m.kind === "jbb.capture.stopRequest") && pill.removed === true);

await indicator(true);
const pill2 = body.children.filter((c) => c.id === "jbb-capture-pill" && !c.removed).pop();
await indicator(false);
check("stopping capture removes the indicator", !!pill2 && pill2.removed === true);

console.log(failures === 0 ? "ALL INDICATOR TESTS PASSED" : failures + " INDICATOR CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
