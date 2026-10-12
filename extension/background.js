/**
 * Jarvis Browser Bridge — background service worker
 *
 * Responsibilities:
 *   1. Hold the WebSocket session to the relay (wss).
 *   2. Enforce permission checks LOCALLY before executing any action.
 *   3. Route consent requests to the side panel and await the user's decision.
 *   4. Execute approved actions via the content script; capture screenshots.
 *   5. Maintain the audit log in chrome.storage.local (never leaves the machine).
 *
 * ---------------------------------------------------------------------------
 * LOCAL ENFORCEMENT — READ THIS BEFORE CHANGING ANYTHING BELOW.
 * ---------------------------------------------------------------------------
 * decideAction() is the single gate every proposed action passes through,
 * whether it arrived from the relay, from mock mode, or from anywhere else.
 * The relay is UNTRUSTED: a compromised relay (or driver) MUST NOT be able
 * to escalate privileges, skip consent, or act on blocked sites. If you add
 * a new action path, it goes through decideAction() — no exceptions.
 */
importScripts("protocol.js");

"use strict";

// ---------------------------------------------------------------- storage keys
var K = {
  KEY: "jbb.connectorKey",     // connector secret (API-key model)
  SETTINGS: "jbb.settings",    // { mode, relayUrl }
  SITES: "jbb.sites",          // { hostname: "allow" | "deny" }
  AUDIT: "jbb.audit",          // [ entries ], capped
  PENDING: "jbb.pending",      // { proposalId: { proposal, createdAt } } — survives worker restarts
  SESSION: "jbb.session",      // { site, grantedAt, expiresAt, label } — time-boxed grant, survives restarts
  SIGNIN_ACK: "jbb.signInAck"  // email the user acknowledged for Chrome sign-in (hard block until acked)
};

var AUDIT_CAP = 500;
var CONSENT_TIMEOUT_MS = 120000;
// Notification escalation: the initial raise plus this many re-raises of an
// OS-swallowed toast. Capped so a runaway loop is impossible; exhaustion is
// audited and the ask stays on badge + banner + panel card until timeout.
var NOTIF_MAX_RAISES = 3;
var NOTIF_VERIFY_DELAY_MS = 4000;

// ---------------------------------------------------------------- state
var state = {
  ws: null,
  connecting: false,          // a dial is in flight (see connectRelay guard)
  connected: false,
  relayUrl: "",
  mode: "ask-some",            // readonly | ask-some | always-ask
  sites: {},
  sessionKilled: false,
  pending: new Map(),          // proposalId -> { proposal, resolve, timer }
  consentNotifs: {},           // notificationId -> proposalId (universal prompt)
  raiseCount: {},              // proposalId -> number of toast raises (escalation cap)
  consentBanners: {},          // proposalId -> tabId (in-page banner)
  session: null,               // time-boxed grant: { site, grantedAt, expiresAt, label }
  chromeSignedInEmail: null,   // Chrome profile sign-in email (null = not signed in)
  signInBlocked: false,        // true when signed in but the account is unacknowledged
  soundOn: true                // audible tone on consent prompts (user works in other windows)
};

var proposalSeq = 0;
function nextProposalId() {
  return "p" + Date.now().toString(36) + "-" + (proposalSeq++);
}

// ---------------------------------------------------------------- boot
chrome.runtime.onInstalled.addListener(function () {
  // Clicking the toolbar icon opens the side panel.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
  // Keepalive: MV3 suspends idle service workers after ~30s, which would
  // silently drop the relay WebSocket. A 30s alarm keeps the worker alive
  // and heals a dropped connection.
  chrome.alarms.create("jbb-keepalive", { periodInMinutes: 0.5 });
  loadPersisted();
  checkNotificationPermission();
});

chrome.runtime.onStartup.addListener(function () { loadPersisted(); hydratePendings(); checkNotificationPermission(); });

// Fires every ~30s, even after the worker was suspended and restarted.
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (!alarm || alarm.name !== "jbb-keepalive") return;
  hydratePendings();
  verifyAllPendingNotifications();
  // Hard expiry for session grants — no silent extension, ever.
  if (state.session && Date.now() >= state.session.expiresAt) expireSession("expired");
  // Re-check sign-in state: a later sign-in can't slip through unnoticed.
  checkSignInState(function () {
    chrome.storage.local.get([K.SETTINGS], function (res) {
      var s = res[K.SETTINGS] || {};
      if (s.relayUrl && !state.connected && !s.killed) {
        state.relayUrl = s.relayUrl;
        state.mode = s.mode || state.mode;
        state.sessionKilled = false;
        connectRelay(s.relayUrl);
      }
    });
  });
});

function loadPersisted() {
  chrome.storage.local.get([K.SETTINGS, K.SITES, K.SESSION], function (res) {
    var s = res[K.SETTINGS] || {};
    state.mode = s.mode || "ask-some";
    state.soundOn = (typeof s.soundOn === "boolean") ? s.soundOn : true;
    state.relayUrl = s.relayUrl || "";
    state.sites = res[K.SITES] || {};
    state.sessionKilled = !!s.killed;
    var sess = res[K.SESSION];
    state.session = (sess && sess.expiresAt > Date.now()) ? sess : null;
    if (!state.session && sess) chrome.storage.local.remove([K.SESSION]);
    checkSignInState();
    refreshBadge();
  });
}

function saveSettings() {
  chrome.storage.local.set({
    [K.SETTINGS]: { mode: state.mode, relayUrl: state.relayUrl, killed: state.sessionKilled,
                    soundOn: state.soundOn },
    [K.SITES]: state.sites
  });
}

// ---------------------------------------------------------------- Chrome sign-in guard
//
// Sync requires Chrome sign-in: no sign-in = sync definitively off = no
// silent import of passwords/payment data. If signed in, we cannot verify
// sync state (no API exposes it), so the relay stays HARD BLOCKED until the
// user explicitly acknowledges the specific account. Re-checked on every
// keepalive so a later sign-in can't slip through unnoticed.
function checkSignInState(callback) {
  var done = function () { if (callback) callback(); };
  if (!chrome.identity || !chrome.identity.getProfileUserInfo) { done(); return; }
  chrome.identity.getProfileUserInfo(function (info) {
    var email = (info && info.email) || null;
    var prevEmail = state.chromeSignedInEmail;
    var wasBlocked = state.signInBlocked;
    state.chromeSignedInEmail = email;
    chrome.storage.local.get([K.SIGNIN_ACK], function (res) {
      var ackedEmail = res[K.SIGNIN_ACK] || null;
      state.signInBlocked = !!email && email !== ackedEmail;
      if (state.signInBlocked && state.connected) {
        // Signed in mid-session (or switched account): drop the relay now.
        // The local kill-switch state is untouched; the user can reconnect
        // after acknowledging.
        disconnectRelay("Chrome sign-in detected: " + email);
      }
      if (state.signInBlocked !== wasBlocked || email !== prevEmail) {
        pushToPanel({ kind: "jbb.ui.signInChanged",
          signedIn: !!email, email: email, blocked: state.signInBlocked });
        refreshBadge();
      }
      done();
    });
  });
}

