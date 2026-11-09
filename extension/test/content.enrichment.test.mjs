// Snapshot-enrichment + fallback-act test for extension/content.js.
// Run: node extension/test/content.enrichment.test.mjs
//
// Exercises the REAL content script against a stub DOM:
//  - text pagination: a 40k-char page ships a 15k chunk + offsets, and
//    the final chunk carries the completion message the old cap hid;
//  - every interactive carries href (links), bounding box, inViewport;
//  - scroll state is present and contentChanged tracks page changes;
//  - label-only acts resolve exact -> fuzzy, fail closed when ambiguous;
//  - clickAt (elementFromPoint) and clickSelector click the right nodes.
import fs from "node:fs";

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

function el(tag, opts = {}) {
  const e = {
    tagName: tag.toUpperCase(),
    children: [],
    shadowRoot: null,
    innerText: opts.innerText || "",
    textContent: opts.textContent || "",
    value: opts.value,
    type: opts.type,
    href: opts.href,
    isConnected: true,
    _set: {},
    clicked: 0,
    _rect: opts.rect || { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 },
    getBoundingClientRect() { return this._rect; },
    getAttribute(n) {
      if (this._set[n] !== undefined) return this._set[n];
      if (n === "href") return opts.hrefAttr || null;
      return (opts.attrs && opts.attrs[n]) || null;
    },
    setAttribute(n, v) { this._set[n] = v; },
    scrollIntoView() {},
    click() { this.clicked++; },
    focus() {},
  };
  return e;
}

const TAIL = "COURSE COMPLETED";
const bodyText = "a".repeat(40000 - TAIL.length) + TAIL;
const body = el("body", { innerText: bodyText });

const link = el("a", { innerText: "Next lesson", href: "https://academy.example.com/lesson/2",
  hrefAttr: "/lesson/2", rect: { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 } });
const belowFold = el("button", { innerText: "Hidden below", rect: { left: 10, top: 5000, right: 110, bottom: 5020, width: 100, height: 20 } });
const lessonBtn = el("button", { innerText: "Lesson 2: Getting started" });
const settingsBtn = el("button", { innerText: "Settings" });
const siteSettingsBtn = el("button", { innerText: "Site settings" });
const interactives = [link, belowFold, lessonBtn, settingsBtn, siteSettingsBtn];

let listener = null;
global.window = {
  getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  HTMLInputElement: function () {},
  HTMLTextAreaElement: function () {},
  innerHeight: 800,
  innerWidth: 1200,
  scrollY: 120,
};
global.document = {
  title: "Long course page",
  body,
  documentElement: { scrollHeight: 5000 },
  querySelectorAll: (sel) => {
    if (sel === "*") return [];
    if (sel === "video, audio") return [];
    return interactives;
  },
  querySelector: (sel) => {
    const m = /\[data-jbb-id='([^']+)'\]/.exec(sel);
    if (m) return interactives.find((e) => e.getAttribute("data-jbb-id") === m[1]) || null;
    if (sel === "#go") return siteSettingsBtn;
    return null;
  },
  elementFromPoint: (x, y) => (x === 50 && y === 60 ? settingsBtn : null),
};
global.location = { href: "https://academy.example.com/course" };
global.chrome = { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } };
global.window.__proto__ = global;

const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
new Function("window", "document", "location", "chrome", src)(
  global.window, global.document, global.location, global.chrome
);

function act(action) {
  let resp = null;
  listener({ kind: "jbb.content.act", action }, {}, (r) => { resp = r; });
  return resp;
}

// ---------------------------------------------------------- pagination (acceptance)
const s1 = global.window.__jbbBuildSnapshot();
check("first chunk is capped at 15000 with pagination metadata",
  s1.text_chunk.length === 15000 && s1.text_offset === 0 &&
  s1.text_total_chars === 40000 && s1.text_next_offset === 15000 && s1.text === s1.text_chunk);
const sTail = global.window.__jbbBuildSnapshot({ textOffset: s1.text_next_offset * 2 });
check("the final chunk carries the completion message the 15k cap used to hide",
  sTail.text_offset === 30000 && sTail.text_chunk.includes(TAIL) && sTail.text_next_offset === null);

// ---------------------------------------------------------- element fields
const linkSnap = s1.interactives.find((i) => i.label === "Next lesson");
check("every link carries its real (absolute) href", linkSnap.href === "https://academy.example.com/lesson/2");
check("non-links carry href: null", s1.interactives.find((i) => i.label === "Settings").href === null);
check("bounding boxes are present and rounded",
  linkSnap.box.x === 10 && linkSnap.box.y === 10 && linkSnap.box.width === 100 && linkSnap.box.height === 20);
check("inViewport distinguishes on-screen from below-the-fold",
  linkSnap.inViewport === true && s1.interactives.find((i) => i.label === "Hidden below").inViewport === false);

// ---------------------------------------------------------- scroll state + change flag
check("scroll state rides every snapshot",
  s1.scroll.y === 120 && s1.scroll.height === 5000 && s1.scroll.viewportHeight === 800);
check("first snapshot reports contentChanged: false", s1.scroll.contentChanged === false);
body.innerText = bodyText + " NEW SECTION";
const s2 = global.window.__jbbBuildSnapshot();
check("changed page reports contentChanged: true", s2.scroll.contentChanged === true);
const s3 = global.window.__jbbBuildSnapshot();
check("unchanged page reports contentChanged: false again", s3.scroll.contentChanged === false);
body.innerText = bodyText;

// ---------------------------------------------------------- fuzzy label fallback
let r = act({ type: "click", target: { ref: null, label: "Lesson 2: Getting started" } });
check("label-only act: exact match, quality reported",
  r && r.ok === true && r.matchQuality === "exact" && lessonBtn.clicked === 1);
r = act({ type: "click", target: { ref: null, label: "lesson 2" } });
check("label-only act: unique case-insensitive substring is a fuzzy match",
  r && r.ok === true && r.matchQuality === "fuzzy" && lessonBtn.clicked === 2);
r = act({ type: "click", target: { ref: null, label: "settings" } });
check("ambiguous fuzzy match fails closed (nothing clicked)",
  r && r.ok === false && settingsBtn.clicked === 0 && siteSettingsBtn.clicked === 0);
r = act({ type: "click", target: { ref: null, label: "No such thing" } });
check("unmatched label fails", r && r.ok === false);

// ---------------------------------------------------------- coordinate + selector fallbacks (acceptance)
r = act({ type: "clickAt", point: { x: 50, y: 60 } });
check("clickAt clicks the element at those coordinates",
  r && r.ok === true && settingsBtn.clicked === 1 && /Settings/.test(r.detail));
r = act({ type: "clickAt", point: { x: 999, y: 999 } });
check("clickAt with nothing at the point fails", r && r.ok === false);
r = act({ type: "clickSelector", selector: "#go" });
check("clickSelector clicks the selected element", r && r.ok === true && siteSettingsBtn.clicked === 1);
r = act({ type: "clickSelector", selector: ".missing" });
check("clickSelector with no match fails", r && r.ok === false);

console.log(failures === 0 ? "ALL ENRICHMENT TESTS PASSED" : failures + " ENRICHMENT CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
