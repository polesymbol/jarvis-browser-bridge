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
  var TEXT_CAP = 30000;
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
    "[role='tab']",
    "[role='combobox']",
    "[role='listbox']",
    "[role='option']",
    "[role='menuitem']",
    "[role='radio']",
    "[role='switch']",
    "[role='slider']",
    "[role='spinbutton']",
    "[role='searchbox']",
    "[role='treeitem']",
    "[aria-haspopup]",
    "[aria-expanded]",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  /**
   * Deep query: light DOM plus every OPEN shadow root, in tree order.
   * Component libraries (Seller Central's dashboards among them) render
   * their real controls — dropdowns, tabs, filters — inside shadow DOM,
   * where a plain document.querySelectorAll never sees them; snapshots
   * used to show only the host page's outer shell (field report
   * 2026-11-10: every Brand Analytics control invisible). Closed shadow
   * roots stay unreachable by design — the browser forbids it, and the
   * snapshot says so via what it cannot list rather than pretending.
   */
  function queryDeep(selector) {
    var out = [];
    var seen = new Set();
    var walk = function (scope) {
      var nodes;
      try { nodes = scope.querySelectorAll(selector); } catch (e) { nodes = []; }
      for (var i = 0; i < nodes.length; i++) {
        if (!seen.has(nodes[i])) { seen.add(nodes[i]); out.push(nodes[i]); }
      }
      var all;
      try { all = scope.querySelectorAll("*"); } catch (e) { all = []; }
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) walk(all[j].shadowRoot);
      }
    };
    walk(document);
    return out;
  }

  function queryInteractives() { return queryDeep(INTERACTIVE_SELECTOR); }

  /**
   * Pointer pass: clickable div/span widgets that no HTML tag or ARIA
   * role names. The page's own computed `cursor: pointer` is its
   * declaration that the element is clickable — that, a visible box, and
   * a readable label are the entry bar. These candidates only ever FILL
   * budget the semantic pass left over (they never displace a real
   * control), and an element whose interactive descendant exists is
   * skipped — the innermost real control is the meaningful target.
   */
  function pointerCandidates(exclude, budget) {
    var out = [];
    if (budget <= 0) return out;
    var all = queryDeep("*");
    for (var i = 0; i < all.length && out.length < budget; i++) {
      var el = all[i];
      if (exclude.has(el)) continue;
      var tag = (el.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "link" || tag === "meta" ||
          tag === "html" || tag === "body" || tag === "head") continue;
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || (r.width === 0 && r.height === 0)) continue;
      if (!labelFor(el)) continue;
      var style;
      try { style = window.getComputedStyle(el); } catch (e) { continue; }
      if (!style || style.cursor !== "pointer") continue;
      if (style.visibility === "hidden" || style.display === "none") continue;
      var inner = null;
      try { inner = el.querySelector(INTERACTIVE_SELECTOR); } catch (e) { /* exotic node */ }
      if (inner) continue;
      out.push(el);
    }
    return out;
  }

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
    // Tabs and widgets whose visible text lives in an open shadow root
    // have an empty innerText on the host — the snapshot used to label
    // them by tag ("div"), which made --target re-resolution impossible
    // for them (Fix 9 — the Repeat Purchase tab switch failed 5/5).
    // Fall back to the shadow text before the tag name.
    if (raw === tag && el.shadowRoot) {
      var st = "";
      try {
        for (var j = 0; j < el.shadowRoot.children.length; j++) {
          st += (el.shadowRoot.children[j].innerText || el.shadowRoot.children[j].textContent || "") + "\n";
        }
      } catch (e) { /* shadow access is best-effort */ }
      if (st.trim()) raw = st;
    }
    return normalizeLabel(raw).slice(0, 80);
  }

  /**
   * A stable CSS selector for an element, computed from its own
   * identifying attributes — ids and hrefs survive SPA re-renders, a
   * positional path is the last resort and is only trusted when it
   * matches exactly one element. Used at snapshot time so a later act
   * can re-resolve by selector when the stamped element is gone.
   * Returns null when nothing identifying could be built.
   */
  function stableSelectorFor(el) {
    try {
      var tag = (el.tagName || "").toLowerCase();
      if (!tag) return null;
      var esc = function (s) {
        return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      };
      if (el.id) {
        var idSel = "#" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      }
      var attrs = [];
      var al = el.getAttribute && el.getAttribute("aria-label");
      if (al) attrs.push('[aria-label="' + esc(al) + '"]');
      var nm = el.getAttribute && el.getAttribute("name");
      if (nm) attrs.push('[name="' + esc(nm) + '"]');
      if (tag === "a" && el.getAttribute && el.getAttribute("href")) {
        attrs.push('[href="' + esc(el.getAttribute("href")) + '"]');
      }
      var role = el.getAttribute && el.getAttribute("role");
      if (role) attrs.push('[role="' + esc(role) + '"]');
      for (var i = 0; i < attrs.length; i++) {
        var cand = tag + attrs[i];
        if (document.querySelectorAll(cand).length === 1) return cand;
      }
      var parts = [];
      var node = el;
      for (var d = 0; d < 4 && node && node !== document.body && node !== document.documentElement; d++) {
        var t = (node.tagName || "").toLowerCase();
        if (!t) break;
        var sibs = node.parentElement ? node.parentElement.children : [];
        var idx = 0, same = 0;
        for (var s = 0; s < sibs.length; s++) {
          if ((sibs[s].tagName || "").toLowerCase() === t) {
            same++;
            if (sibs[s] === node) idx = same;
          }
        }
        if (!idx) break;
        parts.unshift(t + ":nth-of-type(" + idx + ")");
        node = node.parentElement;
      }
      if (parts.length) {
        var path = parts.join(" > ");
        if (document.querySelectorAll(path).length === 1) return path;
      }
    } catch (e) { /* selector building is best-effort */ }
    return null;
  }

  // Checked / selected / disabled state of an element, as the snapshot
  // exposes it (Fix 4) and as post-click verification reads it (Fix 3).
  // Fields are undefined when not applicable — JSON drops them, so
  // snapshots stay lean and only stateful elements carry state. Before
  // this, a checkbox carried only the label "on" and the agent could not
  // tell whether a box was ticked at all.
  function elementState(el) {
    var out = {};
    var tag = (el.tagName || "").toLowerCase();
    var it = tag === "input" ? String(el.type || "text").toLowerCase() : null;
    if (it === "checkbox" || it === "radio") out.checked = !!el.checked;
    else if (el.getAttribute) {
      var ac = el.getAttribute("aria-checked");
      if (ac === "true") out.checked = true;
      else if (ac === "false") out.checked = false;
    }
    var as = el.getAttribute ? el.getAttribute("aria-selected") : null;
    if (as === "true") out.selected = true;
    else if (as === "false") out.selected = false;
    else if (tag === "option") out.selected = !!el.selected;
    else if (el.classList && el.classList.contains && el.classList.contains("selected")) out.selected = true;
    if (el.disabled === true) out.disabled = true;
    else if (el.getAttribute && el.getAttribute("aria-disabled") === "true") out.disabled = true;
    return out;
  }

  function stateProbe(el) {
    var st = elementState(el);
    st.label = labelFor(el);
    st.url = location.href;
    return st;
  }

  // Post-click verification (Fix 3): a click that reports success while
  // the page silently rejected it is worse than a failure — the agent
  // moves on believing a change landed. After the click, wait briefly,
  // re-find the target in the live DOM, and compare its state:
  // VERIFIED when the state changed or the click navigated the page,
  // UNCONFIRMED when a stateful element's state did not change, N/A
  // when the element carries no state to check (a plain link/button).
  // ok=true still means "the click was delivered"; verification says
  // whether the page applied it.
  var VERIFY_WAIT_MS = 350;
  function stateChangeNote(b, a) {
    var bits = [];
    if (b.checked !== a.checked) bits.push("checked " + b.checked + " → " + a.checked);
    if (b.selected !== a.selected) bits.push("selected " + b.selected + " → " + a.selected);
    if (b.disabled !== a.disabled) bits.push("disabled " + b.disabled + " → " + a.disabled);
    return bits.join(", ");
  }
  function verifyStateChange(before, getEl) {
    return delay(VERIFY_WAIT_MS).then(function () {
      if (location.href !== before.url) {
        return { verification: "VERIFIED", note: "page navigated", before: before, after: null };
      }
      var after = null;
      try { var el = getEl(); if (el) after = stateProbe(el); } catch (e) { after = null; }
      if (!after) {
        return { verification: "UNCONFIRMED", note: "target element is gone and the page did not navigate", before: before, after: null };
      }
      var changed = (before.checked !== after.checked) || (before.selected !== after.selected) ||
                    (before.disabled !== after.disabled);
      if (changed) return { verification: "VERIFIED", note: stateChangeNote(before, after), before: before, after: after };
      if (before.checked === undefined && before.selected === undefined) {
        return { verification: "N/A", note: "element carries no checked/selected state to verify against", before: before, after: after };
      }
      return { verification: "UNCONFIRMED", note: "state did not change after the click", before: before, after: after };
    });
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
  // What each stamped id MEANT when the snapshot was built: the approved
  // label and a stable selector, so an act whose element died in a
  // re-render can re-resolve by selector or label at execution time
  // instead of failing on a dead ref. Pruned with the registry.
  var idMemory = {}; // id -> { label, selector, type }

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
      if (!el || el.isConnected === false) { delete idRegistry[id]; delete idMemory[id]; }
    });
  }

  function typeFor(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input") return "input:" + (el.type || "text");
    var role = el.getAttribute ? el.getAttribute("role") : null;
    if (tag === "button" || role === "button") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (role) return role;
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
    var els = queryInteractives();
    var interactives = [];
    var seen = new Set();
    var entryFor = function (el, typeOverride) {
      var geo = boxFor(el);
      var ref = stableIdFor(el);
      var label = labelFor(el);
      var type = typeOverride || typeFor(el);
      // Remember what this id meant, so a later act can re-resolve by
      // selector or label when the node itself is replaced by a re-render.
      idMemory[ref] = { label: label, selector: stableSelectorFor(el), type: type };
      var st = elementState(el);
      return {
        ref: ref,
        label: label,
        type: type,
        name: el.getAttribute("name") || null,
        href: hrefFor(el),
        box: geo.box,
        inViewport: geo.inViewport,
        checked: st.checked,
        selected: st.selected,
        disabled: st.disabled
      };
    };
    var n = 0;
    for (var i = 0; i < els.length && n < MAX_ELEMENTS; i++) {
      var el = els[i];
      if (!isVisible(el)) continue;
      seen.add(el);
      interactives.push(entryFor(el));
      n++;
    }
    // Pointer pass: clickable-but-unmarked widgets fill whatever budget
    // the semantic pass left — never displacing a real control.
    var ptrTruncated = false;
    if (n < MAX_ELEMENTS) {
      var ptr = pointerCandidates(seen, MAX_ELEMENTS - n);
      ptrTruncated = ptr.length >= MAX_ELEMENTS - n;
      for (var p = 0; p < ptr.length; p++) {
        interactives.push(entryFor(ptr[p], "clickable"));
        n++;
      }
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
      truncated: els.length > MAX_ELEMENTS || ptrTruncated,
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
  // Every element a label may legitimately name: the semantic pass plus
  // pointer-pass widgets, deduped. Label acts and ref re-resolution both
  // search this set, so a target the snapshot could show is a target an
  // act can find.
  function labelCandidates() {
    var els = queryInteractives();
    var seen = new Set(els);
    var ptr = pointerCandidates(seen, 100);
    for (var i = 0; i < ptr.length; i++) els.push(ptr[i]);
    return els;
  }

  function findExactByLabel(query) {
    var q = normalizeLabel(query);
    var els = labelCandidates();
    var exact = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!isVisible(el)) continue;
      if (labelFor(el) === q) exact.push(el);
    }
    return exact;
  }

  function findByLabel(query) {
    var q = normalizeLabel(query);
    if (!q) throw new Error("empty label");
    var ql = q.toLowerCase();
    var els = labelCandidates();
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
      var el = findByRef(ref);
      if (el) {
        verifyTarget(el, ref, expectedLabel);
        return { el: el, matchQuality: expectedLabel ? "exact" : undefined };
      }
      // The stamped element is GONE — on a re-rendering SPA (Seller
      // Central Learn re-renders every few seconds) refs die between
      // observe and act, and "no element for ref" was the session's top
      // click failure. If the act carries the label the user approved,
      // re-resolve it against the LIVE DOM: exactly one exact-label
      // match, or fail closed. Fuzzy is never accepted here — the user
      // approved a specific element, and only its exact label, unique,
      // is a safe stand-in for it.
      if (expectedLabel) {
        var exact = findExactByLabel(expectedLabel);
        if (exact.length === 1) return { el: exact[0], matchQuality: "re-resolved" };
        throw new Error("no element for ref " + ref + " — the page re-rendered, and its label '" +
          expectedLabel + "' now matches " + exact.length + " elements (re-resolution needs exactly one)");
      }
      throw new Error("no element for ref " + ref +
        " — if the page re-renders, pass the element's label as --target alongside --ref so the act can re-resolve at execution time");
    }
    if (expectedLabel) return findByLabel(expectedLabel);
    throw new Error("act needs a ref or a label");
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // How long resolution is retried across re-renders before an act gives
  // up: long enough for an SPA redraw or a document re-mount, short
  // enough that a genuinely dead target fails in seconds, not minutes.
  // (window.__jbbResolveRetryMs overrides it — tests only.)
  var RESOLVE_RETRY_MS = (typeof window !== "undefined" && window.__jbbResolveRetryMs) || 5000;
  var RESOLVE_POLL_MS = 250;

  function isResolutionMiss(err) {
    var m = String((err && err.message) || err || "");
    return /no element for ref|no element matches label|element changed since observation|no element for selector/.test(m);
  }

  // One resolution attempt, in order: the stamped ref, the selector the
  // snapshot remembered for that ref, an explicit selector the act
  // carries, then the approved label (exact, unique). A selector hit is
  // accepted only when its label still matches the approved one — a
  // selector that now points at a different control is a miss, not a hit.
  function resolveOnce(ref, label, selector) {
    if (ref) {
      var el = findByRef(ref);
      if (el) {
        verifyTarget(el, ref, label);
        return { el: el, matchQuality: label ? "exact" : undefined };
      }
      var mem = idMemory[ref];
      if (mem && mem.selector) {
        var selEl = null;
        try { selEl = document.querySelector(mem.selector); } catch (e) { selEl = null; }
        if (selEl && isVisible(selEl) &&
            (!label || normalizeLabel(labelFor(selEl)) === normalizeLabel(label))) {
          return { el: selEl, matchQuality: "re-resolved" };
        }
      }
    }
    if (selector) {
      var qEl = null;
      try { qEl = document.querySelector(selector); } catch (e) { qEl = null; }
      if (qEl && isVisible(qEl)) return { el: qEl, matchQuality: "re-resolved" };
    }
    if (label) {
      var exact = findExactByLabel(label);
      if (exact.length === 1) return { el: exact[0], matchQuality: "re-resolved" };
    }
    return null;
  }

  // Retry resolution across re-renders for up to RESOLVE_RETRY_MS. If the
  // page is blank at execution time (about:blank, or an SPA shell that
  // has not re-mounted after a navigation during the consent wait), wait
  // for real content first instead of resolving against an empty shell.
  function resolveWithRetry(ref, label, selector) {
    return (async function () {
      var deadline = Date.now() + RESOLVE_RETRY_MS;
      var lastErr = null;
      for (;;) {
        var bodyText = "";
        try { bodyText = (document.body && document.body.innerText) || ""; } catch (e) {}
        if (bodyText.trim().length > 0) {
          try {
            var hit = resolveOnce(ref, label, selector);
            if (hit) return hit;
          } catch (e) { lastErr = e; }
        }
        if (Date.now() >= deadline) break;
        await delay(RESOLVE_POLL_MS);
      }
      if (lastErr) throw lastErr;
      if (ref) {
        var mem = idMemory[ref];
        throw new Error("no element for ref " + ref + " after " + (RESOLVE_RETRY_MS / 1000) +
          "s of retries across re-renders" +
          (label ? " — its label '" + label + "' matches 0 elements now" : "") +
          (mem && mem.selector ? " (remembered selector '" + mem.selector + "' also found nothing)" : "") +
          " — re-observe and rebuild the act");
      }
      if (selector) throw new Error("no element for selector '" + selector + "' after " + (RESOLVE_RETRY_MS / 1000) + "s of retries");
      throw new Error("no element matches label '" + label + "'");
    })();
  }

  function doClick(ref, expectedLabel) {
    var r = resolveTarget(ref, expectedLabel);
    var before = stateProbe(r.el);
    var label = labelFor(r.el);
    r.el.scrollIntoView({ block: "center", behavior: "instant" });
    r.el.click(); // trusted event, same as a user click
    return verifyStateChange(before, function () {
      try { return resolveTarget(ref, expectedLabel).el; } catch (e) { return null; }
    }).then(function (v) {
      var detail = "clicked '" + label + "'" +
        (v.verification !== "N/A" ? " — state " + v.verification + (v.note ? " (" + v.note + ")" : "") : "");
      return { detail: detail, matchQuality: r.matchQuality,
               data: { verification: v.verification, stateBefore: v.before, stateAfter: v.after } };
    });
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
    var typeLabel = labelFor(el);
    return delay(VERIFY_WAIT_MS).then(function () {
      var ok = false;
      try { var el2 = resolveTarget(ref, expectedLabel).el; ok = String(el2.value) === String(value); } catch (e) {}
      var verification = ok ? "VERIFIED" : "UNCONFIRMED";
      return { detail: "typed into '" + typeLabel + "' — state " + verification,
               matchQuality: r.matchQuality, data: { verification: verification } };
    });
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
    var selLabel = labelFor(el);
    var chosenValue = chosen.value;
    var chosenText = chosen.textContent || chosen.text || chosen.value;
    return delay(VERIFY_WAIT_MS).then(function () {
      var ok = false;
      try { var el2 = resolveTarget(ref, expectedLabel).el; ok = String(el2.value) === String(chosenValue); } catch (e) {}
      var verification = ok ? "VERIFIED" : "UNCONFIRMED";
      return { detail: "selected '" + chosenText + "' in '" + selLabel + "' — state " + verification,
               matchQuality: r.matchQuality, data: { verification: verification } };
    });
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
    var setLabel = labelFor(el);
    var setLen = String(value == null ? "" : value).length;
    return delay(VERIFY_WAIT_MS).then(function () {
      var ok = false;
      try { var el2 = resolveTarget(ref, expectedLabel).el; ok = String(el2.value) === String(value); } catch (e) {}
      var verification = ok ? "VERIFIED" : "UNCONFIRMED";
      return { detail: "set '" + setLabel + "' (" + setLen + " chars) — state " + verification,
               matchQuality: r.matchQuality, data: { verification: verification } };
    });
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

  var FORBIDDEN_FETCH_HEADERS = ["cookie", "host", "content-length", "connection",
    "transfer-encoding", "upgrade", "proxy-authorization", "te", "trailer", "referer", "origin"];

  function validateFetchHeaders(h) {
    if (typeof h !== "object" || h === null || Array.isArray(h)) {
      throw new Error("fetch headers must be an object of name: value pairs");
    }
    var names = Object.keys(h);
    if (names.length > 16) throw new Error("too many fetch headers (max 16)");
    var out = {};
    names.forEach(function (name) {
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
        throw new Error("invalid fetch header name: '" + name + "'");
      }
      if (FORBIDDEN_FETCH_HEADERS.indexOf(name.toLowerCase()) >= 0) {
        throw new Error("fetch header '" + name + "' is browser-owned and cannot be set — cookies ride the session automatically on same-origin fetches");
      }
      var v = h[name];
      if (typeof v !== "string" || v.length > 512 || /[\r\n]/.test(v)) {
        throw new Error("invalid value for fetch header '" + name + "'");
      }
      out[name] = v;
    });
    return out;
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
    // Custom headers (field fix 2026-11-10): session-gated app APIs
    // (Seller University search among them) demand app headers — CSRF
    // tokens and the like — on top of cookies, so a cookies-only fetch
    // was refused even same-origin. Headers are SAME-ORIGIN ONLY: in
    // page context they are exactly what the page's own XHRs may send,
    // while cross-origin they would leak page internals to another
    // site, so asking for them there is refused outright. Cookie and
    // the other browser-owned headers can never be set by hand.
    var extraHeaders = null;
    if (a.headers != null) {
      if (!sameOrigin) {
        throw new Error("custom headers are only sent on same-origin fetches — this URL is cross-origin");
      }
      extraHeaders = validateFetchHeaders(a.headers);
    }
    var init = { method: method, credentials: sameOrigin ? "include" : "omit" };
    var reqHeaders = {};
    if (extraHeaders) for (var hk in extraHeaders) reqHeaders[hk] = extraHeaders[hk];
    if (a.body != null && method !== "GET" && method !== "HEAD") {
      init.body = String(a.body);
      var hasCt = Object.keys(reqHeaders).some(function (k) { return k.toLowerCase() === "content-type"; });
      if (!hasCt) reqHeaders["Content-Type"] = a.contentType || "application/json";
    }
    if (Object.keys(reqHeaders).length) init.headers = reqHeaders;
    // A fetch that never settles (stalled host, dying tab) must fail
    // with a NAMED error, not hang until the act timeout and surface as
    // a bare ok:false (Fix 8 — the amazon.com fetch returned exactly
    // that: no error, no data).
    var controller = null;
    try {
      if (typeof AbortController !== "undefined") {
        controller = new AbortController();
        init.signal = controller.signal;
        setTimeout(function () { try { controller.abort(); } catch (e) {} }, 30000);
      }
    } catch (e) { controller = null; }
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
                  credentials: sameOrigin ? "include" : "omit",
                  headersSent: Object.keys(reqHeaders) }
        };
      });
    }, function (err) {
      // Name the failure instead of surfacing a bare ok:false: a timeout
      // is a timeout, a TypeError is a network/CSP refusal, anything else
      // carries its own message.
      var name = err && err.name;
      var reason = name === "AbortError"
        ? "fetch timed out after 30s (no response from " + u.host + ")"
        : name === "TypeError"
        ? "fetch failed: network error, or the page's CSP blocks requests to " + u.host + " (Failed to fetch)"
        : "fetch failed: " + ((err && err.message) || String(err || "unknown error"));
      throw new Error(reason);
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

  function isScrollableY(el) {
    if (!el || !el.clientHeight) return false;
    if ((el.scrollHeight || 0) <= el.clientHeight + 1) return false;
    var style;
    try { style = window.getComputedStyle(el); } catch (e) { return false; }
    if (!style) return false;
    return ["auto", "scroll", "overlay"].indexOf(style.overflowY) >= 0;
  }

  function scrollableAncestor(el) {
    var node = el;
    while (node && node !== document.documentElement && node !== document.body) {
      if (isScrollableY(node)) return node;
      if (node.parentElement) node = node.parentElement;
      else {
        // Cross the shadow boundary: a control inside a web component
        // scrolls the container outside it.
        var root = node.getRootNode ? node.getRootNode() : null;
        node = root && root.host ? root.host : null;
      }
    }
    return null;
  }

  function scrollBox(box, dir, px) {
    var before = box.scrollTop || 0;
    if (dir === "up") box.scrollTop = before - px;
    else if (dir === "down") box.scrollTop = before + px;
    else if (dir === "top") box.scrollTop = 0;
    else box.scrollTop = box.scrollHeight;
    return Math.abs((box.scrollTop || 0) - before);
  }

  function doScroll(direction, amount, target) {
    // The result must name what actually happened (Prompt 16 §5.5): a
    // missing direction defaults to "down" instead of printing
    // "scrolled undefined", the scroll is applied instantly so the
    // movement can be measured truthfully, and a page that cannot move
    // says so instead of claiming success.
    var dir = ["up", "down", "top", "bottom"].indexOf(direction) >= 0 ? direction : "down";
    var px = amount || 600;
    // Targeted scroll (field fix 2026-11-10): app pages — Seller Central
    // results, dashboards — scroll an INNER container, not the window;
    // a window-only scroll reported "already at the bottom" while the
    // results sat unscrolled in their own box. With a target (ref,
    // label, or selector), scroll the scrollable ancestor of that
    // element — the container it actually lives in.
    if (target && (target.ref || target.label || target.selector)) {
      var el = null;
      if (target.selector) {
        el = document.querySelector(target.selector);
        if (!el) throw new Error("no element for selector '" + target.selector + "'");
      } else {
        el = resolveTarget(target.ref, target.label).el;
      }
      var box = scrollableAncestor(el);
      if (!box) throw new Error("no scrollable container around '" + (target.label || target.selector || target.ref) + "'");
      var movedT = scrollBox(box, dir, px);
      if (movedT > 0) return "scrolled " + dir + " " + Math.round(movedT) + "px (inner container)";
      return "scroll " + dir + " requested — the inner container did not move (already at the " +
        (dir === "up" || dir === "top" ? "top" : "bottom") + ")";
    }
    var before = window.scrollY || 0;
    if (dir === "up") window.scrollBy({ top: -px, behavior: "auto" });
    else if (dir === "down") window.scrollBy({ top: px, behavior: "auto" });
    else if (dir === "top") window.scrollTo({ top: 0, behavior: "auto" });
    else window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
    var moved = Math.abs((window.scrollY || 0) - before);
    if (moved > 0) return "scrolled " + dir + " " + Math.round(moved) + "px";
    // The window cannot move — the page's real scroll surface is an
    // inner container. Find the largest visible one and scroll that
    // instead of declaring the bottom of a page that never moved.
    var all = queryDeep("*");
    var best = null, bestRoom = 0;
    for (var i = 0; i < all.length; i++) {
      var cand = all[i];
      if (!isScrollableY(cand)) continue;
      var r;
      try { r = cand.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || r.width === 0 || r.height === 0) continue;
      var room = cand.scrollHeight - cand.clientHeight;
      if (room > bestRoom) { bestRoom = room; best = cand; }
    }
    if (best) {
      var movedC = scrollBox(best, dir, px);
      if (movedC > 0) return "scrolled " + dir + " " + Math.round(movedC) + "px (inner container)";
    }
    return "scroll " + dir + " requested — the page did not move (already at the " +
      (dir === "up" || dir === "top" ? "top" : "bottom") + ")";
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

  // ------------------------------------------------------------ capture indicator
  // While this tab's audio is captured, a persistent pill says so —
  // with its own Stop button. Capture NEVER runs without this on
  // screen (Chrome's own capture icon shows as well).
  var capturePill = null;
  function setCaptureIndicator(active) {
    try {
      if (active) {
        if (capturePill) return;
        var host = document.createElement("div");
        host.id = "jbb-capture-pill";
        host.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#7f1d1d;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:999px;box-shadow:0 4px 18px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center;";
        var label = document.createElement("span");
        label.textContent = "🎙 Muse is listening to this tab's audio";
        var btn = document.createElement("button");
        btn.textContent = "Stop";
        btn.style.cssText = "background:#fff;color:#7f1d1d;border:0;border-radius:999px;padding:2px 10px;font:600 12px system-ui,sans-serif;cursor:pointer;";
        btn.addEventListener("click", function () {
          try { chrome.runtime.sendMessage({ kind: "jbb.capture.stopRequest" }); } catch (e) {}
          setCaptureIndicator(false);
        });
        host.appendChild(label);
        host.appendChild(btn);
        (document.body || document.documentElement).appendChild(host);
        capturePill = host;
      } else if (capturePill) {
        if (capturePill.remove) capturePill.remove();
        capturePill = null;
      }
    } catch (e) { /* pages that refuse DOM edits still get Chrome's capture icon */ }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.kind === "jbb.capture.indicator") {
      setCaptureIndicator(!!msg.active);
      sendResponse({ ok: true });
      return false;
    }
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
            // Never surface a bare ok:false: an error with no message is
            // still a named failure, not an empty one (Fix 8).
            var em = (err && err.message) || String(err || "");
            if (!em || em === "[object Object]") em = "act failed without a reported reason — observe before retrying";
            sendResponse({ ok: false, error: em });
          });
          return true; // keep the response channel open
        }
        var sendOk = function (o) {
          var resp = { ok: true, detail: o.detail };
          if (o.matchQuality) resp.matchQuality = o.matchQuality;
          if (o.appeared) resp.appeared = o.appeared;
          if (o.data) resp.data = o.data;
          sendResponse(resp);
        };
        var sendErr = function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); };
        var dispatchSync = function () {
          if (a.type === "click") return doClick(t.ref, t.label);
          if (a.type === "type") return doType(t.ref, a.value, t.label);
          if (a.type === "clickAt") return doClickAt(a.point);
          if (a.type === "clickSelector") return doClickSelector(a.selector);
          if (a.type === "key") return doPressKey(a.key, t.ref, t.label);
          if (a.type === "select") return doSelect(t.ref, t.label, a.optionValue != null ? a.optionValue : a.value, a.optionText);
          if (a.type === "setValue") return doSetValue(t.ref, a.value, t.label);
          if (a.type === "drag") return doDrag(a.dragFrom || t, a.dragTo);
          if (a.type === "captions") return doCaptions(a);
          if (a.type === "scroll") return { detail: doScroll(a.direction, a.amount, { ref: t.ref, label: t.label, selector: a.selector }) };
          throw new Error("unknown action type: " + a.type);
        };
        var out;
        try { out = dispatchSync(); }
        catch (err) {
          // The page re-rendered (or is still blank) between the snapshot
          // and execution — the consent wait is long enough for an SPA to
          // redraw several times. Retry resolution across re-renders
          // instead of failing on the first miss; the retry re-dispatches
          // the act once the target is live again.
          if (isResolutionMiss(err) && (t.ref || t.label || a.selector)) {
            resolveWithRetry(t.ref, t.label, a.selector).then(function () {
              try {
                var out2 = dispatchSync();
                if (out2 && typeof out2.then === "function") out2.then(sendOk, sendErr);
                else sendOk(out2);
              } catch (e2) { sendErr(e2); }
            }, sendErr);
            return true; // keep the response channel open
          }
          throw err;
        }
        if (out && typeof out.then === "function") { out.then(sendOk, sendErr); return true; }
        sendOk(out);
      } else {
        sendResponse({ ok: false, error: "unknown content message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
    return false; // synchronous response
  });
})();