// ---------------------------------------------------------------- session grants
// Time-boxed consent: the user grants Muse a window (1 hour / 24 hours) to act
// on a site without per-action prompts. T3 actions are NEVER covered — they
// always ask. Expiry is hard: no silent extension. One-click revoke anytime.
function saveSession() {
  if (state.session) chrome.storage.local.set({ [K.SESSION]: state.session });
  else chrome.storage.local.remove([K.SESSION]);
}

function sessionAllows(proposal) {
  var s = state.session;
  if (!s) return false;
  if (Date.now() >= s.expiresAt) { expireSession("expired"); return false; }
  return hostOf(proposal.site || "") === s.site;
}

function sessionRemaining() {
  var s = state.session;
  if (!s) return "";
  var ms = Math.max(0, s.expiresAt - Date.now());
  var m = Math.floor(ms / 60000);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

function expireSession(reason) {
  var s = state.session;
  if (!s) return;
  state.session = null;
  saveSession();
  audit({ site: s.site, action: "session grant", tier: "T0",
          result: "ended", detail: "session " + reason + " (" + s.label + ")" });
  refreshBadge();
  pushToPanel({ kind: "jbb.ui.sessionChanged" });
}

function revokeSession() {
  if (!state.session) return;
  expireSession("revoked by user");
}

function refreshBadge() {
  if (Object.keys(state.consentNotifs).length > 0) {
    chrome.action.setBadgeText({ text: "?" });
    chrome.action.setBadgeBackgroundColor({ color: "#E8710A" });
    return;
  }
  if (state.session && Date.now() < state.session.expiresAt) {
    chrome.action.setBadgeText({ text: "S" });
    chrome.action.setBadgeBackgroundColor({ color: "#2E9E5B" });
    return;
  }
  chrome.action.setBadgeText({ text: "" });
}

// ---------------------------------------------------------------- pending-proposal durability
// Chrome can suspend the service worker at any moment — e.g. while the user
// reads a consent card. Pending proposals are persisted so a restart doesn't
// silently swallow the user's decision (the click would otherwise do nothing
// and the driver would time out).
function persistPending(proposal) {
  chrome.storage.local.get([K.PENDING], function (res) {
    var all = res[K.PENDING] || {};
    all[proposal.proposalId] = { proposal: proposal, createdAt: Date.now() };
    var o = {}; o[K.PENDING] = all;
    chrome.storage.local.set(o);
  });
}

function unpersistPending(proposalId) {
  chrome.storage.local.get([K.PENDING], function (res) {
    var all = res[K.PENDING] || {};
    if (all[proposalId]) {
      delete all[proposalId];
      var o = {}; o[K.PENDING] = all;
      chrome.storage.local.set(o);
    }
  });
}

// (Re)create the in-memory entry for a proposal with the given remaining
// consent window. Returns the entry, or null if the window already elapsed.
function trackPending(proposal, remainingMs) {
  if (remainingMs <= 0) {
    unpersistPending(proposal.proposalId);
    return null;
  }
  var timer = setTimeout(function () {
    var p = state.pending.get(proposal.proposalId);
    if (p) p.resolve({ choice: "deny", reason: "consent timed out" });
  }, remainingMs);
  var entry = {
    proposal: proposal,
    timer: timer,
    resolve: function (answer) {
      // Idempotent: card, notification and banner are three paths to one
      // decision — the first one wins, the rest are no-ops.
      if (!state.pending.has(proposal.proposalId)) return;
      clearTimeout(timer);
      state.pending.delete(proposal.proposalId);
      unpersistPending(proposal.proposalId);
      clearConsentPrompt(proposal.proposalId);
      dismissBannerConsent(proposal.proposalId);
      resolveConsent(proposal, answer);
    }
  };
  state.pending.set(proposal.proposalId, entry);
  return entry;
}

// Re-arm timers for proposals that survived a worker restart. Runs on alarm
// wake and lazily from the consent handler. Cards already rendered in the
// side panel are left alone (no duplicate push).
function hydratePendings(done) {
  chrome.storage.local.get([K.PENDING], function (res) {
    var all = res[K.PENDING] || {};
    var now = Date.now();
    Object.keys(all).forEach(function (id) {
      var rec = all[id];
      var remaining = CONSENT_TIMEOUT_MS - (now - rec.createdAt);
      if (remaining > 0 && !state.pending.has(id)) {
        trackPending(rec.proposal, remaining);
        // The worker restarted mid-consent: the visible notification's click
        // mapping died with the old worker, so re-raise it (same ID updates
        // it in place; runs once — next tick sees it in state.pending).
        notifyConsent(rec.proposal);
      } else if (remaining <= 0) {
        unpersistPending(id);
      }
    });
    if (done) done();
  });
}

// ---------------------------------------------------------------- universal consent prompt
//
// The side-panel card is invisible when the panel is closed — a consent gate
// the user can miss is not a consent gate. So every "ask" also raises an OS
// notification (works with the panel closed) and a badge on the toolbar
// icon. Card and notification are two paths to the same pending proposal;
// the first decision wins (see the idempotent resolve above).

// ---------------------------------------------------------------- consent attention tone
//
// Jarvis works in a separate Chrome window/profile while the user works
// elsewhere — a silent visual prompt is easy to miss. Every consent ask also
// plays a soft two-tone chime via an offscreen document (MV3 workers can't
// play audio directly). Toggleable in the panel; on by default. Re-raise
// paths all funnel through notifyConsent, so one call site covers them.

var offscreenReady = false;

function ensureOffscreenDocument(cb) {
  if (offscreenReady) { cb(); return; }
  var create = function () {
    chrome.offscreen.createDocument(
      { url: "offscreen.html", reasons: ["AUDIO_PLAYBACK"],
        justification: "Play an audible tone when an approval prompt needs attention." },
      function () {
        // "Only one offscreen document" just means it's already there.
        if (chrome.runtime.lastError &&
            chrome.runtime.lastError.message.indexOf("Only one") === -1) {
          audit({ site: "-", action: "consent tone", tier: "T0", result: "failed",
                  detail: "offscreen document failed: " + chrome.runtime.lastError.message });
          return;
        }
        offscreenReady = true;
        cb();
      });
  };
  try {
    if (chrome.offscreen.hasDocument) {
      chrome.offscreen.hasDocument(function (has) {
        if (has) { offscreenReady = true; cb(); } else create();
      });
    } else create();
  } catch (e) { create(); }
}

function playConsentTone() {
  if (!state.soundOn) return;
  try {
    ensureOffscreenDocument(function () {
      try { chrome.runtime.sendMessage({ kind: "jbb.offscreen.playTone" }); }
      catch (e) { /* offscreen gone */ }
    });
  } catch (e) { /* audio unavailable — visual prompt still stands */ }
}

function notifyConsent(proposal) {
  var notifId = "jbb-consent-" + proposal.proposalId;
  state.consentNotifs[notifId] = proposal.proposalId;
  var count = (state.raiseCount[proposal.proposalId] || 0) + 1;
  state.raiseCount[proposal.proposalId] = count;
  var where = hostOf(proposal.site || "") || "this site";
  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icon128.png",
    title: "Jarvis wants your approval",
    message: (proposal.description || proposal.type) + " — on " + where,
    buttons: [{ title: "Allow once" }, { title: "Deny" }],
    priority: 2,
    requireInteraction: true
  }, function () {
    if (chrome.runtime.lastError) {
      // Never fail silent: a broken approval prompt is a security issue.
      delete state.consentNotifs[notifId];
      var err = chrome.runtime.lastError.message || "unknown error";
      audit({ site: "-", action: "consent notification", tier: "T0", result: "failed",
              detail: "notification failed (" + err + ") — check OS/browser notification settings for Chrome" });
      pushToPanel({ kind: "jbb.ui.notifFailed", error: err });
      checkNotificationPermission();
    } else {
      // Audited raise: if the toast never shows, the audit trail proves the
      // extension asked — the gap is then the OS, not the gate.
      audit({ site: hostOf(proposal.site || "") || "-", action: "consent notification",
              tier: "T0", result: "raised",
              detail: "approval toast raised (" + count + "/" + NOTIF_MAX_RAISES + ")" });
    }
  });
  // The OS can swallow a toast silently (Focus Assist, Do Not Disturb,
  // revoked Chrome notification permission) — create() succeeds, no
  // lastError, nothing on screen, and the ask degrades to badge-only.
  // Verify the toast is actually visible; re-raise (capped) if it isn't.
  scheduleNotifVerify(notifId, proposal.proposalId);
  playConsentTone();
  refreshBadge();
}

