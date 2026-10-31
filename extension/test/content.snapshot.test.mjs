// Snapshot-builder test for extension/content.js — run: node extension/test/content.snapshot.test.mjs
// Exercises buildSnapshot() against a stub DOM: body text, open shadow-root
// text, video caption transcript (disabled track -> hidden -> cues), refs.
// No dependencies; if this fails, the observe snapshot contract changed.
import fs from "node:fs";

function el(tag, opts = {}) {
  return {
    tagName: tag.toUpperCase(),
    children: opts.children || [],
    shadowRoot: opts.shadowRoot || null,
    innerText: opts.innerText || "",
    textContent: opts.textContent || "",
    value: opts.value,
    type: opts.type,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    getAttribute: (n) => (opts.attrs && opts.attrs[n]) || null,
    setAttribute: function (n, v) { (this._set ||= {})[n] = v; },
  };
}

const shadowChild = el("div", { innerText: "Shadow lesson body: bidding strategies explained." });
const host = el("div", { shadowRoot: { children: [shadowChild] } });

const playBtn = el("button", { innerText: "Play" });
const video = {
  tagName: "VIDEO",
  duration: 754,
  currentTime: 12,
  paused: true,
  currentSrc: "https://cdn.example.com/lesson.mp4",
  src: "https://cdn.example.com/lesson.mp4",
  textTracks: [
    {
      kind: "captions", label: "English", language: "en", mode: "disabled",
      activeCues: null,
      cues: [
        { text: "Welcome to <b>Amazon Ads</b>." },
        { text: "Today we cover sponsored products." },
      ],
    },
  ],
};

const body = el("body", { innerText: "Getting started with Amazon Ads\nLesson overview text." });

const allElements = [host, playBtn];
const interactives = [playBtn];

global.window = {
  getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  HTMLInputElement: function () {},
  HTMLTextAreaElement: function () {},
};
global.document = {
  title: "Academy Lesson",
  body,
  querySelectorAll: (sel) => {
    if (sel === "*") return allElements;
    if (sel === "video, audio") return [video];
    return interactives; // INTERACTIVE_SELECTOR
  },
  querySelector: () => null,
};
global.location = { href: "https://academy.example.com/lesson/1" };
global.chrome = { runtime: { onMessage: { addListener: () => {} } } };
global.window.__proto__ = global;

const contentPath = new URL("../content.js", import.meta.url);
const src = fs.readFileSync(contentPath, "utf8");
// content.js references bare `window`, `document`, `location`, `chrome` and
// `window.getComputedStyle`; run it with those as globals.
new Function("window", "document", "location", "chrome", src)(
  global.window, global.document, global.location, global.chrome
);

const snap = global.window.__jbbBuildSnapshot();

const checks = [
  ["top text present", snap.text.includes("Lesson overview text")],
  ["shadow text present", snap.text.includes("Shadow lesson body")],
  ["media captured", Array.isArray(snap.media) && snap.media.length === 1],
  ["transcript captured", snap.media[0].tracks[0].transcript === "Welcome to Amazon Ads. Today we cover sponsored products."],
  ["track switched to hidden", snap.media[0].tracks[0].mode === "hidden"],
  ["interactive ref", snap.interactives.length === 1 && snap.interactives[0].ref === "e0"],
];
let fail = 0;
for (const [name, ok] of checks) { console.log((ok ? "PASS" : "FAIL") + " " + name); if (!ok) fail++; }
process.exit(fail ? 1 : 0);
