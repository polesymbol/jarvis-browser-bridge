/**
 * Jarvis Browser Bridge — protocol v1.0
 *
 * Shared message shapes between the extension (background / content / side
 * panel) and the relay/driver. Loaded as a plain script everywhere
 * (importScripts in the service worker, <script> in the side panel,
 * injected alongside content.js).
 *
 * Wire format is JSON: { v: 1, type: "<message-type>", ...fields }
 *
 * Canonical v1 shapes (relay, driver, and extension all speak these):
 *   pair.request  { role: "extension"|"driver", key: "<connector key>" }
 *   pair.confirm  { role, peer: bool }
 *   observe.request  { id }  ->  observe.result { id, snapshot, screenshot }
 *   act.propose   { id, proposal: { actionTier, type, target:{ref,label},
 *                   value?, site, description } }
 *   consent.grant { id, scope: "once"|"site" } | consent.deny { id, reason }
 *   act.result    { id, ok, detail }
 *   session.abort { reason }
 *
 * SECURITY NOTE: messages arriving from the relay are UNTRUSTED INPUT.
 * The background service worker re-validates every proposed action against
 * local permissions before executing anything. A compromised relay must not
 * be able to escalate.
 */
(function (root) {
  "use strict";

  var PROTOCOL_VERSION = 1;

  // Action tiers, escalating friction. Mirrors ARCHITECTURE.md §4.4.
  // T3 = always confirm, never auto-run, in every mode.
  var ACTION_TIERS = {
    T0: { label: "T0 · Observe", desc: "Read / summarize. Never changes anything." },
    T1: { label: "T1 · Navigate", desc: "Navigate, scroll, click within the current site." },
    T2: { label: "T2 · Interact", desc: "Type into fields, submit forms." },
    T3: { label: "T3 · Sensitive", desc: "Cross-origin, downloads, auth, payment, email, publishing, deletion. ALWAYS confirms." }
  };

  // User-facing permission modes — mirrors Muse's native
  // Settings > Permissions language ("Ask for some actions" / "Always ask").
  var MODES = {
    "readonly":  { label: "Readonly", desc: "Observe only. The assistant cannot act." },
    "ask-some":  { label: "Ask for some actions", desc: "Acts within your grants. Sensitive actions always ask." },
    "always-ask":{ label: "Always ask", desc: "Every action asks for approval first." }
  };

  function base(type, fields) {
    var msg = { v: PROTOCOL_VERSION, type: type, ts: Date.now() };
    if (fields) {
      for (var k in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) msg[k] = fields[k];
      }
    }
    return msg;
  }

  var Message = {
    pairRequest: function (role, key) {
      // The full connector key authenticates the session. It travels inside
      // TLS on wss:// relays, or over loopback on ws://127.0.0.1. Never log it.
      return base("pair.request", { role: role, key: key });
    },
    pairConfirm: function (sessionToken, expiresAt, mode) {
      return base("pair.confirm", { sessionToken: sessionToken, expiresAt: expiresAt, mode: mode });
    },

    observeRequest: function (tabId) {
      return base("observe.request", { tabId: tabId || null });
    },
    // snapshot: { title, url, interactives: [{ref,label,type,name}],
    //   text, textTruncated, media: [{tag,duration,currentTime,paused,src,
    //   tracks:[{kind,label,language,mode,activeCue?,transcript?}]}],
    //   frames?: [ <same shape per sub-frame, frameId set, its interactives
    //   refs prefixed "f<frameId>:" so actions can route back to the frame> ] }
    // screenshot: data URL (png) or null
    observeResult: function (snapshot, screenshot) {
      return base("observe.result", { snapshot: snapshot, screenshot: screenshot || null });
    },

    // proposal: {
    //   proposalId, actionTier: "T0".."T3",
    //   type: "click"|"type"|"scroll"|"navigate",
    //   target: { ref, label }, value (for type), site (page URL),
    //   description: plain-language, e.g. "Click 'Add to cart' on amazon.com"
    // }
    actPropose: function (proposal) {
      return base("act.propose", { proposal: proposal });
    },
    // Consent lifecycle acknowledgements (additive; the relay forwards any
    // type and older drivers ignore what they don't know):
    //   act.propose -> proposal.received -> consent.shown -> consent.waiting*
    //   -> consent.grant | consent.deny (verdict) -> act.result (applied/failed)
    // proposal.received proves the extension took the proposal in — without
    // it, "extension offline" and "prompt never shown" are indistinguishable.
    proposalReceived: function (proposalId) {
      return base("proposal.received", { proposalId: proposalId });
    },
    // Sent ONLY when a prompt is actually visible: the side-panel card has
    // rendered (panel ack) or the in-page banner is in the tab's DOM.
    consentShown: function (proposalId, via) {
      return base("consent.shown", { proposalId: proposalId, via: via || null });
    },
    // Heartbeat while a shown prompt sits unanswered (~every 10s).
    consentWaiting: function (proposalId, waitedMs) {
      return base("consent.waiting", { proposalId: proposalId, waitedMs: waitedMs || 0 });
    },
    consentGrant: function (proposalId, scope) {
      // scope: "once" | "site"
      return base("consent.grant", { proposalId: proposalId, scope: scope });
    },
    consentDeny: function (proposalId, reason) {
      return base("consent.deny", { proposalId: proposalId, reason: reason || null });
    },
    actResult: function (proposalId, ok, detail, error, snapshotVersion, matchQuality, data) {
      var m = base("act.result", { proposalId: proposalId, ok: !!ok, detail: detail || null });
      if (error) m.error = error;
      if (typeof snapshotVersion === "number") m.snapshotVersion = snapshotVersion;
      if (matchQuality) m.matchQuality = matchQuality;
      if (data !== undefined) m.data = data;
      return m;
    },

    audioChunk: function (fields) {
      // One ~1s chunk of captured tab audio (base64 Opus/WebM),
      // extension → driver. Transits the relay; stored nowhere.
      return base("audio.chunk", fields || {});
    },

    mediaProgress: function (fields) {
      // Live media progress, extension → driver. Transits the relay;
      // stored nowhere.
      return base("media.progress", fields || {});
    },

    sessionAbort: function (reason) {
      return base("session.abort", { reason: reason || "user kill switch" });
    },

    // entry: { ts, site, action, tier, result: "allowed"|"denied"|"executed"|"failed", detail }
    logAppend: function (entry) {
      return base("log.append", { entry: entry });
    }
  };

  function isValidActionTier(t) {
    return t === "T0" || t === "T1" || t === "T2" || t === "T3";
  }

  /**
   * Canonical label normalization: label matching is exact AFTER this
   * runs on both sides. Zero-width characters (ZWSP/ZWNJ/ZWJ/BOM) are
   * stripped, non-breaking spaces (NBSP, narrow NBSP) become plain
   * spaces, whitespace runs collapse, ends trim. content.js and driver.js
   * carry byte-equivalent local copies — keep all three in sync.
   */
  function normalizeLabel(s) {
    return String(s == null ? "" : s)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\u00A0\u202F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Plain-language explanation for a denied / blocked / failed audit
   * entry: why it happened and what would allow it. Shown in the panel
   * feed — the user should never have to decode a reason string.
   */
  function plainReason(entry) {
    var d = String((entry && entry.detail) || "");
    if (entry && entry.via === "consent" && entry.result === "denied") {
      return { why: "You denied this action.", fix: "Approve it next time if you want it to happen." };
    }
    if (/site is blocked/.test(d)) {
      return { why: "This site is on your block list.", fix: "Remove the block in the Sites tab to allow actions there." };
    }
    if (/readonly mode/.test(d)) {
      return { why: "The bridge is in read-only mode, so nothing may change the page.", fix: "Switch the permission mode to “Ask for some actions” to allow changes." };
    }
    if (/stale snapshot/i.test(d)) {
      return { why: "The page changed after Muse looked at it, so the action was refused rather than risk the wrong element.", fix: "Nothing needed — Muse can look again and retry against the fresh page." };
    }
    if (/session killed|kill switch/.test(d)) {
      return { why: "The session was stopped with the kill switch.", fix: "Start a new session when you want Muse to act again." };
    }
    if (/key rotated/i.test(d)) {
      return { why: "The connector key was rotated, so the old pairing is no longer valid.", fix: "Pair again with the new key." };
    }
    if (/invalid custom grant/.test(d)) {
      return { why: "That grant length was not valid.", fix: "Pick one of the preset grant durations." };
    }
    if (/not yet approved/.test(d)) {
      return { why: "This site is not approved yet.", fix: "Approve the action (or the site) when asked." };
    }
    if (entry && entry.result === "failed") {
      return { why: "The action did not complete: " + (d || "unknown error"), fix: "Muse can look at the page again and retry." };
    }
    return { why: d || "It was not allowed.", fix: "" };
  }

  /**
   * Feed category for one audit entry, or null when the entry is not a
   * finished action outcome (verdict intermediates, pairing events and
   * other bookkeeping stay in the full audit tab, out of the feed).
   * Only entries tied to a proposal count — one row per action.
   */
  function feedCategory(entry) {
    if (!entry || !entry.proposalId) return null;
    if (entry.result === "executed") {
      if (entry.via === "whitelist") {
        var m = /allowed by whitelist: ([^\]]+)/.exec(String(entry.detail || ""));
        return { key: "auto-whitelist", label: "Auto-allowed by whitelist: " + (m ? m[1] : entry.site || "") };
      }
      if (entry.via === "session") return { key: "auto-session", label: "Auto-allowed by session grant" };
      if (entry.via === "consent") return { key: "asked-granted", label: "Asked — you approved" };
      return { key: "allowed", label: "Allowed" };
    }
    if (entry.result === "denied") {
      if (entry.via === "consent") return { key: "asked-denied", label: "Asked — you denied" };
      return { key: "blocked", label: "Blocked" };
    }
    if (entry.result === "failed") return { key: "failed", label: "Didn't work" };
    return null;
  }

  /** The live feed: finished actions only, newest first, capped. */
  function feedRows(entries, limit) {
    var rows = [];
    (entries || []).forEach(function (e) {
      var cat = feedCategory(e);
      if (!cat) return;
      var reason = (e.result === "denied" || e.result === "failed") ? plainReason(e) : { why: "", fix: "" };
      rows.push({
        ts: e.ts || 0, site: e.site || "-", action: e.action || e.type || "action",
        type: e.type || null, category: cat.key, label: cat.label,
        why: reason.why, fix: reason.fix
      });
    });
    rows.sort(function (a, b) { return b.ts - a.ts; });
    return rows.slice(0, limit || 10);
  }

  root.JBB = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    ACTION_TIERS: ACTION_TIERS,
    MODES: MODES,
    Message: Message,
    isValidActionTier: isValidActionTier,
    normalizeLabel: normalizeLabel,
    plainReason: plainReason,
    feedCategory: feedCategory,
    feedRows: feedRows
  };
})(typeof self !== "undefined" ? self : this);