// Verify one toast a few seconds after raising. setTimeout alone is not
// enough — MV3 can suspend the worker before it fires — so the keepalive
// alarm also runs verifyAllPendingNotifications() every tick.
function scheduleNotifVerify(notifId, proposalId) {
  setTimeout(function () { verifyNotifVisible(notifId, proposalId); }, NOTIF_VERIFY_DELAY_MS);
}

function verifyNotifVisible(notifId, proposalId) {
  if (!state.pending.has(proposalId)) return;          // already decided
  if (state.consentNotifs[notifId] !== proposalId) return; // cleared meanwhile
  chrome.notifications.getAll(function (all) {
    if (chrome.runtime.lastError || !all) return;
    if (!all[notifId]) {
      var entry = state.pending.get(proposalId);
      if (!entry) return;
      var count = state.raiseCount[proposalId] || 0;
      if (count < NOTIF_MAX_RAISES) {
        audit({ site: hostOf(entry.proposal.site || "") || "-", action: "consent notification",
                tier: "T0", result: "re-raised",
                detail: "approval toast swallowed by OS (not visible " + NOTIF_VERIFY_DELAY_MS +
                        "ms after raise); re-raising (" + (count + 1) + "/" + NOTIF_MAX_RAISES + ")" });
        notifyConsent(entry.proposal); // same ID updates in place
      } else {
        audit({ site: hostOf(entry.proposal.site || "") || "-", action: "consent notification",
                tier: "T0", result: "escalation-exhausted",
                detail: "toast swallowed after " + NOTIF_MAX_RAISES + " raises; ask remains on " +
                        "badge + banner + panel card until the consent window times out" });
      }
    }
  });
}

// Sweep every keepalive tick: any pending proposal whose toast is not in
// the notification center gets the same capped re-raise treatment. This
// covers worker suspensions the one-shot setTimeout missed.
function verifyAllPendingNotifications() {
  chrome.notifications.getAll(function (all) {
    if (chrome.runtime.lastError || !all) return;
    state.pending.forEach(function (entry, proposalId) {
      var notifId = "jbb-consent-" + proposalId;
      if (state.consentNotifs[notifId] === proposalId && !all[notifId]) {
        verifyNotifVisible(notifId, proposalId);
      }
    });
  });
}

function clearConsentPrompt(proposalId) {
  Object.keys(state.consentNotifs).forEach(function (notifId) {
    if (state.consentNotifs[notifId] === proposalId) {
      delete state.consentNotifs[notifId];
      chrome.notifications.clear(notifId);
    }
  });
  delete state.raiseCount[proposalId];
  if (Object.keys(state.consentNotifs).length === 0) {
    refreshBadge();
  }
}

function decideFromNotification(proposalId, choice, reason) {
  // The worker may have slept since the proposal arrived — hydrate from
  // storage before looking it up, or the decision is silently dropped.
  hydratePendings(function () {
    var entry = state.pending.get(proposalId);
    if (entry) entry.resolve({ choice: choice, reason: reason });
    else clearConsentPrompt(proposalId); // already decided elsewhere
  });
}

// Self-test so the user can verify OS notification settings at any time.
function testNotification() {
  var notifId = "jbb-test-" + Date.now().toString(36);
  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icon128.png",
    title: "Jarvis Browser Bridge",
    message: "Test — approval prompts will look like this.",
    buttons: [{ title: "Looks good" }, { title: "Dismiss" }],
    priority: 2
  }, function () {
    if (chrome.runtime.lastError) {
      pushToPanel({ kind: "jbb.ui.notifFailed",
                    error: chrome.runtime.lastError.message || "unknown error" });
    } else {
      pushToPanel({ kind: "jbb.ui.notifOk" });
    }
  });
}

