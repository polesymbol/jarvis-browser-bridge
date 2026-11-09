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
  // Per-frame text CHUNK size: a snapshot ships at most this many chars of
  // page text, plus offset/total metadata so the driver can page through
  // the rest (observe --text-offset). The background merges frames under a
  // total cap so a text-heavy LMS page stays well below the relay's 1 MB
  // payload ceiling while still carrying the actual lesson content.
  var TEXT_CAP = 15000;
  // Absolute collection ceiling per frame: pagination is how you read a
  // huge page, not unbounded memory. total_chars reports what was
  // collected; collectionTruncated says the page had even more.
  var COLLECT_CAP = 200000;
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
    return { text: text.slice(0, COLLECT_CAP), truncated: text.length > COLLECT_CAP };
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
          var ti = { kind: tr.kind, label: tr.label, language: tr.language, mode: tr.mode,
                     active: tr.mode === "showing", cues: null };
          try { ti.cues = tr.cues ? tr.cues.length : null; } catch (e) { /* counted below via transcript path */ }
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

  // Signature of the page's readable content, kept between snapshots so
  // each snapshot can say whether new content loaded since the last one
  // (infinite-scroll feeds, lazy lesson bodies). Cheap on purpose:
  // length + element count + head/tail samples.
  var lastPageSignature = null;
  function pageSignature(text, count) {
    return text.length + ":" + count + ":" + text.slice(0, 64) + "|" + text.slice(-64);
  }

  function boxFor(el) {
    var r = el.getBoundingClientRect();
    var box = {
      x: Math.round(r.left), y: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height)
    };
    var inViewport = r.bottom > 0 && r.right > 0 &&
      r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0);
    return { box: box, inViewport: inViewport };
  }

  function hrefFor(el) {
    if (el.tagName.toLowerCase() !== "a") return null;
    var h = null;
    try { h = el.href; } catch (e) { /* exotic node */ }
    if (typeof h !== "string" || !h) h = el.getAttribute("href");
    return h || null;
  }

  /** Build the observation snapshot sent to the agent. */
  function buildSnapshot(opts) {
    opts = opts || {};
    pruneIdRegistry();
    var els = document.querySelectorAll(INTERACTIVE_SELECTOR);
    var interactives = [];
    var n = 0;
    for (var i = 0; i < els.length && n < MAX_ELEMENTS; i++) {
      var el = els[i];
      if (!isVisible(el)) continue;
      var geo = boxFor(el);
      interactives.push({
        ref: stableIdFor(el),
        label: labelFor(el),
        type: typeFor(el),
        name: el.getAttribute("name") || null,
        href: hrefFor(el),
        box: geo.box,
        inViewport: geo.inViewport
      });
      n++;
    }
    var collected = collectVisibleText();
    var fullText = collected.text;
    // Text pagination: ship one TEXT_CAP chunk at the requested offset;
    // the tail is one observe --text-offset away, never silently lost.
    var offset = Math.max(0, opts.textOffset | 0);
    if (offset > fullText.length) offset = fullText.length;
    var chunk = fullText.slice(offset, offset + TEXT_CAP);
    var sig = pageSignature(fullText, interactives.length);
    var contentChanged = lastPageSignature !== null && sig !== lastPageSignature;
    lastPageSignature = sig;
    return {
      title: document.title,
      url: location.href,
      interactives: interactives,
      truncated: els.length > MAX_ELEMENTS,
      text: chunk,
      text_chunk: chunk,
      text_offset: offset,
      text_total_chars: fullText.length,
      text_next_offset: offset + chunk.length < fullText.length ? offset + chunk.length : null,
      textTruncated: offset + chunk.length < fullText.length,
      collectionTruncated: collected.truncated,
      scroll: {
        y: Math.round(window.scrollY || 0),
        height: Math.max(
          (document.documentElement && document.documentElement.scrollHeight) || 0,
          (document.body && document.body.scrollHeight) || 0),
        viewportHeight: window.innerHeight || 0,
        contentChanged: contentChanged
      },
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

  /**
   * Label-only target resolution (the driver sent a label, no ref).
   * Exact-after-normalization wins; otherwise ONE normalized
   * case-insensitive substring match is accepted as a fuzzy fallback.
   * Zero or several candidates fail closed — a guessed click is worse
   * than a refused one. Returns { el, matchQuality: "exact"|"fuzzy" }.
   * (Ref-based acts never come here: their label check stays exact.)
   */
  function findByLabel(query) {
    var q = normalizeLabel(query);
    if (!q) throw new Error("empty label");
    var ql = q.toLowerCase();
    var els = document.querySelectorAll(INTERACTIVE_SELECTOR);
    var exact = [], fuzzy = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!isVisible(el)) continue;
      var lab = labelFor(el);
      if (lab === q) exact.push(el);
      else if (lab.toLowerCase().indexOf(ql) !== -1) fuzzy.push(el);
    }
    if (exact.length === 1) return { el: exact[0], matchQuality: "exact" };
    if (exact.length > 1) {
      throw new Error("label '" + query + "' matches " + exact.length + " elements exactly — use a stable ref");
    }
    if (fuzzy.length === 1) return { el: fuzzy[0], matchQuality: "fuzzy" };
    if (fuzzy.length > 1) {
      throw new Error("label '" + query + "' fuzzy-matches " + fuzzy.length + " elements — use a stable ref or a longer label");
    }
    throw new Error("no element matches label '" + query + "'");
  }

  function resolveTarget(ref, expectedLabel) {
    if (ref) {
      var el = verifyTarget(findByRef(ref), ref, expectedLabel);
      return { el: el, matchQuality: expectedLabel ? "exact" : undefined };
    }
    if (expectedLabel) return findByLabel(expectedLabel);
    throw new Error("act needs a ref or a label");
  }

  function doClick(ref, expectedLabel) {
    var r = resolveTarget(ref, expectedLabel);
    r.el.scrollIntoView({ block: "center", behavior: "instant" });
    r.el.click(); // trusted event, same as a user click
    return { detail: "clicked '" + labelFor(r.el) + "'", matchQuality: r.matchQuality };
  }

  function doClickAt(point) {
    if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
      throw new Error("clickAt needs numeric x/y");
    }
    var el = document.elementFromPoint(point.x, point.y);
    if (!el) throw new Error("no element at (" + point.x + ", " + point.y + ")");
    el.click();
    return { detail: "clicked '" + labelFor(el) + "' at (" + point.x + ", " + point.y + ")" };
  }

  function doClickSelector(selector) {
    if (!selector || typeof selector !== "string") throw new Error("clickSelector needs a selector");
    var el = document.querySelector(selector); // invalid selectors throw — the listener reports it
    if (!el) throw new Error("no element for selector '" + selector + "'");
    if (!isVisible(el)) throw new Error("element not visible for selector '" + selector + "'");
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.click();
    return { detail: "clicked '" + labelFor(el) + "' via selector '" + selector + "'" };
  }

  function isPasswordField(el) {
    return !!el && el.tagName && el.tagName.toLowerCase() === "input" &&
      String(el.type || "").toLowerCase() === "password";
  }

  function doType(ref, value, expectedLabel) {
    var r = resolveTarget(ref, expectedLabel);
    var el = r.el;
    if (isPasswordField(el)) {
      // Keyboard-style input into a password field is refused outright:
      // a password the agent holds should never transit snapshot-driven
      // typing. (Snapshot labels never carry password values either.)
      throw new Error("refusing to type into a password field");
    }
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
    return { detail: "typed into '" + labelFor(el) + "'", matchQuality: r.matchQuality };
  }

  // ------------------------------------------------------------ press_key
  // Key names: "Enter", "Tab", "Escape", "ArrowDown", "a", " " — combos
  // join with "+": "Ctrl+a", "Ctrl+Shift+k". The code is derived for
  // letters/digits; named keys pass through as their own code.
  function keySpec(spec) {
    var parts = String(spec || "").split("+");
    var key = parts.pop();
    var mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    parts.forEach(function (p) {
      var m = p.trim().toLowerCase();
      if (m === "ctrl" || m === "control") mods.ctrlKey = true;
      else if (m === "alt") mods.altKey = true;
      else if (m === "shift") mods.shiftKey = true;
      else if (m === "meta" || m === "cmd" || m === "command") mods.metaKey = true;
    });
    var code = key;
    if (/^[a-zA-Z]$/.test(key)) code = "Key" + key.toUpperCase();
    else if (/^[0-9]$/.test(key)) code = "Digit" + key;
    else if (key === " ") code = "Space";
    return { key: key, code: code, mods: mods };
  }

  function doPressKey(spec, ref, expectedLabel) {
    if (!spec) throw new Error("key action needs a key name (--press-key)");
    var target = null;
    if (ref || expectedLabel) target = resolveTarget(ref, expectedLabel);
    var el = target ? target.el : document.activeElement;
    if (!el) throw new Error("no element to press keys on (focus one first, or pass a target)");
    if (isPasswordField(el)) throw new Error("refusing to press keys on a password field");
    if (el.focus) el.focus();
    var ks = keySpec(spec);
    var init = { key: ks.key, code: ks.code, bubbles: true, cancelable: true,
                 ctrlKey: ks.mods.ctrlKey, altKey: ks.mods.altKey,
                 shiftKey: ks.mods.shiftKey, metaKey: ks.mods.metaKey };
    var notPrevented = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (ks.key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    // Enter's default action (form submit) does not fire for synthetic
    // key events in every engine; when the keydown was not prevented and
    // the target sits in a form, submit explicitly so Enter means Enter.
    var submitted = false;
    if (ks.key === "Enter" && notPrevented && el.form && typeof el.form.requestSubmit === "function") {
      el.form.requestSubmit();
      submitted = true;
    }
    return { detail: "pressed '" + spec + "' on '" + labelFor(el) + "'" + (submitted ? " (form submitted)" : ""),
             matchQuality: target ? target.matchQuality : undefined };
  }

  // ------------------------------------------------------------ hover
  function interactiveLabelsById() {
    var snap = buildSnapshot({});
    var map = {};
    (snap.interactives || []).forEach(function (i) { map[i.ref] = i.label; });
    return map;
  }

  // Hover is asynchronous: menus need a beat to open before we can say
  // what appeared. The appeared labels ride the result detail (and the
  // next snapshot shows the new items with stable ids).
  function doHover(ref, expectedLabel) {
    var r = resolveTarget(ref, expectedLabel);
    var el = r.el;
    var before = interactiveLabelsById();
    el.scrollIntoView({ block: "center", behavior: "instant" });
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    ["pointerover", "mouseover", "mouseenter", "pointermove", "mousemove"].forEach(function (t) {
      var Ev = (t.indexOf("pointer") === 0 && window.PointerEvent) ? window.PointerEvent : window.MouseEvent;
      el.dispatchEvent(new Ev(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    });
    return new Promise(function (resolve) {
      setTimeout(function () {
        var after = interactiveLabelsById();
        var appeared = [];
        Object.keys(after).forEach(function (id) { if (!before[id]) appeared.push(after[id]); });
        resolve({ detail: "hovered '" + labelFor(el) + "'" +
                    (appeared.length ? " — appeared: " + appeared.join(", ") : " — nothing new appeared"),
                  matchQuality: r.matchQuality, appeared: appeared });
      }, 400);
    });
  }

  // ------------------------------------------------------------ select_option
  function doSelect(ref, expectedLabel, optionValue, optionText) {
    var r = resolveTarget(ref, expectedLabel);
    var el = r.el;
    if (!el || el.tagName.toLowerCase() !== "select") {
      throw new Error("select target is not a <select>: " + labelFor(el));
    }
    var opts = Array.prototype.slice.call(el.options || []);
    var chosen = null;
    if (optionValue != null && optionValue !== "") {
      chosen = opts.filter(function (o) { return String(o.value) === String(optionValue); })[0] || null;
    }
    if (!chosen && optionText != null && optionText !== "") {
      chosen = opts.filter(function (o) {
        return normalizeLabel(o.textContent || o.text || "") === normalizeLabel(optionText);
      })[0] || null;
    }
    if (!chosen) {
      throw new Error("no option matching " +
        (optionValue ? "value '" + optionValue + "'" : "text '" + optionText + "'") + " in '" + labelFor(el) + "'");
    }
    el.value = chosen.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { detail: "selected '" + (chosen.textContent || chosen.text || chosen.value) + "' in '" + labelFor(el) + "'",
             matchQuality: r.matchQuality };
  }

  // ------------------------------------------------------------ set_value
  // Set an input's value the way React needs it: through the NATIVE
  // prototype setter (bypassing the instance-level value tracking React
  // installs), then the input/change events a real edit produces. Plain
  // assignment (el.value = x) is silently swallowed by controlled
  // inputs — the app's state never moves.
  function doSetValue(ref, value, expectedLabel) {
    var r = resolveTarget(ref, expectedLabel);
    var el = r.el;
    if (isPasswordField(el)) throw new Error("refusing to set a value on a password field");
    if (!("value" in el)) throw new Error("element has no value to set: " + labelFor(el));
    var proto = el.tagName.toLowerCase() === "textarea"
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    // The detail names the field and the length — never the value itself
    // (details land in the on-machine audit log).
    return { detail: "set '" + labelFor(el) + "' (" + String(value == null ? "" : value).length + " chars)",
             matchQuality: r.matchQuality };
  }

  // ------------------------------------------------------------ drag
  function doDrag(from, to) {
    function side(s) {
      if (s && s.point && typeof s.point.x === "number") {
        return { x: s.point.x, y: s.point.y, el: document.elementFromPoint(s.point.x, s.point.y),
                 name: "(" + s.point.x + ", " + s.point.y + ")" };
      }
      var r = resolveTarget(s && s.ref, s && s.label);
      var rect = r.el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, el: r.el,
               name: "'" + labelFor(r.el) + "'" };
    }
    var a = side(from), b = side(to);
    function fire(el, type, x, y) {
      if (!el || !el.dispatchEvent) return;
      var Ev = (type.indexOf("pointer") === 0 && window.PointerEvent) ? window.PointerEvent : window.MouseEvent;
      el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    }
    fire(a.el, "pointerdown", a.x, a.y);
    fire(a.el, "mousedown", a.x, a.y);
    for (var i = 1; i <= 5; i++) {
      var x = a.x + (b.x - a.x) * i / 5, y = a.y + (b.y - a.y) * i / 5;
      var mid = document.elementFromPoint(x, y) || b.el;
      fire(mid, "pointermove", x, y);
      fire(mid, "mousemove", x, y);
    }
    fire(b.el, "pointerup", b.x, b.y);
    fire(b.el, "mouseup", b.x, b.y);
    fire(b.el, "click", b.x, b.y);
    return { detail: "dragged " + a.name + " to " + b.name };
  }

  // ------------------------------------------------------------ wait_for
  // Bounded waiting inside the page: poll every 200ms until the
  // condition matches or the budget expires. ALWAYS resolves — matched
  // or timed out — so the driver never hangs and never blind-sleeps.
  var WAIT_MAX_MS = 120000;
  var WAIT_DEFAULT_MS = 30000;

  function waitCheck(wait, start) {
    if (!wait || !wait.kind) return null;
    if (wait.kind === "element") {
      if (wait.selector) {
        var el = null;
        try { el = document.querySelector(wait.selector); } catch (e) { el = null; }
        if (el && isVisible(el)) return { matched: "element", detail: "element appeared: " + wait.selector };
        return null;
      }
      try {
        var r = findByLabel(wait.label || wait.text || "");
        if (r && r.el) return { matched: "element", detail: "element appeared: '" + labelFor(r.el) + "'" };
      } catch (e) { /* not there yet */ }
      return null;
    }
    if (wait.kind === "text") {
      if (wait.text && (collectVisibleText().text || "").indexOf(wait.text) !== -1) {
        return { matched: "text", detail: "text appeared: '" + wait.text + "'" };
      }
      return null;
    }
    if (wait.kind === "navigation") {
      if (location.href !== start.href) {
        return { matched: "navigation", detail: "navigated to " + location.href };
      }
      if (start.readyState !== "complete" && document.readyState === "complete") {
        return { matched: "navigation", detail: "page finished loading" };
      }
      return null;
    }
    if (wait.kind === "networkIdle") {
      if (document.readyState !== "complete") return null;
      var lastEnd = 0;
      try {
        var entries = performance.getEntriesByType("resource");
        for (var i = 0; i < entries.length; i++) {
          lastEnd = Math.max(lastEnd, entries[i].responseEnd || 0);
        }
      } catch (e) { /* no timeline: readyState alone is the signal */ }
      var idleFor = performance.now() - lastEnd;
      if (idleFor >= 1000) {
        return { matched: "networkIdle", detail: "network idle for " + Math.round(idleFor) + "ms" };
      }
      return null;
    }
    if (wait.kind === "mediaEnded") {
      var nodes = document.querySelectorAll("video, audio");
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].ended) return { matched: "mediaEnded", detail: "media ended" };
      }
      return null;
    }
    return null;
  }

  function doWaitFor(wait, timeoutMs) {
    var budget = Math.min(Math.max(Number(timeoutMs) || WAIT_DEFAULT_MS, 250), WAIT_MAX_MS);
    var start = { href: location.href, readyState: document.readyState, at: Date.now() };
    return new Promise(function (resolve) {
      function finish(hit, elapsed) {
        if (hit) {
          resolve({ detail: hit.detail + " after " + elapsed + "ms",
                    data: { matched: true, condition: hit.matched, elapsedMs: elapsed } });
        } else {
          resolve({ detail: "timed out after " + elapsed + "ms waiting for " + ((wait && wait.kind) || "condition"),
                    data: { matched: false, condition: (wait && wait.kind) || null, elapsedMs: elapsed } });
        }
      }
      var first = null;
      try { first = waitCheck(wait, start); } catch (e) { first = null; }
      if (first) { finish(first, 0); return; }
      var iv = setInterval(function () {
        var hit = null;
        try { hit = waitCheck(wait, start); } catch (e) { hit = null; }
        var elapsed = Date.now() - start.at;
        if (hit || elapsed >= budget) {
          clearInterval(iv);
          finish(hit, elapsed);
        }
      }, 200);
    });
  }

  // ------------------------------------------------------------ fetch_in_page
  // A fetch from the page's own context: same-origin requests carry the
  // user's session (that's the point — authenticated endpoints the
  // snapshot cannot see). Cross-origin requests NEVER carry credentials
  // and no custom headers are ever forwarded. HTTPS only.
  var FETCH_READ_CAP = 5000000;  // stop reading a body past ~5 MB
  var FETCH_WIRE_CAP = 512000;   // the relay caps messages at 1 MB — stay well under

  function readBodyCapped(res, cap) {
    if (!res.body || typeof res.body.getReader !== "function") {
      return res.text().then(function (t) {
        return { body: t.slice(0, cap), truncated: t.length > cap, size: t.length };
      });
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var out = "", size = 0, truncated = false;
    function step() {
      return reader.read().then(function (r) {
        if (r.done) return { body: out, truncated: truncated, size: size };
        var chunk = decoder.decode(r.value, { stream: true });
        size += chunk.length;
        if (out.length < cap) out += chunk.slice(0, cap - out.length);
        if (size > cap) {
          truncated = true;
          try { reader.cancel(); } catch (e) {}
          return { body: out, truncated: true, size: size };
        }
        return step();
      });
    }
    return step();
  }

  function doFetch(a) {
    if (!a.url) throw new Error("fetch needs a URL");
    var u;
    try { u = new URL(a.url, location.href); }
    catch (e) { throw new Error("fetch URL is not valid: " + a.url); }
    if (u.protocol !== "https:") {
      throw new Error("refusing to fetch a non-HTTPS URL (" + u.protocol + "//" + u.host + ")");
    }
    var sameOrigin = u.origin === location.origin;
    var method = String(a.method || "GET").toUpperCase();
    var init = { method: method, credentials: sameOrigin ? "include" : "omit" };
    if (a.body != null && method !== "GET" && method !== "HEAD") {
      init.body = String(a.body);
      init.headers = { "Content-Type": a.contentType || "application/json" };
    }
    return fetch(u.href, init).then(function (res) {
      var headers = {};
      try {
        if (res.headers && typeof res.headers.forEach === "function") {
          res.headers.forEach(function (v, k) { headers[k] = v; });
        }
      } catch (e) { /* headers stay partial */ }
      return readBodyCapped(res, FETCH_READ_CAP).then(function (r) {
        var wireTruncated = r.body.length > FETCH_WIRE_CAP;
        return {
          detail: method + " " + u.href + " → " + res.status + " · " + r.size + " chars" +
                  ((r.truncated || wireTruncated) ? " (truncated)" : "") +
                  (sameOrigin ? "" : " · cross-origin, no credentials sent"),
          data: { status: res.status, headers: headers, url: res.url || u.href,
                  body: wireTruncated ? r.body.slice(0, FETCH_WIRE_CAP) : r.body,
                  truncated: !!(r.truncated || wireTruncated), size: r.size,
                  credentials: sameOrigin ? "include" : "omit" }
        };
      });
    });
  }

  // ------------------------------------------------------------ media control
  // Play/pause/seek with a VERIFIED cross-check: play is only reported
  // as playing when currentTime actually advances across two samples.
  // When it doesn't start, the result names why (autoplay policy,
  // source error, off-screen, no data) instead of a bare paused:true.
  function mediaDelay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function playerKeyFor(el) {
    var idPart = el.id || (typeof el.className === "string" && el.className.trim()
      ? el.className.trim().split(/\s+/)[0] : "") || String(el.tagName || "media").toLowerCase();
    var host = "";
    try { host = new URL(el.currentSrc || el.src || "").host; } catch (e) { /* relative/empty src */ }
    return String(idPart) + "@" + host;
  }

  function resolveMediaEl(a) {
    var t = a.target || {};
    var el = null;
    if (t.ref || t.label) { try { el = resolveTarget(t.ref, t.label).el; } catch (e) { el = null; } }
    if (!el || !/^(VIDEO|AUDIO)$/.test(el.tagName || "")) {
      var nodes = document.querySelectorAll("video, audio");
      el = nodes && nodes.length ? nodes[0] : null;
    }
    if (!el) throw new Error("no media element found on this page");
    return el;
  }

  function mediaState(el) {
    return {
      paused: !!el.paused,
      currentTime: Math.round((el.currentTime || 0) * 10) / 10,
      duration: (typeof el.duration === "number" && isFinite(el.duration))
        ? Math.round(el.duration * 10) / 10 : null,
      src: el.currentSrc || el.src || null,
      playerKey: playerKeyFor(el)
    };
  }

  function mediaBlockReason(el, playError) {
    if (el.error) return "source-error: " + (el.error.message || ("code " + el.error.code));
    if (el.networkState === 3) return "no-source";
    if (playError && playError.name === "NotAllowedError") return "autoplay-blocked";
    if (playError) return "play-failed: " + (playError.message || playError.name || "unknown");
    var geo = null;
    try { geo = boxFor(el); } catch (e) { geo = null; }
    if (!geo || !geo.inViewport) return "not-in-viewport";
    if (el.readyState === 0) return "no-data";
    return "did-not-start";
  }

  function doMedia(a) {
    var el = resolveMediaEl(a);
    var m = a.media || {};
    var action = m.action || "play";
    if (action === "pause") {
      try { el.pause(); } catch (e) { /* state check below is the verdict */ }
      return mediaDelay(250).then(function () {
        var s = mediaState(el);
        var verified = s.paused === true;
        return { detail: "paused at " + s.currentTime + "s" + (verified ? "" : " (could not verify the pause)"),
                 data: Object.assign({ action: "pause", verified: verified }, s) };
      });
    }
    if (action === "seek") {
      var to = Number(m.seekTo);
      if (!isFinite(to)) throw new Error("seek needs a numeric target time");
      try { el.currentTime = to; } catch (e) { throw new Error("seek failed: " + ((e && e.message) || e)); }
      return mediaDelay(600).then(function () {
        var s = mediaState(el);
        var verified = Math.abs((el.currentTime || 0) - to) < 2;
        return { detail: "seeked to " + s.currentTime + "s" + (verified ? "" : " (the target " + to + "s was not reached)"),
                 data: Object.assign({ action: "seek", verified: verified, seekTo: to }, s) };
      });
    }
    // play: scroll into view first (decks bury players off-screen),
    // then cross-check that currentTime actually advances.
    try { el.scrollIntoView({ block: "center" }); } catch (e) { /* best effort */ }
    var playError = null;
    var p = null;
    try { p = el.play(); } catch (e) { playError = e; }
    var settled = (p && typeof p.then === "function")
      ? p.then(function () {}, function (e) { playError = e; })
      : Promise.resolve();
    return settled.then(function () { return mediaDelay(350); }).then(function () {
      var ct1 = el.currentTime || 0;
      return mediaDelay(800).then(function () {
        var ct2 = el.currentTime || 0;
        var s = mediaState(el);
        var verified = ct2 > ct1 + 0.1 && !el.paused;
        if (!verified) s.reason = mediaBlockReason(el, playError);
        return {
          detail: verified
            ? "playing — currentTime advancing (" + ct1.toFixed(1) + "s → " + ct2.toFixed(1) + "s of " + s.duration + "s)"
            : "did not start — paused: true, reason: " + s.reason,
          data: Object.assign({ action: "play", verified: verified }, s)
        };
      });
    });
  }

  // Caption text for a time range, from the track the snapshot lists.
  function doCaptions(a) {
    var el = resolveMediaEl(a);
    var tracks = el.textTracks || [];
    var chosen = null;
    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      if (tr.kind !== "captions" && tr.kind !== "subtitles") continue;
      if (a.language && tr.language && tr.language.indexOf(a.language) !== 0) continue;
      if (typeof a.trackIndex === "number" && a.trackIndex !== i) continue;
      chosen = tr;
      break;
    }
    if (!chosen) {
      throw new Error("no caption/subtitle track matches" +
        (a.language ? " language '" + a.language + "'" : "") + " on this media element");
    }
    if (chosen.mode === "disabled") {
      try { chosen.mode = "hidden"; } catch (e) { /* read-only mode */ }
    }
    var from = Number(a.from || 0);
    var to = a.to != null ? Number(a.to) : Infinity;
    var list = [];
    try { list = chosen.cues || []; } catch (e) { list = []; }
    var cues = [];
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      if (c.endTime < from || c.startTime > to) continue;
      cues.push({ start: Math.round(c.startTime * 10) / 10,
                  end: Math.round(c.endTime * 10) / 10,
                  text: stripCueMarkup(c.text) });
      if (cues.length >= 500) break;
    }
    return {
      detail: "captions [" + (chosen.language || "unknown") + "] " + from + "s–" +
              (a.to != null ? a.to + "s" : "end") + ": " + cues.length + " cue(s)",
      data: { track: { kind: chosen.kind, label: chosen.label, language: chosen.language, mode: chosen.mode },
              cues: cues, text: cues.map(function (c) { return c.text; }).join("\n") }
    };
  }

  // A still of the video element at a timestamp, via canvas. DRM or
  // cross-origin media taints the canvas — that refusal is reported,
  // never faked around.
  function doFrameGrab(a) {
    var el = resolveMediaEl(a);
    if (el.tagName !== "VIDEO") throw new Error("frame grab needs a <video> element");
    function grab() {
      var w = el.videoWidth || 640, h = el.videoHeight || 360;
      var scale = Math.min(1, 640 / (w || 640));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(2, Math.round(w * scale));
      canvas.height = Math.max(2, Math.round(h * scale));
      var ctx = canvas.getContext("2d");
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      var url;
      try { url = canvas.toDataURL("image/jpeg", 0.82); }
      catch (e) {
        throw new Error("frame grab blocked: the canvas is tainted (DRM or cross-origin media) — the browser will not expose these pixels");
      }
      var s = mediaState(el);
      return { detail: "frame at " + s.currentTime + "s (" + canvas.width + "×" + canvas.height + ")",
               data: { mime: "image/jpeg", dataUrl: url, width: canvas.width, height: canvas.height,
                       currentTime: s.currentTime, playerKey: s.playerKey, src: s.src } };
    }
    var at = a.at != null ? Number(a.at) : null;
    if (at != null && isFinite(at) && Math.abs((el.currentTime || 0) - at) > 0.5) {
      try { el.currentTime = at; } catch (e) { /* grab whatever is showing */ }
      return mediaDelay(700).then(grab);
    }
    return mediaDelay(50).then(grab);
  }

  function doScroll(direction, amount) {
    var px = amount || 600;
    if (direction === "up") window.scrollBy({ top: -px, behavior: "smooth" });
    else if (direction === "down") window.scrollBy({ top: px, behavior: "smooth" });
    else if (direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
    else if (direction === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    return "scrolled " + direction;
  }

  // ------------------------------------------------------------ media progress
  // While media plays in the top frame, report progress to the
  // background every ~10s and immediately on play/pause/ended/seeked;
  // the background relays it to the driver live. Nothing is stored.
  var mediaWatched = typeof WeakSet === "function" ? new WeakSet() : null;
  function reportMedia(el, eventName) {
    try {
      chrome.runtime.sendMessage({
        kind: "jbb.media.progress", event: eventName || "progress",
        title: document.title || "", url: location.href,
        currentTime: Math.round((el.currentTime || 0) * 10) / 10,
        duration: (typeof el.duration === "number" && isFinite(el.duration))
          ? Math.round(el.duration * 10) / 10 : null,
        paused: !!el.paused, ended: !!el.ended
      });
    } catch (e) { /* extension context gone — stay silent */ }
  }
  function scanMediaProgress() {
    var nodes = document.querySelectorAll("video, audio");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (mediaWatched && !mediaWatched.has(el)) {
        mediaWatched.add(el);
        ["play", "pause", "ended", "seeked"].forEach(function (ev) {
          el.addEventListener(ev, function () { reportMedia(el, ev); });
        });
        if (!el.paused && !el.ended) reportMedia(el, "play");
      }
      if (!el.paused && !el.ended && el.duration > 0) reportMedia(el, "progress");
    }
  }
  if (window === window.top) {
    setInterval(scanMediaProgress, 10000);
    window.__jbbMediaScan = scanMediaProgress; // test hook
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.kind !== "string" || msg.kind.indexOf("jbb.content.") !== 0) {
      return false;
    }
    try {
      if (msg.kind === "jbb.content.observe") {
        sendResponse({ ok: true, snapshot: buildSnapshot({ textOffset: msg.textOffset }) });
      } else if (msg.kind === "jbb.content.act") {
        var a = msg.action || {};
        var t = a.target || {};
        if (a.type === "hover" || a.type === "waitFor" || a.type === "fetch" ||
            a.type === "media" || a.type === "frameGrab") {
          // Async actions: hover waits for menus, waitFor waits for its
          // condition, fetch waits on the network, media verifies state.
          var p = a.type === "hover" ? doHover(t.ref, t.label)
                : a.type === "waitFor" ? doWaitFor(a.wait, a.timeoutMs)
                : a.type === "fetch" ? doFetch(a)
                : a.type === "media" ? doMedia(a)
                : doFrameGrab(a);
          p.then(function (out) {
            var resp = { ok: true, detail: out.detail };
            if (out.matchQuality) resp.matchQuality = out.matchQuality;
            if (out.appeared) resp.appeared = out.appeared;
            if (out.data) resp.data = out.data;
            sendResponse(resp);
          }, function (err) {
            sendResponse({ ok: false, error: String((err && err.message) || err) });
          });
          return true; // keep the response channel open
        }
        var out;
        if (a.type === "click") out = doClick(t.ref, t.label);
        else if (a.type === "type") out = doType(t.ref, a.value, t.label);
        else if (a.type === "clickAt") out = doClickAt(a.point);
        else if (a.type === "clickSelector") out = doClickSelector(a.selector);
        else if (a.type === "key") out = doPressKey(a.key, t.ref, t.label);
        else if (a.type === "select") out = doSelect(t.ref, t.label, a.optionValue != null ? a.optionValue : a.value, a.optionText);
        else if (a.type === "setValue") out = doSetValue(t.ref, a.value, t.label);
        else if (a.type === "drag") out = doDrag(a.dragFrom || t, a.dragTo);
        else if (a.type === "captions") out = doCaptions(a);
        else if (a.type === "scroll") out = { detail: doScroll(a.direction, a.amount) };
        else throw new Error("unknown action type: " + a.type);
        var resp = { ok: true, detail: out.detail };
        if (out.matchQuality) resp.matchQuality = out.matchQuality;
        if (out.data) resp.data = out.data;
        sendResponse(resp);
      } else {
        sendResponse({ ok: false, error: "unknown content message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
    return false; // synchronous response
  });
})();
