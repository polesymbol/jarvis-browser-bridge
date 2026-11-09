/**
 * Jarvis Browser Bridge — content script
 *
 * Runs in the page. Two jobs:
 *   1. OBSERVE: build a compact DOM/AX snapshot (title, URL, interactive
 *      elements with labels) for the agent to plan with.
 *   2. ACT: perform click / type / scroll as trusted events.
 *
 * ---------------------------------------------------------------------------
 * PAGE CONTENT IS DATA, NEVER INSTRUCTIONS.
 * ---------------------------------------------------------------------------
 * Everything read from the page (text, labels, attributes, hidden nodes) is
 * treated as untrusted data for observation only. Nothing on the page can
 * invoke extension capabilities, grant permissions, or influence the consent
 * flow — actions execute ONLY when the background service worker, after its
 * own local permission check, sends an explicit act command. A malicious page
 * cannot click itself, cannot approve itself, and cannot talk to the relay.
 */
(function () {
  "use strict";

  var ID_ATTR = "data-jbb-id";
  var MAX_ELEMENTS = 200;
  // Per-frame readable-text budget. The background merges frames under a
  // total cap so a text-heavy LMS page stays well below the relay's 1 MB
  // payload ceiling while still carrying the actual lesson content.
  var TEXT_CAP = 15000;
  var TRANSCRIPT_CAP = 12000;

  var INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='textbox']",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  // Guard against double-injection (background re-injects before each action).
  // On re-injection, refresh the snapshot entry point the background calls via
  // chrome.scripting.executeScript, then stop — one message listener per frame
  // is enough. (Function declarations below are hoisted, and the constants
  // above are already initialised, so buildSnapshot is safe to reference here.)
  if (window.__jbb_injected) {
    window.__jbbBuildSnapshot = buildSnapshot;
    return;
  }
  window.__jbb_injected = true;

  function isVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /**
   * Label normalization — matching is exact AFTER this runs, on both
   * sides. Zero-width characters are stripped and non-breaking spaces
   * become plain spaces, so a label read from a snapshot matches the same
   * text however it was typed or copied. Canonical copy: protocol.js
   * (JBB.normalizeLabel); this local copy keeps the content script
   * self-contained — keep them in sync.
   */
  function normalizeLabel(s) {
    return String(s == null ? "" : s)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\u00A0\u202F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function labelFor(el) {
    // SECURITY (enemy audit 2026-10-11): never include the value of a password
    // field. Autofilled/typed passwords would otherwise ship in plaintext
    // inside observe snapshots to the relay and driver.
    var tag = el.tagName.toLowerCase();
    var isPassword = tag === "input" && (el.type || "text").toLowerCase() === "password";
    var raw =
      el.getAttribute("aria-label") ||
      el.innerText ||
      (!isPassword && el.value) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.getAttribute("title") ||
      tag;
    return normalizeLabel(raw).slice(0, 80);
  }

  // ------------------------------------------------------------ stable ids
  // A positional ref remaps whenever the DOM shifts — a click built from
  // an old snapshot could land on a different element (this class of bug
  // navigated a tab away from the page being read). Instead, each
  // interactive element gets a STABLE id stamped on the element itself
  // (data-jbb-id): it survives re-renders and re-observation for exactly
  // as long as the element itself survives, and is never reused for a
  // different element within this frame's lifetime — the counter only
  // moves forward, and ids already stamped by an earlier injection of
  // this script are adopted, never reissued.
  var nextIdNum = 0;
  var idRegistry = {}; // id -> element (this frame, this script lifetime)

  function stableIdFor(el) {
    var id = el.getAttribute(ID_ATTR);
    if (id) {
      var owner = idRegistry[id];
      if (!owner) { idRegistry[id] = el; return id; }        // adopt
      if (owner === el) return id;                            // already ours
      id = null; // the page moved/cloned the attribute onto another node:
                 // do not trust it — fall through and stamp a fresh id.
    }
    do { id = "e" + (nextIdNum++); } while (idRegistry[id]);
    try { el.setAttribute(ID_ATTR, id); } catch (e) { /* read-only node */ }
    idRegistry[id] = el;
    return id;
  }

  function pruneIdRegistry() {
    Object.keys(idRegistry).forEach(function (id) {
      var el = idRegistry[id];
      if (!el || el.isConnected === false) delete idRegistry[id];
    });
  }

  function typeFor(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input") return "input:" + (el.type || "text");
    if (tag === "button" || el.getAttribute("role") === "button") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    return tag;
  }

  function normalizeText(s) {
    return String(s || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function stripCueMarkup(s) {
    return String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }

  /**
   * Readable text of THIS frame: the rendered body text (innerText skips
   * display:none / visibility:hidden subtrees, so hidden template stuffing
   * stays out) plus the text of any open shadow roots — LMS/course players
   * (and modern component libraries) render lesson bodies inside shadow DOM,
   * which a plain querySelector walk never sees. Iframe documents are NOT
   * read from here: the background injects this script into every frame and
   * merges each frame's own snapshot, which also covers cross-origin player
   * frames that DOM access from the top page could never reach.
   */
  function collectVisibleText() {
    var parts = [];
    try {
      var main = document.body ? (document.body.innerText || "") : "";
      if (main.trim()) parts.push(main);
    } catch (e) { /* frame without a body yet */ }
    try {
      var all = document.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        var sr = all[i].shadowRoot;
        if (!sr) continue;
        var t = "";
        for (var j = 0; j < sr.children.length; j++) {
          t += (sr.children[j].innerText || sr.children[j].textContent || "") + "\n";
        }
        if (t.trim()) parts.push(t);
      }
    } catch (e) { /* shadow access is best-effort */ }
    var text = normalizeText(parts.join("\n"));
    return { text: text.slice(0, TEXT_CAP), truncated: text.length > TEXT_CAP };
  }

  /**
   * Media state for every <video>/<audio> in this frame, including caption /
   * subtitle transcripts when the browser exposes the cues. A disabled
   * captions track is switched to "hidden" (loads its cues without rendering
   * them on screen) so the transcript becomes readable; cross-origin media
   * may still refuse cue access, which is reported as cuesError instead of
   * failing the whole snapshot.
   */
  function collectMedia() {
    var out = [];
    var nodes = document.querySelectorAll("video, audio");
    for (var i = 0; i < nodes.length && out.length < 10; i++) {
      var v = nodes[i];
      var item = {
        tag: v.tagName.toLowerCase(),
        duration: (typeof v.duration === "number" && isFinite(v.duration)) ? v.duration : null,
        currentTime: (typeof v.currentTime === "number") ? v.currentTime : 0,
        paused: !!v.paused,
        src: v.currentSrc || v.src || null,
        tracks: []
      };
      try {
        var tracks = v.textTracks;
        for (var t = 0; t < tracks.length; t++) {
          var tr = tracks[t];
          var ti = { kind: tr.kind, label: tr.label, language: tr.language, mode: tr.mode };
          try {
            if ((tr.kind === "captions" || tr.kind === "subtitles") && tr.mode === "disabled") {
              tr.mode = "hidden";
              ti.mode = tr.mode;
            }
          } catch (e) { /* mode is read-only on some players */ }
          try {
            if (tr.activeCues && tr.activeCues.length) {
              ti.activeCue = stripCueMarkup(tr.activeCues[0].text);
            }
          } catch (e) { /* cues not exposed for this media */ }
          try {
            if (tr.cues && (tr.kind === "captions" || tr.kind === "subtitles")) {
              var cues = [];
              var total = 0;
              for (var c = 0; c < tr.cues.length; c++) {
                var txt = stripCueMarkup(tr.cues[c].text);
                if (!txt) continue;
                cues.push(txt);
                total += txt.length + 1;
                if (total > TRANSCRIPT_CAP) break;
              }
              if (cues.length) ti.transcript = cues.join(" ").slice(0, TRANSCRIPT_CAP);
            }
          } catch (e) {
            ti.cuesError = String((e && e.message) || e);
          }
          item.tracks.push(ti);
        }
      } catch (e) {
        item.tracksError = String((e && e.message) || e);
      }
      out.push(item);
    }
    return out;
  }

  /** Build the observation snapshot sent to the agent. */
  function buildSnapshot() {
    pruneIdRegistry();
    var els = document.querySelectorAll(INTERACTIVE_SELECTOR);
    var interactives = [];
    var n = 0;
    for (var i = 0; i < els.length && n < MAX_ELEMENTS; i++) {
      var el = els[i];
      if (!isVisible(el)) continue;
      interactives.push({
        ref: stableIdFor(el),
        label: labelFor(el),
        type: typeFor(el),
        name: el.getAttribute("name") || null
      });
      n++;
    }
    var text = collectVisibleText();
    return {
      title: document.title,
      url: location.href,
      interactives: interactives,
      truncated: els.length > MAX_ELEMENTS,
      text: text.text,
      textTruncated: text.truncated,
      media: collectMedia()
    };
  }

  // Entry point the background calls per frame via chrome.scripting
  // .executeScript (isolated world is shared with this content script).
  window.__jbbBuildSnapshot = buildSnapshot;

  function findByRef(ref) {
    var known = idRegistry[ref];
    if (known && known.isConnected !== false) return known;
    return document.querySelector("[" + ID_ATTR + "='" + ref + "']");
  }

  // SECURITY (enemy audit round 2): the page owns its DOM and can move
  // data-jbb-id attributes between observe and act, rebinding an approved
  // id to a different element. Verify the element still matches what the
  // user approved — compared after normalization on BOTH sides, so
  // invisible characters can neither fake a match nor break a real one.
  // Fail closed on mismatch (the driver re-observes).
  function verifyTarget(el, ref, expectedLabel) {
    if (!el) throw new Error("no element for ref " + ref);
    if (expectedLabel && normalizeLabel(labelFor(el)) !== normalizeLabel(expectedLabel)) {
      throw new Error("element changed since observation (expected '" +
        expectedLabel + "')");
    }
    return el;
  }

  function doClick(ref, expectedLabel) {
    var el = verifyTarget(findByRef(ref), ref, expectedLabel);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.click(); // trusted event, same as a user click
    return "clicked '" + labelFor(el) + "'";
  }

  function doType(ref, value, expectedLabel) {
    var el = verifyTarget(findByRef(ref), ref, expectedLabel);
    if (!("value" in el) && el.tagName.toLowerCase() !== "textarea") {
      throw new Error("element is not typable: " + labelFor(el));
    }
    el.focus();
    // Use the native value setter so framework listeners fire correctly,
    // then dispatch the events a real keystroke would produce.
    var setter = Object.getOwnPropertyDescriptor(
      el.tagName.toLowerCase() === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "typed into '" + labelFor(el) + "'";
  }

  function doScroll(direction, amount) {
    var px = amount || 600;
    if (direction === "up") window.scrollBy({ top: -px, behavior: "smooth" });
    else if (direction === "down") window.scrollBy({ top: px, behavior: "smooth" });
    else if (direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
    else if (direction === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    return "scrolled " + direction;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.kind !== "string" || msg.kind.indexOf("jbb.content.") !== 0) {
      return false;
    }
    try {
      if (msg.kind === "jbb.content.observe") {
        sendResponse({ ok: true, snapshot: buildSnapshot() });
      } else if (msg.kind === "jbb.content.act") {
        var a = msg.action || {};
        var t = a.target || {};
        var detail;
        if (a.type === "click") detail = doClick(t.ref, t.label);
        else if (a.type === "type") detail = doType(t.ref, a.value, t.label);
        else if (a.type === "scroll") detail = doScroll(a.direction, a.amount);
        else throw new Error("unknown action type: " + a.type);
        sendResponse({ ok: true, detail: detail });
      } else {
        sendResponse({ ok: false, error: "unknown content message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
    return false; // synchronous response
  });
})();