chrome.notifications.onButtonClicked.addListener(function (notifId, btnIdx) {
  if (notifId.indexOf("jbb-test-") === 0) { chrome.notifications.clear(notifId); return; }
  var proposalId = state.consentNotifs[notifId];
  if (!proposalId) return;
  if (btnIdx === 0) decideFromNotification(proposalId, "once");
  else decideFromNotification(proposalId, "deny", "denied from notification");
});

// ---------------------------------------------------------------- notification permission pre-check
//
// An extension can hold the "notifications" permission while the OS or
// Chrome silently blocks delivery (Focus Assist, Do Not Disturb, revoked
// Chrome notification permission). chrome.notifications.create then
// succeeds — no lastError — and the ask degrades to badge-only. So we
// check the permission level proactively and warn in the panel + audit,
// instead of waiting for a swallowed toast.
function checkNotificationPermission() {
  if (!chrome.notifications || !chrome.notifications.getPermissionLevel) return;
  chrome.notifications.getPermissionLevel(function (level) {
    if (level !== "granted") {
      var detail = "OS/browser notification permission is '" + level +
        "' — approval prompts may never appear; the badge, in-page banner and " +
        "panel card remain as fallbacks. Enable Chrome notifications in OS " +
        "settings for the full ask.";
      audit({ site: "-", action: "consent notification", tier: "T0",
              result: "permission-blocked", detail: detail });
      pushToPanel({ kind: "jbb.ui.notifPermission", level: level, detail: detail });
    }
  });
}

chrome.notifications.onClosed.addListener(function (notifId, byUser) {
  if (notifId.indexOf("jbb-test-") === 0) return;
  var proposalId = state.consentNotifs[notifId];
  if (!proposalId) return;
  var entry = state.pending.get(proposalId);
  if (!entry) { clearConsentPrompt(proposalId); return; }
  if (!byUser && (state.raiseCount[proposalId] || 0) < NOTIF_MAX_RAISES) {
    // Closed by the system (not the user) with no decision — the ask may
    // never have been seen. Re-raise it (capped, audited) rather than
    // degrading to badge-only. Fail closed only at timeout or on an
    // explicit user dismiss — never on a silent system close.
    audit({ site: hostOf(entry.proposal.site || "") || "-", action: "consent notification",
            tier: "T0", result: "re-raised",
            detail: "toast closed by system without a decision; re-raising (" +
                    ((state.raiseCount[proposalId] || 0) + 1) + "/" + NOTIF_MAX_RAISES + ")" });
    notifyConsent(entry.proposal);
    return;
  }
  // User-dismissed, or escalation exhausted: fail closed.
  decideFromNotification(proposalId, "deny", "notification dismissed");
});

// ---------------------------------------------------------------- in-page consent banner
//
// OS notifications are at the mercy of OS settings (Windows Focus Assist,
// Chrome notification permissions) and the toolbar badge needs the user to
// watch the icon — neither is a reliable consent gate. The banner injects a
// top-center prompt directly into the active tab: impossible to miss while
// looking at the page, needs no OS cooperation. Shown only when the side
// panel is closed (the card covers the open case). Notification + badge +
// card remain as additional channels; first decision wins everywhere.

function jbbConsentBanner(summary) {
  // NOTE: serialized into the tab via chrome.scripting.executeScript —
  // must stay fully self-contained (no outer-scope references).
  var BANNER_ID = "jbb-consent-banner";
  function remove() {
    var b = document.getElementById(BANNER_ID);
    if (b) b.remove();
    window.__jbbBannerProposal = null;
  }
  if (!window.__jbbBannerInstalled) {
    window.__jbbBannerInstalled = true;
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.kind === "jbb.banner.dismiss") {
        if (!msg.proposalId || msg.proposalId === window.__jbbBannerProposal) remove();
      }
    });
  }
  remove();
  window.__jbbBannerProposal = summary.proposalId;

  var bar = document.createElement("div");
  bar.id = BANNER_ID;
  bar.setAttribute("style", [
    "position:fixed", "top:12px", "left:50%", "transform:translateX(-50%)",
    "z-index:2147483647", "display:flex", "flex-wrap:wrap", "align-items:center", "gap:10px",
    "background:#17171c", "color:#f5f5f7", "border:1px solid #3a3a44",
    "border-left:4px solid #e8710a", "border-radius:12px",
    "padding:10px 14px", "font:14px/1.4 -apple-system,'Segoe UI',Roboto,sans-serif",
    "box-shadow:0 8px 30px rgba(0,0,0,.45)", "max-width:min(660px,92vw)"
  ].join(";"));

  function btn(label, primary, choice) {
    var b = document.createElement("button");
    b.textContent = label;
    b.setAttribute("style", [
      "cursor:pointer", "border:1px solid " + (primary ? "#e8710a" : "#4a4a55"),
      "background:" + (primary ? "#e8710a" : "transparent"),
      "color:#fff", "border-radius:8px", "padding:6px 12px", "font-size:13px",
      "font-weight:" + (primary ? "600" : "400"), "white-space:nowrap"
    ].join(";"));
    b.addEventListener("click", function (ev) {
      // SECURITY (enemy audit 2026-10-11): only real user clicks count.
      // Page JavaScript can dispatch synthetic clicks on banner buttons
      // (clickjacking self-approval); those have isTrusted === false.
      if (ev && ev.isTrusted === false) return;
      chrome.runtime.sendMessage({ kind: "jbb.banner.decision",
        proposalId: summary.proposalId, choice: choice });
      remove();
    });
    return b;
  }

  var dot = document.createElement("span");
  dot.setAttribute("style", "width:10px;height:10px;border-radius:50%;background:#e8710a;flex:none");
  var txt = document.createElement("span");
  var strong = document.createElement("strong");
  strong.textContent = "Jarvis wants your approval";
  txt.appendChild(strong);
  txt.appendChild(document.createElement("br"));
  var sub = document.createElement("span");
  sub.setAttribute("style", "color:#b9b9c4;font-size:12px");
  sub.textContent = (summary.description || "action") + " — " + (summary.site || "this site") +
    (summary.tier ? " · " + summary.tier : "");
  txt.appendChild(sub);

  bar.appendChild(dot);
  bar.appendChild(txt);
  bar.appendChild(btn("Allow once", true, "once"));
  bar.appendChild(btn("This site", false, "site"));
  bar.appendChild(btn("1 hour", false, "session1h"));
  bar.appendChild(btn("1 day", false, "session24h"));
  bar.appendChild(btn("Deny", false, "deny"));
  (document.documentElement || document.body).appendChild(bar);
}

