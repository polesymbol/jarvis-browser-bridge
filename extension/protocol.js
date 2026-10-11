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
    // snapshot: { title, url, interactives: [{ref,label,type,name}] }
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
    consentGrant: function (proposalId, scope) {
      // scope: "once" | "site"
      return base("consent.grant", { proposalId: proposalId, scope: scope });
    },
    consentDeny: function (proposalId, reason) {
      return base("consent.deny", { proposalId: proposalId, reason: reason || null });
    },
    actResult: function (proposalId, ok, detail) {
      return base("act.result", { proposalId: proposalId, ok: !!ok, detail: detail || null });
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

  root.JBB = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    ACTION_TIERS: ACTION_TIERS,
    MODES: MODES,
    Message: Message,
    isValidActionTier: isValidActionTier
  };
})(typeof self !== "undefined" ? self : this);
