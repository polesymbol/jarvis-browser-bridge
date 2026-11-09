// Stable-id + label-normalization test for extension/content.js.
// Run: node extension/test/content.stable-id.test.mjs
//
// Exercises the REAL content script against a stub DOM:
//  - ids survive DOM shifts and re-observation (no positional remap);
//  - a click built from the FIRST snapshot lands on the correct element
//    after the page changed (the stale-ref regression: it once navigated
//    the tab away from the page being read);
//  - an id the page clones onto another element is not trusted;
//  - labels with zero-width / non-breaking characters match their
//    visible text, on both sides.
import fs from "node:fs";

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

function el(tag, opts = {}) {
  return {
    tagName: tag.toUpperCase(),
    children: [],
    shadowRoot: null,
    innerText: opts.innerText || "",
    textContent: opts.textContent || "",
    value: opts.value,
    type: opts.type,
    isConnected: true,
    _set: {},
    clicked: 0,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    getAttribute(n) {
      if (this._set[n] !== undefined) return this._set[n];
      return (opts.attrs && opts.attrs[n]) || null;
    },
    setAttribute(n, v) { this._set[n] = v; },
    scrollIntoView() {},
    click() { this.clicked++; },
    focus() {},
  };
}

const expandBtn = el("button", { innerText: "Expand section" });
const lesson2 = el("button", { innerText: "Lesson 2" });
const quiz = el("button", { innerText: "Quiz Time" });
const lesson3 = el("button", { innerText: "Les\u200Bson\u00A03" }); // ZWSP + NBSP baked in
let interactives = [expandBtn, lesson2, quiz, lesson3];

let listener = null;
global.window = {
  getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  HTMLInputElement: function () {},
  HTMLTextAreaElement: function () {},
};
global.document = {
  title: "Course",
  body: el("body", { innerText: "course body" }),
  querySelectorAll: (sel) => {
    if (sel === "*") return [];
    if (sel === "video, audio") return [];
    return interactives;
  },
  querySelector: (sel) => {
    const m = /\[data-jbb-id='([^']+)'\]/.exec(sel);
    if (!m) return null;
    return interactives.find((e) => e.getAttribute("data-jbb-id") === m[1]) || null;
  },
};
global.location = { href: "https://academy.example.com/course" };
global.chrome = { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } };
global.window.__proto__ = global;

const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
new Function("window", "document", "location", "chrome", src)(
  global.window, global.document, global.location, global.chrome
);

function act(ref, label) {
  let resp = null;
  listener({ kind: "jbb.content.act", action: { type: "click", target: { ref, label } } }, {}, (r) => { resp = r; });
  return resp;
}

// --- snapshot 1: ids are assigned
const s1 = global.window.__jbbBuildSnapshot();
const byLabel = {};
s1.interactives.forEach((i) => { byLabel[i.label] = i.ref; });
check("four interactives in snapshot 1", s1.interactives.length === 4);
check("invisible characters are normalized out of snapshot labels",
  !!byLabel["Lesson 3"] && !s1.interactives.some((i) => i.label.includes("\u200B") || i.label.includes("\u00A0")));

// --- the page changes: a NEW element is inserted at the front (DOM shift)
const inserted = el("button", { innerText: "New banner button" });
interactives = [inserted, expandBtn, lesson2, quiz, lesson3];
const s2 = global.window.__jbbBuildSnapshot();
const byLabel2 = {};
s2.interactives.forEach((i) => { byLabel2[i.label] = i.ref; });
check("existing ids do NOT remap after a DOM shift",
  byLabel2["Expand section"] === byLabel["Expand section"] &&
  byLabel2["Lesson 2"] === byLabel["Lesson 2"] &&
  byLabel2["Quiz Time"] === byLabel["Quiz Time"]);
check("the inserted element gets a fresh, unused id",
  !!byLabel2["New banner button"] && !Object.values(byLabel).includes(byLabel2["New banner button"]));

// --- acceptance: click a second element using ids from the FIRST snapshot
const r1 = act(byLabel["Lesson 2"], "Lesson 2");
check("click from snapshot 1 lands on the correct element after expansion/shift",
  r1 && r1.ok === true && lesson2.clicked === 1 && expandBtn.clicked === 0 && inserted.clicked === 0);

// --- invisible-char labels match their visible text, both directions
const r2 = act(byLabel["Lesson 3"], "Lesson 3");
check("snapshot label (ZWSP/NBSP inside) matches plain expected label", r2 && r2.ok === true && lesson3.clicked === 1);
const r3 = act(byLabel["Quiz Time"], "Quiz\u00A0Time");
check("expected label carrying NBSP matches the plain element label", r3 && r3.ok === true && quiz.clicked === 1);

// --- wrong label still fails closed (never the wrong element)
const r4 = act(byLabel["Expand section"], "Delete account");
check("label mismatch refuses the click", r4 && r4.ok === false && expandBtn.clicked === 0);

// --- the page clones a stamped id onto a different element: not trusted
const victim = el("button", { innerText: "Victim" });
interactives = [expandBtn, lesson2, quiz, lesson3, victim];
const s3 = global.window.__jbbBuildSnapshot();
const victimId = s3.interactives.find((i) => i.label === "Victim").ref;
const impostor = el("button", { innerText: "Impostor" });
impostor.setAttribute("data-jbb-id", victimId); // page moves the attribute
interactives = [expandBtn, lesson2, quiz, lesson3, victim, impostor];
const s4 = global.window.__jbbBuildSnapshot();
const impostorRef = s4.interactives.find((i) => i.label === "Impostor").ref;
const victimRef4 = s4.interactives.find((i) => i.label === "Victim").ref;
check("a cloned id is re-stamped, never adopted by the impostor",
  impostorRef !== victimId && victimRef4 === victimId);

console.log(failures === 0 ? "ALL STABLE-ID TESTS PASSED" : failures + " STABLE-ID CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