function showBannerConsent(proposal) {
  // Always attempt the banner when the tab allows it — panel-open tracking
  // proved too fragile to gate on, and a redundant banner next to the card
  // is merely ugly, never wrong. First decision wins everywhere.
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    var url = (tab && tab.url) || "";
    var base = { site: proposal.site || "-", action: "consent banner", tier: "T0" };
    if (!tab || !tab.id || !/^https?:\/\//i.test(url)) {
      base.result = "skipped"; base.detail = "no injectable active tab";
      audit(base); return;
    }
    var summary = {
      proposalId: proposal.proposalId,
      description: proposal.description || proposal.type || "action",
      site: hostOf(proposal.site || ""),
      tier: proposal.actionTier || ""
    };
    state.consentBanners[proposal.proposalId] = tab.id;
    try {
      chrome.scripting.executeScript(
        { target: { tabId: tab.id }, func: jbbConsentBanner, args: [summary] }
      ).then(function () {
        base.result = "shown"; base.detail = "banner injected into active tab";
        audit(base);
      }, function (err) {
        delete state.consentBanners[proposal.proposalId];
        base.result = "failed";
        base.detail = "injection failed: " + String((err && err.message) || err);
        audit(base);
      });
    } catch (e) {
      delete state.consentBanners[proposal.proposalId];
      base.result = "failed"; base.detail = "injection threw: " + String(e && e.message || e);
      audit(base);
    }
  });
}

function dismissBannerConsent(proposalId) {
  var tabId = state.consentBanners[proposalId];
  delete state.consentBanners[proposalId];
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, { kind: "jbb.banner.dismiss", proposalId: proposalId })
      .catch(function () {});
  } catch (e) { /* tab gone */ }
}

// Make sure the relay socket is up (and paired) before sending anything that
// must reach the driver — e.g. a consent grant after a worker restart.
function ensureRelayConnected(cb) {
  if (state.connected && state.ws && state.ws.readyState === WebSocket.OPEN) { cb(); return; }
  if (!state.relayUrl || state.sessionKilled) { cb(); return; }
  connectRelay(state.relayUrl);
  var waited = 0;
  var iv = setInterval(function () {
    waited += 250;
    var up = state.connected && state.ws && state.ws.readyState === WebSocket.OPEN;
    if (up || waited >= 8000) {
      clearInterval(iv);
      cb();
    }
  }, 250);
}

// ---------------------------------------------------------------- audit log
function audit(entry) {
  entry.ts = entry.ts || Date.now();
  chrome.storage.local.get([K.AUDIT], function (res) {
    var log = res[K.AUDIT] || [];
    log.push(entry);
    if (log.length > AUDIT_CAP) log = log.slice(log.length - AUDIT_CAP);
    chrome.storage.local.set({ [K.AUDIT]: log }, function () {
      pushToPanel({ kind: "jbb.ui.auditAppended", entry: entry });
    });
  });
}

// Best-effort push to the side panel (it may be closed — that's fine).
function pushToPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(function () { /* panel closed */ });
}

// ---------------------------------------------------------------- permission gate
function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ""; }
}

/**
 * THE gate. Returns { decision: "allow"|"ask"|"deny", reason? }.
 * Runs locally in the service worker for every proposed action.
 */
function decideAction(proposal) {
  // 1. Dead session acts on nothing.
  if (state.sessionKilled) {
    return { decision: "deny", reason: "session was killed" };
  }
  // 2. Validate the tier — malformed proposals are denied, not defaulted.
  if (!JBB.isValidActionTier(proposal.actionTier)) {
    return { decision: "deny", reason: "invalid action tier" };
  }
  var host = hostOf(proposal.site || "");
  // 3. Explicit site block always wins.
  if (host && state.sites[host] === "deny") {
    return { decision: "deny", reason: "site is blocked" };
  }
  // 4. Readonly mode: observe (T0) only.
  if (state.mode === "readonly") {
    return proposal.actionTier === "T0"
      ? { decision: "allow" }
      : { decision: "deny", reason: "readonly mode" };
  }
  // 5. T3 ALWAYS confirms — in every mode, on every site. No exceptions.
  if (proposal.actionTier === "T3") {
    return { decision: "ask", reason: "sensitive action always asks" };
  }
  // 6. "Always ask" mode: everything asks.
  if (state.mode === "always-ask") {
    return { decision: "ask" };
  }
  // 7. "Ask for some actions": trusted sites act freely, unknown sites ask.
  if (host && state.sites[host] === "allow") {
    return { decision: "allow" };
  }
  return { decision: "ask", reason: "site not yet approved" };
}

// ---------------------------------------------------------------- relay (WebSocket)
//
// Connection lifecycle is generation-guarded: every (dis)connect bumps
// connGen, and a socket's handlers ignore events once a newer generation
// exists. This kills a whole class of races — duplicate dials, stale
// onclose handlers clobbering the live socket, and reconnect loops where
// each new connection kills the previous one at the relay.
var connGen = 0;

function connectRelay(url) {
  // Never stack duplicate connections: if a socket exists or one is dialing,
  // there is nothing to do.
  if (state.ws || state.connecting) return;
  // HARD BLOCK: signed into Chrome with an unacknowledged account. Sync may
  // be importing passwords and payment data — no relay until the user
  // explicitly acknowledges the account. No warn-and-allow.
  if (state.signInBlocked) {
    pushToPanel({ kind: "jbb.ui.status", connected: false,
      error: "Blocked: Chrome sign-in (" + (state.chromeSignedInEmail || "?") +
             ") not acknowledged. Acknowledge it in the panel or sign out." });
    audit({ site: "-", action: "relay connect", tier: "T0",
            result: "denied", detail: "blocked: unacknowledged Chrome sign-in" });
    return;
  }
  state.connecting = true;
  state.relayUrl = url;
  saveSettings();

  chrome.storage.local.get([K.KEY], function (res) {
    var key = res[K.KEY];
    state.connecting = false;
    if (!key) {
      pushToPanel({ kind: "jbb.ui.status", connected: false, error: "no connector key — generate one first" });
      return;
    }
    if (state.ws) return; // someone beat us while we were reading the key
    var gen = ++connGen;
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      pushToPanel({ kind: "jbb.ui.status", connected: false, error: "bad relay URL" });
      return;
    }
    state.ws = ws;
    state.connected = false;

    ws.onopen = function () {
      if (gen !== connGen) { try { ws.close(); } catch (e) {} return; } // stale
      // Authenticate with the full connector key + role, per protocol v1.
      // Encrypted by TLS on wss://; loopback-only on ws://127.0.0.1.
      ws.send(JSON.stringify(JBB.Message.pairRequest("extension", key)));
    };
    ws.onmessage = function (ev) {
      if (gen !== connGen) return; // stale
      handleRelayMessage(ev.data);
    };
    ws.onclose = function () {
      if (gen !== connGen) return; // stale socket: ignore completely
      state.connected = false;
      state.ws = null;
      pushToPanel({ kind: "jbb.ui.status", connected: false });
      // Backoff reconnect while a relay URL is configured
      // and the session wasn't killed.
      if (state.relayUrl && !state.sessionKilled) {
        setTimeout(function () {
          if (state.ws === null && !state.connecting && state.relayUrl && !state.sessionKilled) {
            connectRelay(state.relayUrl);
          }
        }, 5000);
      }
    };
    ws.onerror = function () {
      if (gen !== connGen) return; // stale
      pushToPanel({ kind: "jbb.ui.status", connected: false, error: "relay connection failed" });
    };
  });
}

