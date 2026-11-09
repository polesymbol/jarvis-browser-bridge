// Media test for extension/content.js: verified media control with
// failure reasons, caption ranges, frame grabs.
// Run: node extension/test/content.media.test.mjs
//
// The acceptance bar from the brief: a blocked video reports its
// REASON (autoplay-blocked), a playing video reports currentTime
// ADVANCING (cross-checked across two samples — never claimed from
// paused:false alone), caption text comes back for a time range, and a
// frame grab returns a real image (or an honest taint refusal).
import fs from "node:fs";

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

class Ev {
  constructor(type) { this.type = type; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
}
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = []; this.shadowRoot = null;
    this.innerText = ""; this.textContent = "";
    this.isConnected = true; this.listeners = {};
    this._set = {}; this._hidden = false;
    this._rect = { left: 10, top: 10, right: 650, bottom: 370, width: 640, height: 360 };
  }
  getBoundingClientRect() { return this._rect; }
  getAttribute(n) { return this._set[n] !== undefined ? this._set[n] : null; }
  setAttribute(n, v) { this._set[n] = v; }
  scrollIntoView() {}
  focus() {}
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatchEvent(ev) { (this.listeners[ev.type] || []).slice().forEach((f) => f(ev)); return true; }
}

const track = {
  kind: "captions", label: "English", language: "en", mode: "disabled",
  cues: [
    { startTime: 0, endTime: 4, text: "Welcome to the lesson" },
    { startTime: 65, endTime: 70, text: "<i>Now the good part</i>" },
    { startTime: 130, endTime: 135, text: "Wrap up and next steps" },
  ],
  activeCues: [],
};

// A controllable fake player. behavior: blocked | playing | srcerror
const media = new El("video");
media.id = "deck-player";
media.className = "deck-player";
media.currentTime = 0; media.duration = 2100;
media.paused = true; media.ended = false;
media.error = null; media.networkState = 2; media.readyState = 4;
media.videoWidth = 1280; media.videoHeight = 720;
media.currentSrc = "https://cdn.example.com/lesson.mp4";
media.src = media.currentSrc;
media.textTracks = [track];
media.behavior = "blocked";
let advanceTimer = null;
media.play = function () {
  if (media.behavior === "blocked") {
    const e = new Error("play() failed because the user didn't interact with the document first");
    e.name = "NotAllowedError";
    return Promise.reject(e);
  }
  if (media.behavior === "srcerror") {
    media.error = { code: 4, message: "MEDIA_ERR_SRC_NOT_SUPPORTED" };
    return Promise.resolve(); // resolves, never plays
  }
  media.paused = false;
  advanceTimer = setInterval(() => { media.currentTime += 0.3; }, 100);
  return Promise.resolve();
};
media.pause = function () { media.paused = true; if (advanceTimer) clearInterval(advanceTimer); };

let tainted = false;
const body = new El("body");
let listener = null;
global.window = {
  getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  HTMLInputElement: function () {}, HTMLTextAreaElement: function () {},
  innerHeight: 800, innerWidth: 1200, scrollY: 0,
};
global.document = {
  title: "Lesson", body, readyState: "complete",
  documentElement: { scrollHeight: 900 },
  querySelectorAll: (sel) => (sel === "video, audio" ? [media] : []),
  querySelector: () => null,
  createElement: (tag) => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => {
      if (tainted) { const e = new Error("The canvas has been tainted by cross-origin data."); e.name = "SecurityError"; throw e; }
      return "data:image/jpeg;base64," + Buffer.from("JPEGDATA").toString("base64");
    },
  }),
};
global.location = { href: "https://academy.example.com/lesson", origin: "https://academy.example.com" };
global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: () => Promise.resolve({}),
  },
};
global.window.top = global.window;
global.Event = Ev;

const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
new Function("window", "document", "location", "chrome", src)(
  global.window, global.document, global.location, global.chrome
);
function act(action) {
  return new Promise((resolve) => { listener({ kind: "jbb.content.act", action }, {}, resolve); });
}

// 1. Blocked play reports the reason, not just paused:true.
let r = await act({ type: "media", media: { action: "play" } });
check("blocked video reports paused:true WITH the reason (autoplay-blocked)",
  r.ok && r.data.verified === false && r.data.paused === true && r.data.reason === "autoplay-blocked" &&
  /reason: autoplay-blocked/.test(r.detail));

// 2. Source error reports as source-error.
media.behavior = "srcerror";
r = await act({ type: "media", media: { action: "play" } });
check("source error is named", r.ok && r.data.verified === false && /^source-error/.test(r.data.reason || ""));
media.error = null;

// 3. A playing video is verified by currentTime ADVANCING.
media.behavior = "playing";
r = await act({ type: "media", media: { action: "play" } });
check("playing video verifies via advancing currentTime",
  r.ok && r.data.verified === true && r.data.paused === false && /currentTime advancing/.test(r.detail));

// 4. Pause verifies.
r = await act({ type: "media", media: { action: "pause" } });
check("pause verifies", r.ok && r.data.verified === true && r.data.paused === true);

// 5. Seek verifies against the target.
r = await act({ type: "media", media: { action: "seek", seekTo: 120 } });
check("seek lands on the target", r.ok && r.data.verified === true && Math.abs(r.data.currentTime - 120) < 2);

// 6. Captions for a time range: only overlapping cues, markup stripped.
r = await act({ type: "captions", from: 60, to: 140 });
check("caption text is retrievable for a time range",
  r.ok && r.data.cues.length === 2 && r.data.text.includes("Now the good part") &&
  !r.data.text.includes("<i>") && r.data.track.language === "en");
check("reading captions loads a disabled track (hidden mode)",
  track.mode === "hidden");

// 7. Full-range captions return everything.
r = await act({ type: "captions", from: 0 });
check("full-range captions return all cues", r.ok && r.data.cues.length === 3);

// 8. Frame grab returns an image of the video.
r = await act({ type: "frameGrab" });
check("frame_grab returns a JPEG data URL at the current time",
  r.ok && /^data:image\/jpeg/.test(r.data.dataUrl) && r.data.width === 640 && r.data.height === 360);

// 9. Frame grab at a requested timestamp seeks first.
r = await act({ type: "frameGrab", at: 300 });
check("frame_grab at a timestamp seeks, then grabs",
  r.ok && Math.abs(r.data.currentTime - 300) < 1);

// 10. Tainted canvas (DRM/cross-origin) refuses honestly.
tainted = true;
r = await act({ type: "frameGrab" });
check("tainted canvas refuses with the reason", !r.ok && /tainted/.test(r.error));

console.log(failures === 0 ? "ALL CONTENT MEDIA TESTS PASSED" : failures + " CONTENT MEDIA CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