function disconnectRelay(reason) {
  connGen++; // invalidate every existing socket's handlers
  state.connecting = false;
  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
    state.ws = null;
  }
  state.connected = false;
}

function sendToRelay(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function handleRelayMessage(raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || msg.v !== JBB.PROTOCOL_VERSION || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "pair.confirm":
      state.connected = true;
      pushToPanel({ kind: "jbb.ui.status", connected: true });
      audit({ site: "-", action: "session paired", tier: "T0", result: "allowed", detail: "protocol " + msg.v });
      break;
    case "act.propose":
      if (msg.proposal) {
        // Adopt the driver's wire id so consent/actResult correlate.
        if (msg.id) msg.proposal.proposalId = msg.id;
        handleProposal(msg.proposal, "relay");
      }
      break;
    case "observe.request": {
      var obsId = msg.id;
      observeActiveTab(false).then(
        function (m) {
          m.id = obsId;
          sendToRelay(m);
        },
        function (err) {
          sendToRelay({ v: JBB.PROTOCOL_VERSION, type: "observe.result", id: obsId, ok: false, error: String((err && err.message) || err) });
        }
      );
      break;
    }
    case "session.abort": {
      // SECURITY (enemy audit 2026-10-11): a remote abort is the peer hanging
      // up, NOT the local kill switch. A compromised relay/driver must not be
      // able to kill the user's session (DoS). Fail pendings, drop the socket,
      // keep local kill state untouched so the user can reconnect.
      var abortReason = "peer aborted: " + (msg.reason || "no reason");
      state.pending.forEach(function (p) {
        clearTimeout(p.timer);
        p.resolve({ choice: "deny", reason: abortReason });
      });
      state.pending.clear();
      audit({ site: "-", action: "session abort", tier: "T0",
              result: "ended", detail: abortReason + " (remote; local kill switch untouched)" });
      pushToPanel({ kind: "jbb.ui.status", connected: false, error: abortReason });
      if (state.ws) { try { state.ws.close(); } catch (e) {} }
      break;
    }
    // observe.request is answered on demand; unknown types are ignored.
  }
}

// ---------------------------------------------------------------- proposal -> consent -> execute
function handleProposal(proposal, source) {
  proposal.proposalId = proposal.proposalId || nextProposalId();
  proposal.source = source;

  // LOCAL ENFORCEMENT: the gate runs before anything else.
  var verdict = decideAction(proposal);

  // Session grants layer on top of "ask": a live time-boxed grant auto-allows
  // T1/T2 on its site. T3 is NEVER covered — sensitive actions always ask.
  var viaSession = verdict.decision === "ask" &&
                   proposal.actionTier !== "T3" &&
                   sessionAllows(proposal);

  audit({
    site: proposal.site || "-",
    action: proposal.description || proposal.type,
    tier: proposal.actionTier || "?",
    result: verdict.decision === "deny" ? "denied" :
            (verdict.decision === "allow" || viaSession) ? "allowed" : "awaiting consent",
    detail: viaSession ? "session grant (" + sessionRemaining() + " left)" : (verdict.reason || null)
  });

  if (verdict.decision === "deny") {
    sendToRelay(JBB.Message.consentDeny(proposal.proposalId, verdict.reason));
    sendToRelay(JBB.Message.actResult(proposal.proposalId, false, verdict.reason));
    return;
  }
  if (verdict.decision === "allow" || viaSession) {
    // Auto-allowed (e.g. trusted site): the driver still needs the verdict —
    // otherwise it waits for a consent message that never comes.
    var autoScope = viaSession ? "session" : (function () {
      var h = hostOf(proposal.site || "");
      return (h && state.sites[h] === "allow") ? "site" : "once";
    })();
    sendToRelay(JBB.Message.consentGrant(proposal.proposalId, autoScope));
    executeProposal(proposal);
    return;
  }

  // "ask": hold the proposal and wait for the user in the side panel.
  // Persisted as well, so a service-worker restart mid-consent can't lose it.
  trackPending(proposal, CONSENT_TIMEOUT_MS);
  persistPending(proposal);

  pushToPanel({ kind: "jbb.ui.consentRequest", proposal: proposal });
  // Universal prompt: the panel card is invisible when the panel is closed.
  notifyConsent(proposal);
  showBannerConsent(proposal);
}

function resolveConsent(proposal, answer) {
  // SECURITY (enemy audit round 2): fail closed on unknown choice values.
  // Anything that isn't an explicit approval becomes a denial — never execute
  // on garbage input.
  var VALID_CHOICES = { "once": 1, "site": 1, "session1h": 1, "session24h": 1, "deny": 1 };
  if (!answer || !VALID_CHOICES[answer.choice]) {
    answer = { choice: "deny", reason: "invalid consent choice" };
  }
  if (answer.choice === "deny") {
    sendToRelay(JBB.Message.consentDeny(proposal.proposalId, answer.reason || "user denied"));
    sendToRelay(JBB.Message.actResult(proposal.proposalId, false, "denied by user"));
    audit({
      site: proposal.site || "-",
      action: proposal.description || proposal.type,
      tier: proposal.actionTier,
      result: "denied",
      detail: "user denied"
    });
    pushToPanel({ kind: "jbb.ui.consentResolved", proposalId: proposal.proposalId, choice: "deny" });
    return;
  }

  // "once" or "site"
  if (answer.choice === "site") {
    var host = hostOf(proposal.site || "");
    if (host) {
      state.sites[host] = "allow";
      saveSettings();
      // Request host permission on demand — the trust story in action.
      chrome.permissions.request({ origins: ["https://" + host + "/*", "http://" + host + "/*"] })
        .catch(function () {});
      pushToPanel({ kind: "jbb.ui.sitesChanged" });
    }
  }

  // Time-boxed session grant: Muse may act on this site without per-action
  // prompts until the window lapses. T3 actions are still never covered.
  if (answer.choice === "session1h" || answer.choice === "session24h") {
    var shost = hostOf(proposal.site || "");
    var sms = answer.choice === "session1h" ? 3600e3 : 86400e3;
    state.session = {
      site: shost,
      grantedAt: Date.now(),
      expiresAt: Date.now() + sms,
      label: answer.choice === "session1h" ? "1 hour" : "24 hours"
    };
    saveSession();
    audit({
      site: proposal.site || "-",
      action: "session grant",
      tier: proposal.actionTier,
      result: "allowed",
      detail: "granted " + state.session.label + " for " + shost + " (T3 still asks)"
    });
    refreshBadge();
    pushToPanel({ kind: "jbb.ui.sessionChanged" });
    answer = { choice: "session" };
  }
  sendToRelay(JBB.Message.consentGrant(proposal.proposalId, answer.choice));
  pushToPanel({ kind: "jbb.ui.consentResolved", proposalId: proposal.proposalId, choice: answer.choice });
  executeProposal(proposal);
}

function executeProposal(proposal) {
  runOnPage(proposal).then(
    function (detail) {
      sendToRelay(JBB.Message.actResult(proposal.proposalId, true, detail));
      audit({
        site: proposal.site || "-",
        action: proposal.description || proposal.type,
        tier: proposal.actionTier,
        result: "executed",
        detail: detail
      });
    },
    function (err) {
      sendToRelay(JBB.Message.actResult(proposal.proposalId, false, String(err)));
      audit({
        site: proposal.site || "-",
        action: proposal.description || proposal.type,
        tier: proposal.actionTier,
        result: "failed",
        detail: String(err)
      });
    }
  );
}

// Ensure the content script is present on the tab, then run the action.
function runOnPage(proposal) {
  return getActiveTab().then(function (tab) {
    if (!tab || !tab.id) throw new Error("no active tab");
    var isInternal = /^chrome:|^edge:|^about:/.test(tab.url || "");
    // navigate needs no content script — chrome.tabs.update can leave a
    // chrome:// page for a web URL. So it is allowed from internal pages;
    // the site binding below still guards the destination.
    if (proposal.type === "navigate" && proposal.url) {
      // SECURITY (enemy audit 2026-10-11): bind execution to the consented site.
      // proposal.site is driver-supplied and untrusted; without this check a
      // malicious driver could get a grant for site A and silently send the
      // user's tab to site B. Fail closed on mismatch.
      var claimedHost = hostOf(proposal.site || "");
      var destHost = hostOf(proposal.url);
      if (claimedHost && destHost !== claimedHost) {
        throw new Error("site mismatch: consented for " + claimedHost +
          " but navigate targets " + destHost);
      }
      return chrome.tabs.update(tab.id, { url: proposal.url }).then(function () {
        return "navigated to " + proposal.url;
      });
    }
    if (isInternal) {
      throw new Error("cannot act on browser-internal pages");
    }
    // SECURITY (enemy audit 2026-10-11): bind execution to the consented site
    // for page actions too. proposal.site is driver-supplied and untrusted;
    // the tab URL is ground truth.
    var claimedHost = hostOf(proposal.site || "");
    var actualHost = hostOf(tab.url || "");
    if (claimedHost && actualHost !== claimedHost) {
      throw new Error("site mismatch: consented for " + claimedHost +
        " but active tab is " + (actualHost || "unknown"));
    }
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["protocol.js", "content.js"]
    }).then(function () {
      var msg = { kind: "jbb.content.act", action: proposal };
      // navigate is handled by the background (tabs API), not the page.
      if (proposal.type === "navigate" && proposal.url) {
        return chrome.tabs.update(tab.id, { url: proposal.url }).then(function () {
          return "navigated to " + proposal.url;
        });
      }
      return chrome.tabs.sendMessage(tab.id, msg).then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || "content script error");
        return res.detail;
      });
    });
  });
}

function observeActiveTab(withScreenshot) {
  return getActiveTab().then(function (tab) {
    if (!tab || !tab.id) throw new Error("no active tab");
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["protocol.js", "content.js"]
    }).then(function () {
      return chrome.tabs.sendMessage(tab.id, { kind: "jbb.content.observe" });
    }).then(function (res) {
      if (!res || !res.ok) throw new Error("observe failed");
      var snap = res.snapshot;
      if (!withScreenshot) return JBB.Message.observeResult(snap, null);
      return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
        .catch(function () { return null; })
        .then(function (dataUrl) {
          return JBB.Message.observeResult(snap, dataUrl);
        });
    });
  });
}

function getActiveTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(function (tabs) {
    return tabs[0] || null;
  });
}

// ---------------------------------------------------------------- kill switch
function killSession(reason) {
  state.sessionKilled = true;
  // Deny everything still waiting on the user.
  state.pending.forEach(function (p) {
    clearTimeout(p.timer);
    p.resolve({ choice: "deny", reason: "session killed" });
  });
  state.pending.clear();
  sendToRelay(JBB.Message.sessionAbort(reason || "user kill switch"));
  disconnectRelay("killed");
  state.relayUrl = ""; // require explicit reconnect
  saveSettings();
  audit({ site: "-", action: "session killed", tier: "T3", result: "executed", detail: reason || "user kill switch" });
  pushToPanel({ kind: "jbb.ui.killed" });
  pushToPanel({ kind: "jbb.ui.status", connected: false });
}

chrome.commands.onCommand.addListener(function (command) {
  if (command === "kill-session") killSession("keyboard shortcut");
});

// ---------------------------------------------------------------- mock mode
// No relay URL configured -> the side panel runs standalone. This fabricates
// a realistic proposal against the CURRENT tab so the consent-card UX,
// site grants, kill switch and audit log can be reviewed with zero backend.
function mockPropose() {
  observeActiveTab(false).then(function (msg) {
    var snap = msg.snapshot;
    var target = (snap.interactives || []).find(function (e) { return e.type === "button"; })
      || (snap.interactives || [])[0];
    var proposal = {
      actionTier: target ? "T1" : "T0",
      type: target ? "click" : "scroll",
      target: target ? { ref: target.ref, label: target.label } : null,
      direction: target ? null : "down",
      site: snap.url,
      description: target
        ? "Click '" + target.label + "' on " + hostOf(snap.url) + "  [mock]"
        : "Scroll down on " + hostOf(snap.url) + "  [mock]"
    };
    handleProposal(proposal, "mock");
  }).catch(function (err) {
    pushToPanel({ kind: "jbb.ui.toast", text: "Mock observe failed: " + err.message });
  });
}

// ---------------------------------------------------------------- messages from the side panel
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.kind !== "string" ||
      (msg.kind.indexOf("jbb.ui.") !== 0 && msg.kind !== "jbb.banner.decision")) {
    return false;
  }
  var done = function (payload) { sendResponse(Object.assign({ ok: true }, payload || {})); };

  switch (msg.kind) {
    case "jbb.ui.getState":
      chrome.storage.local.get([K.AUDIT], function (res) {
        var sess = state.session;
        if (sess && Date.now() >= sess.expiresAt) { expireSession("expired"); sess = null; }
        done({
          connected: state.connected,
          mockMode: !state.relayUrl,
          relayUrl: state.relayUrl,
          mode: state.mode,
          soundOn: state.soundOn,
          sites: state.sites,
          killed: state.sessionKilled,
          pending: Array.from(state.pending.values()).map(function (p) { return p.proposal; }),
          session: sess ? { site: sess.site, label: sess.label,
                            remainingMs: Math.max(0, sess.expiresAt - Date.now()) } : null,
          audit: res[K.AUDIT] || []
        });
      });
      return true; // async

    case "jbb.ui.setMode":
      if (JBB.MODES[msg.mode]) {
        state.mode = msg.mode;
        saveSettings();
        audit({ site: "-", action: "mode set to " + JBB.MODES[msg.mode].label, tier: "T0", result: "allowed" });
        pushToPanel({ kind: "jbb.ui.modeChanged", mode: state.mode });
      }
      done();
      break;

    case "jbb.ui.setSound":
      state.soundOn = !!msg.on;
      saveSettings();
      audit({ site: "-", action: "consent sound " + (state.soundOn ? "enabled" : "disabled"),
              tier: "T0", result: "allowed" });
      if (state.soundOn) playConsentTone(); // preview so the user knows what it sounds like
      done({ soundOn: state.soundOn });
      break;

    case "jbb.ui.setRelayUrl":
      state.relayUrl = (msg.url || "").trim();
      saveSettings();
      done({ mockMode: !state.relayUrl });
      break;

    case "jbb.ui.connect":
      // Check sign-in state first: the block must apply to manual connects too.
      checkSignInState(function () {
        if (state.relayUrl) { state.sessionKilled = false; connectRelay(state.relayUrl); }
      });
      done();
      break;

    case "jbb.ui.disconnect":
      disconnectRelay("user disconnect");
      pushToPanel({ kind: "jbb.ui.status", connected: false });
      done();
      break;

    case "jbb.ui.ackSignIn":
      // User explicitly acknowledges the signed-in account, accepting that
      // Sync may import passwords/payment data. Stored per-email: a different
      // account re-blocks.
      if (state.chromeSignedInEmail) {
        var ackEmail = state.chromeSignedInEmail;
        chrome.storage.local.set({ [K.SIGNIN_ACK]: ackEmail }, function () {
          state.signInBlocked = false;
          audit({ site: "-", action: "Chrome sign-in acknowledged", tier: "T0",
                  result: "allowed", detail: ackEmail + " (user accepted sync risk)" });
          pushToPanel({ kind: "jbb.ui.signInChanged",
            signedIn: true, email: ackEmail, blocked: false });
          refreshBadge();
          done();
        });
        return true; // async
      }
      done({ error: "not signed in" });
      break;

    case "jbb.ui.consent":
      // The worker may have restarted since the card was shown — recover the
      // proposal from storage, make sure the relay is up, then resolve.
      hydratePendings(function () {
        ensureRelayConnected(function () {
          var p = state.pending.get(msg.proposalId);
          if (p) {
            p.resolve({ choice: msg.choice, reason: msg.reason });
            done();
          } else {
            pushToPanel({ kind: "jbb.ui.consentResolved", proposalId: msg.proposalId, choice: "deny", reason: "consent expired" });
            done({ error: "consent expired or unknown proposal" });
          }
        });
      });
      return true; // async

    case "jbb.ui.kill":
      killSession("side panel kill switch");
      done();
      break;

    case "jbb.ui.revive":
      // After a kill, the user explicitly starts over.
      state.sessionKilled = false;
      audit({ site: "-", action: "session revived by user", tier: "T0", result: "allowed" });
      pushToPanel({ kind: "jbb.ui.revived" });
      done();
      break;

    case "jbb.ui.revokeSite":
      if (msg.host) {
        delete state.sites[msg.host];
        saveSettings();
        chrome.permissions.remove({ origins: ["https://" + msg.host + "/*", "http://" + msg.host + "/*"] })
          .catch(function () {});
        pushToPanel({ kind: "jbb.ui.sitesChanged" });
      }
      done();
      break;

    case "jbb.ui.revokeSession":
      revokeSession();
      done();
      break;

    case "jbb.ui.getSignInState":
      checkSignInState(function () {
        done({ signedIn: !!state.chromeSignedInEmail,
               email: state.chromeSignedInEmail,
               blocked: state.signInBlocked });
      });
      return true; // async

    case "jbb.ui.blockSite":
      if (msg.host) {
        state.sites[msg.host] = "deny";
        saveSettings();
        pushToPanel({ kind: "jbb.ui.sitesChanged" });
      }
      done();
      break;

    case "jbb.ui.mockPropose":
      mockPropose();
      done();
      break;

    case "jbb.ui.testNotif":
      testNotification();
      playConsentTone(); // preview the attention chime alongside the test toast
      done();
      break;

    case "jbb.banner.decision":
      // Same hydration need as notifications: the worker may have slept
      // since the proposal arrived.
      hydratePendings(function () {
        var bEntry = state.pending.get(msg.proposalId);
        if (bEntry) bEntry.resolve({ choice: msg.choice });
        else dismissBannerConsent(msg.proposalId);
        done();
      });
      return true; // async

    case "jbb.ui.observe":
      observeActiveTab(!!msg.screenshot).then(
        function (m) { done({ observation: m }); },
        function (err) { done({ error: String(err && err.message || err) }); }
      );
      return true; // async

    default:
      done({ error: "unknown ui message" });
  }
  return false;
});
