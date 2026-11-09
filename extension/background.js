/**
 * Jarvis Browser Bridge — background service worker
 *
 * Responsibilities:
 *   1. Own the relay session's LOGIC (the WebSocket itself lives in the
 *      offscreen document — Chrome suspends this worker and used to take
 *      the socket with it; transport there, enforcement here).
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
  SITES: "jbb.sites",          // { hostname: "allow" | "deny" } — deny blocks live here; allows migrated to WHITELIST
  WHITELIST: "jbb.whitelist",  // { domain: { domain, tiers, actions, grantedAt, lastUsedAt, keyId, schemaVersion } } — persistent per-site allow
  SUMMARY: "jbb.lastSummary",  // last session summary (counts by type/site + denials) for the panel
  AUDIT: "jbb.audit",          // [ entries ], capped
  PENDING: "jbb.pending",      // { proposalId: { proposal, createdAt } } — survives worker restarts
  RESULTS: "jbb.results",      // { proposalId: { ok, detail, at } } — executed acts, for id dedupe
  SESSION: "jbb.session",      // { site, grantedAt, expiresAt, label, epoch } — time-boxed grant, survives restarts
  EPOCH: "jbb.keyEpoch",       // increments on every key rotation; grants carry their epoch
  KEY_ACKED: "jbb.keyAcked",   // true once the user confirmed they saved the key (panel-owned, mirrored here for rotation)
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
  connected: false,           // relay paired (reported by the offscreen transport)
  snapshotVersion: 0,         // bumps on every observe + every applied act; acts built against an older version are refused STALE_SNAPSHOT
  relayDownSince: null,       // when transport was first seen down (watchdog)
  offscreenSeenAt: 0,         // last sign of life from the offscreen document
  relayUrl: "",
  mode: "ask-some",            // readonly | ask-some | always-ask
  sites: {},
  whitelist: {},               // domain -> entry (see grantWhitelist); exact-domain, tier-scoped, epoch-bound
  grantsPaused: false,         // master switch: while true, NO grant auto-allows (whitelist or session)
  sessionStartedAt: 0,         // when the current driver session began (pairing); 0 = no live session window
  summaryBuiltFor: 0,          // sessionStartedAt value the last summary was built for (build at most once per session)
  lastSummary: null,           // most recent session summary (mirrors K.SUMMARY)
  sessionKilled: false,
  pending: new Map(),          // proposalId -> { proposal, resolve, timer, createdAt, shown, shownVia, escalated, lastWaitingAt, elapsed }
  executing: new Set(),        // proposalIds currently executing (dedupe)
  gating: new Set(),           // proposalIds whose tab context is resolving pre-verdict
  tabsCache: [],               // last known tab list (panel Tabs card)
  actResults: new Map(),       // proposalId -> { ok, detail, at } (dedupe store, persisted at K.RESULTS)
  keyEpoch: 1,                 // current key epoch; grants from older epochs are invalid
  badgeFlashTimer: null,       // escalation badge flash interval
  consentNotifs: {},           // notificationId -> proposalId (universal prompt)
  raiseCount: {},              // proposalId -> number of toast raises (escalation cap)
  consentBanners: {},          // proposalId -> tabId (in-page banner)
  session: null,               // time-boxed grant: { site, grantedAt, expiresAt, label }
  capture: null,               // live audio capture: { tabId, host, captureId, startedAt }
  captureWaiter: null,         // pending capture-start handshake with the offscreen doc
  capturePermission: false,    // tabCapture optional permission granted by the user?
  chromeSignedInEmail: null,   // Chrome profile sign-in email (null = not signed in)
  signInBlocked: false,        // true when signed in but the account is unacknowledged
  soundOn: true                // audible tone on consent prompts (user works in other windows)
};

var proposalSeq = 0;
function nextProposalId() {
  return "p" + Date.now().toString(36) + "-" + (proposalSeq++);
}

// Restore the executed-act store so id dedupe survives worker restarts,
// and the current key epoch so grant binding survives them too.
chrome.storage.local.get([K.RESULTS, K.EPOCH], function (res) {
  var all = res[K.RESULTS] || {};
  Object.keys(all).forEach(function (id) { state.actResults.set(id, all[id]); });
  state.keyEpoch = res[K.EPOCH] || 1;
});

function generateConnectorKey() {
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  var hex = Array.prototype.map.call(bytes, function (b) {
    return ("0" + b.toString(16)).slice(-2);
  }).join("");
  return "jbb_" + hex;
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
  // Pre-warm the consent tone engine (see onStartup).
  setTimeout(function () { if (state.soundOn) ensureOffscreenDocument(function () {}); }, 3000);
});

chrome.runtime.onStartup.addListener(function () {
  loadPersisted(); hydratePendings(); checkNotificationPermission(); refreshCapturePermission();
  // Pre-warm the consent tone engine so the first chime isn't slow:
  // creating the offscreen document + AudioContext takes a beat on cold start.
  setTimeout(function () { if (state.soundOn) ensureOffscreenDocument(function () {}); }, 3000);
});

// Fires every ~30s, even after the worker was suspended and restarted.
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (!alarm || alarm.name !== "jbb-keepalive") return;
  hydratePendings();
  verifyAllPendingNotifications();
  consentHeartbeatSweep();
  relayWatchdog();
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
  chrome.storage.local.get([K.SETTINGS, K.SITES, K.SESSION, K.WHITELIST, K.EPOCH, K.SUMMARY], function (res) {
    var s = res[K.SETTINGS] || {};
    state.mode = s.mode || "ask-some";
    state.soundOn = (typeof s.soundOn === "boolean") ? s.soundOn : true;
    state.relayUrl = s.relayUrl || "";
    state.sites = res[K.SITES] || {};
    state.grantsPaused = !!s.grantsPaused;
    state.whitelist = res[K.WHITELIST] || {};
    state.lastSummary = res[K.SUMMARY] || null;
    if (typeof res[K.EPOCH] === "number" && res[K.EPOCH] > 0) state.keyEpoch = res[K.EPOCH];
    // Migrate legacy blanket site-allows (pre-whitelist builds stored
    // sites[host] = "allow", covering every non-T3 tier forever) into
    // whitelist entries, so they gain tier/action scoping, schema
    // versioning, and key binding. The user's grant is preserved; its
    // shape is upgraded. Runs once — migrated hosts leave the sites map.
    var migrated = false;
    Object.keys(state.sites).forEach(function (host) {
      if (state.sites[host] !== "allow") return;
      if (!state.whitelist[host]) {
        state.whitelist[host] = {
          domain: host, tiers: ["T1", "T2"], actions: WHITELIST_ACTIONS_V1.slice(),
          grantedAt: Date.now(), lastUsedAt: Date.now(),
          keyId: state.keyEpoch, schemaVersion: WHITELIST_SCHEMA, migrated: true
        };
      }
      delete state.sites[host];
      migrated = true;
    });
    if (migrated) { saveWhitelist(); saveSettings(); }
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
                    soundOn: state.soundOn, grantsPaused: state.grantsPaused },
    [K.SITES]: state.sites
  });
}

// ---------------------------------------------------------------- site whitelist
//
// Persistent per-site allow — the careful version of "Always allow on
// this site". An entry covers an action only when ALL of these hold:
//   - the site host EXACTLY equals entry.domain (no silent wildcarding;
//     subdomains are separate entries — a "*.domain" entry can only ever
//     be added explicitly, and this build never creates one);
//   - the action's tier is in entry.tiers AND its type is in
//     entry.actions (the concrete list granted at schema time, so action
//     types added in future versions are NOT silently covered);
//   - entry.schemaVersion is current (older entries are ignored -> ask);
//   - entry.keyId is the current key epoch (rotation invalidates every
//     entry — and also deletes them outright, see rotateConnectorKey).
// T3 is carved out in code, twice: grantWhitelist refuses to write a T3
// tier, and whitelistCovers refuses T3 proposals — and decideAction asks
// T3 before the whitelist is even consulted. There is NO auto-allow path
// for T3 in any mode.
// keyId stores the key EPOCH, never key material: the epoch is the key's
// identity for binding purposes, and the key itself is never persisted
// outside its own storage slot.
var WHITELIST_SCHEMA = 1;
// The CURRENT action vocabulary for NEW grants and manager sanitization.
// Stored entries carry their own list from grant time — that is the whole
// point: entries granted before hover/select/drag/setValue existed do
// NOT list them, so those actions still ask under old entries until the
// user re-confirms (manager Keep) or re-grants.
var WHITELIST_ACTIONS_V1 = ["click", "type", "scroll", "navigate", "clickAt", "clickSelector", "key",
                            "hover", "select", "drag", "setValue",
                            "listTabs", "switchTab", "closeTab", "closeInactiveTabs", "openTab", "pinTab",
                            "waitFor", "fetch", "media", "captions", "frameGrab", "audioCapture"];

function saveWhitelist() {
  chrome.storage.local.set({ [K.WHITELIST]: state.whitelist });
}

function whitelistEntryFor(host) {
  var e = state.whitelist[host];
  if (!e) return null;
  if (e.schemaVersion !== WHITELIST_SCHEMA) return null;
  if (e.keyId !== state.keyEpoch) return null;
  return e;
}

function whitelistCovers(proposal, host) {
  if (state.grantsPaused) return null; // master pause: nothing auto-allows
  if (!host || proposal.actionTier === "T3") return null; // hard carve-out
  var e = whitelistEntryFor(host);
  if (!e) return null;
  if (e.tiers.indexOf(proposal.actionTier) === -1) return null;
  if (e.actions.indexOf(proposal.type) === -1) return null;
  return e;
}

function grantWhitelist(host, tier) {
  if (!host || tier === "T3") return null; // T3 can never be written
  var now = Date.now();
  var existing = state.whitelist[host];
  var tiers = existing ? existing.tiers.slice() : [];
  if (tiers.indexOf(tier) === -1) tiers.push(tier);
  var entry = {
    domain: host,
    tiers: tiers,
    // An existing entry keeps its per-action checkboxes (the manager may
    // have deliberately unchecked some); only a fresh entry starts with
    // the full schema vocabulary.
    actions: existing ? existing.actions.slice() : WHITELIST_ACTIONS_V1.slice(),
    grantedAt: existing ? existing.grantedAt : now,
    lastUsedAt: now,
    reviewedAt: now,
    keyId: state.keyEpoch,
    schemaVersion: WHITELIST_SCHEMA
  };
  state.whitelist[host] = entry;
  saveWhitelist();
  pushToPanel({ kind: "jbb.ui.sitesChanged" });
  return entry;
}

// Normalize a user-typed domain for the whitelist manager: lowercase,
// strip scheme / path / query / port. Returns null for anything that is
// not a plain hostname — wildcards are refused here too (a "*.domain"
// entry is a separate explicit feature, never a typing accident).
function normalizeDomain(raw) {
  if (typeof raw !== "string") return null;
  var d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  d = d.split("/")[0].split("?")[0].split("#")[0];
  d = d.split(":")[0];
  d = d.replace(/\.$/, "").replace(/^\./, "");
  if (!d || d.indexOf("*") !== -1 || /[^a-z0-9.\-]/.test(d)) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(d)) return null;
  return d;
}

function looksPunycode(domain) {
  return domain.indexOf("xn--") !== -1;
}

// Manager add: tiers default to T1 and are sanitized to T1/T2 — T3 can
// never be granted from anywhere, the manager included.
function addWhitelistEntry(domain, tiers) {
  var clean = (Array.isArray(tiers) ? tiers : ["T1"]).filter(function (t) {
    return t === "T1" || t === "T2";
  });
  if (!clean.length) clean = ["T1"];
  var now = Date.now();
  var entry = {
    domain: domain,
    tiers: clean,
    actions: WHITELIST_ACTIONS_V1.slice(),
    grantedAt: now,
    lastUsedAt: 0,
    reviewedAt: now,
    keyId: state.keyEpoch,
    schemaVersion: WHITELIST_SCHEMA
  };
  state.whitelist[domain] = entry;
  saveWhitelist();
  pushToPanel({ kind: "jbb.ui.sitesChanged" });
  return entry;
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
// Time-boxed consent: the user grants Muse a window on ONE site — 1 hour,
// 24 hours, 1 week, or a custom "until" date/time they pick — so a multi-step
// job does not re-prompt for every action. A permanent per-site grant also
// exists (scope "site", stored in state.sites). NEITHER kind covers T3:
// critical actions (auth, payments, email, publishing, deletion, anything
// hard to undo) ALWAYS ask, even inside a window, even on a permanent site.
// Expiry is hard: no silent extension. One-click revoke anytime.
function saveSession() {
  if (state.session) chrome.storage.local.set({ [K.SESSION]: state.session });
  else chrome.storage.local.remove([K.SESSION]);
}

function sessionAllows(proposal) {
  var s = state.session;
  if (!s) return false;
  // Grants are bound to the key epoch that created them: a grant made
  // under a rotated-away key is not a grant anymore. (Legacy grants with
  // no epoch predate binding and are accepted at epoch 1 only because the
  // epoch itself did not exist when they were made.)
  if (s.epoch != null && s.epoch !== state.keyEpoch) { expireSession("key rotated"); return false; }
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

// ---------------------------------------------------------------- key rotation
// Rotating the connector key must actually bite — previously the key lived
// in storage while grants lived elsewhere, so "rotate after the session"
// revoked nothing. One rotation now, atomically:
//   1. bumps the key epoch (session grants carry their epoch; older-epoch
//      grants fail sessionAllows from this moment),
//   2. drops the session grant and every per-site "allow" (grants made
//      under the old key die with it — "deny" blocks are not grants and
//      stay), so the panel reads 0 active grants,
//   3. revokes the old key at the relay (key.revoked) and closes the live
//      socket — the connected driver is told KEY_ROTATED and disconnected,
//   4. stores the new key (un-acked, so the panel reveals it exactly once)
//      and re-pairs as the extension under it.
// The new key is returned to the panel only in this call's response. It is
// never audited, never logged, never written anywhere but key storage.
function rotateConnectorKey(done) {
  chrome.storage.local.get([K.KEY, K.EPOCH], function (res) {
    var oldKey = res[K.KEY] || null;
    var newEpoch = (res[K.EPOCH] || 1) + 1;
    var newKey = generateConnectorKey();

    var grantsCleared = 0;
    if (state.session) { state.session = null; grantsCleared++; }
    chrome.storage.local.remove([K.SESSION]);
    Object.keys(state.sites).forEach(function (h) {
      if (state.sites[h] === "allow") { delete state.sites[h]; grantsCleared++; }
    });
    // Whitelist entries are bound to this key (keyId = epoch) — rotation
    // wipes them outright, not just by epoch mismatch (belt and braces:
    // the panel must honestly show 0 active grants afterwards).
    grantsCleared += Object.keys(state.whitelist).length;
    state.whitelist = {};
    chrome.storage.local.remove([K.WHITELIST]);
    saveSettings();
    state.keyEpoch = newEpoch;

    var patch = {};
    patch[K.KEY] = newKey;
    patch[K.EPOCH] = newEpoch;
    patch[K.KEY_ACKED] = false;
    chrome.storage.local.set(patch, function () {
      if (oldKey) {
        try { sendToRelay({ v: JBB.PROTOCOL_VERSION, type: "key.revoked", key: oldKey }); }
        catch (e) { /* transport raced — the disconnect below still ends the session */ }
      }
      // Give the revocation a beat to reach the relay before the transport
      // drops the socket — the relay must poison the old room, not just
      // lose it.
      setTimeout(function () {
        disconnectRelay("key rotated");
        audit({ site: "-", action: "connector key", tier: "T0", result: "rotated",
                detail: "key rotated (epoch " + newEpoch + "); " + grantsCleared +
                        " grant(s) invalidated; driver session disconnected" });
        pushToPanel({ kind: "jbb.ui.status", connected: false });
        pushToPanel({ kind: "jbb.ui.sessionChanged" });
        refreshBadge();
        if (state.relayUrl && !state.sessionKilled) connectRelay(state.relayUrl);
        if (done) done(newKey);
      }, 350);
    });
  });
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
// consent window. A window that elapses does NOT resolve the proposal:
// a consent timeout must never silently become deny-and-forget. The entry
// is marked elapsed, stays tracked + persisted, and remains visible and
// answerable in the panel until the user decides, the session is killed,
// or the peer explicitly aborts.
function trackPending(proposal, remainingMs, createdAt) {
  var elapsed = remainingMs != null && remainingMs <= 0;
  var timer = null;
  if (remainingMs != null && remainingMs > 0) {
    timer = setTimeout(function () {
      var p = state.pending.get(proposal.proposalId);
      if (!p) return;
      p.elapsed = true;
      audit({ site: proposal.site || "-", action: proposal.description || proposal.type,
              tier: proposal.actionTier, result: "awaiting consent",
              detail: "consent window elapsed with no answer — proposal remains queued in the panel (no auto-deny)" });
    }, remainingMs);
  }
  var entry = {
    proposal: proposal,
    timer: timer,
    createdAt: createdAt || Date.now(),
    shown: false,
    shownVia: null,
    escalated: false,
    lastWaitingAt: 0,
    elapsed: elapsed,
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
  ensureHeartbeat();
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
      if (!state.pending.has(id)) {
        // Elapsed proposals are re-tracked too (no auto-deny, ever) — just
        // without re-raising a stale toast on every wake.
        trackPending(rec.proposal, remaining, rec.createdAt);
        if (remaining > 0) {
          // The worker restarted mid-consent: the visible notification's click
          // mapping died with the old worker, so re-raise it (same ID updates
          // it in place; runs once — next tick sees it in state.pending).
          notifyConsent(rec.proposal);
        }
      }
    });
    if (done) done();
  });
}

// ---------------------------------------------------------------- consent lifecycle acks
// The driver used to get one opaque timeout for three different states
// (extension offline / prompt never shown / prompt shown but unanswered).
// Now the lifecycle is explicit: proposal.received -> consent.shown ->
// consent.waiting (heartbeat) -> consent.grant|consent.deny -> act.result.
// consent.shown is sent ONLY when a prompt is actually visible: the panel
// card has rendered (the panel acks it) or the in-page banner is confirmed
// in the tab's DOM. The OS toast and badge are attention channels, not
// "shown" proof — a swallowed toast must not fake a shown prompt.

var heartbeatTimer = null;
function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(consentHeartbeatSweep, 10000);
}

function markConsentShown(proposalId, via) {
  var entry = state.pending.get(proposalId);
  if (!entry || entry.shown) return;
  entry.shown = true;
  entry.shownVia = via;
  sendToRelay(JBB.Message.consentShown(proposalId, via));
}

function consentHeartbeatSweep() {
  var now = Date.now();
  state.pending.forEach(function (entry, proposalId) {
    if (!entry.shown) return;
    var waited = now - entry.createdAt;
    if (now - (entry.lastWaitingAt || 0) >= 10000) {
      entry.lastWaitingAt = now;
      sendToRelay(JBB.Message.consentWaiting(proposalId, waited));
    }
    // One escalation at ~60s unanswered: re-chime + re-raise the toast
    // once (notifyConsent does both, same notification ID in place) and
    // flash the badge. Once per proposal — this is a nudge, not a loop.
    if (waited >= 60000 && !entry.escalated) {
      entry.escalated = true;
      audit({ site: entry.proposal.site || "-", action: entry.proposal.description || entry.proposal.type,
              tier: entry.proposal.actionTier, result: "escalated",
              detail: "consent prompt unanswered for 60s — re-chimed, toast re-raised once, badge flashing" });
      notifyConsent(entry.proposal);
      flashBadge();
    }
  });
}

function flashBadge() {
  if (state.badgeFlashTimer) return;
  var n = 0;
  state.badgeFlashTimer = setInterval(function () {
    n++;
    if (n % 2 === 1) {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#d92d20" });
    } else {
      chrome.action.setBadgeText({ text: "?" });
      chrome.action.setBadgeBackgroundColor({ color: "#E8710A" });
    }
    if (n >= 8) {
      clearInterval(state.badgeFlashTimer);
      state.badgeFlashTimer = null;
      refreshBadge();
    }
  }, 400);
}

// Record an executed act under its id (memory + storage). This is the
// idempotency store: a re-sent act.propose with the same id gets the stored
// result resent instead of a second execution.
function recordActResult(proposalId, ok, detail) {
  state.actResults.set(proposalId, { ok: !!ok, detail: detail || null, at: Date.now() });
  if (state.actResults.size > 100) {
    state.actResults.delete(state.actResults.keys().next().value);
  }
  var obj = {};
  state.actResults.forEach(function (v, k) { obj[k] = v; });
  chrome.storage.local.set({ [K.RESULTS]: obj });
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
var offscreenWantTone = false; // a tone was requested before the page signalled ready
var offscreenUnsupported = false; // chrome.offscreen missing (old Chrome) — tone disabled

function offscreenAvailable() {
  if (offscreenUnsupported) return false;
  if (!chrome.offscreen || !chrome.offscreen.createDocument) {
    offscreenUnsupported = true;
    audit({ site: "-", action: "consent tone", tier: "T0", result: "unavailable",
            detail: "chrome.offscreen API not present — audible tone disabled, visual prompts unaffected" });
    return false;
  }
  return true;
}

function ensureOffscreenDocument(cb) {
  if (!offscreenAvailable()) return;
  if (offscreenReady) { cb(); return; }
  // Remember the intent: the ready handshake (below) will flush it.
  var create = function () {
    chrome.offscreen.createDocument(
      { url: "offscreen.html", reasons: ["AUDIO_PLAYBACK"],
        justification: "Play an audible tone when an approval prompt needs attention, and hold the relay WebSocket so it survives service-worker suspension." },
      function () {
        // "Only one offscreen document" just means it's already there.
        if (chrome.runtime.lastError &&
            chrome.runtime.lastError.message.indexOf("Only one") === -1) {
          audit({ site: "-", action: "consent tone", tier: "T0", result: "failed",
                  detail: "offscreen document failed: " + chrome.runtime.lastError.message });
          return;
        }
        // Do NOT mark ready here: the create callback fires before the
        // page's script runs, so an immediate playTone would be lost.
        // Readiness comes from the page's own jbb.offscreen.ready signal.
        if (chrome.runtime.lastError) {
          // Document already existed — its script is running; treat as ready.
          offscreenReady = true;
          cb();
        }
        // else: wait for the ready signal.
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

// Called when the offscreen page signals its script is running.
function onOffscreenReady() {
  offscreenReady = true;
  state.offscreenSeenAt = Date.now();
  if (offscreenWantTone) {
    offscreenWantTone = false;
    sendPlayTone();
  }
  // A (re)created document also means the relay transport may need its
  // connection re-posted (it says hello separately too — either path heals).
  if (state.relayUrl && !state.sessionKilled) postRelayConnect();
}

function sendPlayTone(kind) {
  try { chrome.runtime.sendMessage({ kind: "jbb.offscreen.playTone", tone: kind || "waiting" }); }
  catch (e) { /* offscreen gone */ }
}

// Distinct verdict tones (accessibility): grant rises, deny descends.
// Same soundOn master switch as the waiting chime.
function playVerdictTone(granted) {
  if (!state.soundOn) return;
  try {
    ensureOffscreenDocument(function () {
      sendPlayTone(granted ? "grant" : "deny");
    });
  } catch (e) { /* tones are best-effort */ }
}

function playConsentTone() {
  if (!state.soundOn) return;
  try {
    ensureOffscreenDocument(function () {
      if (offscreenReady) sendPlayTone();
      else offscreenWantTone = true; // flushed by the ready handshake
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
  bar.appendChild(btn("1 week", false, "session1w"));
  bar.appendChild(btn("Deny", false, "deny"));
  (document.documentElement || document.body).appendChild(bar);
  // executeScript reports this back: the banner is in the DOM, i.e. the
  // prompt is actually visible — the only honest basis for consent.shown.
  return true;
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
      ).then(function (results) {
        if (results && results[0] && results[0].result === true) {
          base.result = "shown"; base.detail = "banner visible in active tab";
          audit(base);
          markConsentShown(proposal.proposalId, "banner");
        } else {
          delete state.consentBanners[proposal.proposalId];
          base.result = "failed"; base.detail = "banner injection did not confirm visibility";
          audit(base);
        }
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

// ------------------------------------------------------------ relay transport
// The relay WebSocket is owned by the offscreen document (see offscreen.js):
// Chrome suspends this worker and used to take the socket with it. The
// worker talks transport over runtime messages; enforcement never leaves
// this file — the offscreen document cannot approve, deny, or act.

function postToOffscreen(msg) {
  ensureOffscreenDocument(function () {
    chrome.runtime.sendMessage(msg).catch(function () { /* doc raced away */ });
  });
}

// (Re)post the desired connection: reads the CURRENT key from storage, so a
// rotation or a fresh document always pairs with the live key.
function postRelayConnect() {
  if (!state.relayUrl || state.sessionKilled || state.signInBlocked) return;
  chrome.storage.local.get([K.KEY], function (res) {
    var key = res[K.KEY];
    if (!key) {
      pushToPanel({ kind: "jbb.ui.status", connected: false, error: "no connector key — generate one first" });
      return;
    }
    postToOffscreen({ kind: "jbb.relay.connect", url: state.relayUrl, key: key });
  });
}

function onRelayState(connected) {
  var was = state.connected;
  state.connected = connected;
  if (connected) state.relayDownSince = null;
  else if (state.relayUrl && state.relayDownSince == null) state.relayDownSince = Date.now();
  if (was !== connected) pushToPanel({ kind: "jbb.ui.status", connected: connected });
  // A capture whose driver went away has no listener left — stop it.
  if (!connected && state.capture) stopCapture("driver disconnected");
}

// Watchdog (keepalive alarm): if the transport reports down — or goes
// silent — for more than 30s while a relay is configured, recreate the
// offscreen document. The new document says hello on load and the
// connection is re-posted; pendings are unaffected (they persist in
// storage and in this worker's map, and hydrate after any restart).
function relayWatchdog() {
  if (!state.relayUrl || state.sessionKilled) { state.relayDownSince = null; return; }
  var now = Date.now();
  var silent = !state.offscreenSeenAt || (now - state.offscreenSeenAt > 45000);
  if (state.connected && !silent) { state.relayDownSince = null; return; }
  if (state.relayDownSince == null) { state.relayDownSince = now; return; }
  if (now - state.relayDownSince > 30000) {
    state.relayDownSince = now; // don't thrash while it restarts
    audit({ site: "-", action: "relay transport", tier: "T0", result: "restarted",
            detail: "offscreen relay transport down >30s — recreating the offscreen document" });
    recreateOffscreenDocument();
  }
}

function recreateOffscreenDocument() {
  offscreenReady = false;
  var done = function () { ensureOffscreenDocument(function () {}); };
  if (chrome.offscreen && chrome.offscreen.closeDocument) {
    try { chrome.offscreen.closeDocument().then(done, done); return; }
    catch (e) { /* fall through */ }
  }
  done();
}

// Make sure the relay is up (and paired) before sending anything that must
// reach the driver — e.g. a consent grant after a worker restart.
function ensureRelayConnected(cb) {
  if (state.connected) { cb(); return; }
  if (!state.relayUrl || state.sessionKilled) { cb(); return; }
  connectRelay(state.relayUrl);
  var waited = 0;
  var iv = setInterval(function () {
    waited += 250;
    if (state.connected || waited >= 8000) {
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

// ---------------------------------------------------------------- session summary
//
// When a session ends (driver disconnect, session abort, kill switch, or
// the panel's End session button), the audit log is distilled into one
// plain-language summary: counts per action type and per site, plus
// everything that was denied or blocked. Built at most once per session
// window; stored on-machine (K.SUMMARY) so the panel can show it after
// the fact. Nothing here ever goes to the relay.
function summarySentence(s) {
  var t = s.byType || {};
  var parts = [];
  if (t.navigate) parts.push("opened " + t.navigate + " page" + (t.navigate === 1 ? "" : "s"));
  var clicks = (t.click || 0) + (t.clickAt || 0) + (t.clickSelector || 0);
  if (clicks) parts.push("clicked " + clicks + " time" + (clicks === 1 ? "" : "s"));
  if (t.type) parts.push("typed " + t.type + " time" + (t.type === 1 ? "" : "s"));
  if (t.scroll) parts.push("scrolled " + t.scroll + " time" + (t.scroll === 1 ? "" : "s"));
  if (t.key) parts.push("pressed keys " + t.key + " time" + (t.key === 1 ? "" : "s"));
  var head = parts.length
    ? "This session, Muse " + parts.join(", ") + "."
    : "This session, Muse took no actions.";
  if (s.denied.length) {
    head += " " + s.denied.length + " action" + (s.denied.length === 1 ? " was" : "s were") + " denied or blocked.";
  } else if (parts.length) {
    head += " Nothing was denied.";
  }
  return head;
}

function buildSessionSummary(done) {
  var since = state.sessionStartedAt;
  if (!since || state.summaryBuiltFor === since) { if (done) done(null); return; }
  state.summaryBuiltFor = since;
  chrome.storage.local.get([K.AUDIT], function (res) {
    var byType = {}, bySite = {}, denied = [], executed = 0;
    (res[K.AUDIT] || []).forEach(function (e) {
      if (!e.proposalId || e.ts < since) return;
      if (e.result === "executed") {
        executed++;
        var ty = e.type || "other";
        byType[ty] = (byType[ty] || 0) + 1;
        var h = hostOf(e.site || "") || e.site || "-";
        bySite[h] = (bySite[h] || 0) + 1;
      } else if (e.result === "denied" || e.result === "failed") {
        denied.push({ action: e.action || e.type || "action", site: e.site || "-",
                      via: e.via || null, detail: e.detail || null });
      }
    });
    var summary = { startedAt: since, endedAt: Date.now(), executed: executed,
                    byType: byType, bySite: bySite, denied: denied };
    summary.sentence = summarySentence(summary);
    state.lastSummary = summary;
    chrome.storage.local.set({ [K.SUMMARY]: summary });
    pushToPanel({ kind: "jbb.ui.sessionSummary", summary: summary });
    if (done) done(summary);
  });
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
  // 4b. STOPPING an audio capture is always allowed, in every mode:
  // ending a capture is the privacy-safe direction and must never wait
  // on a grant or a mode. (STARTING capture is T2 and gates normally.)
  if (proposal.type === "audioCapture" && proposal.capture && proposal.capture.action === "stop") {
    return { decision: "allow", via: "auto", reason: "stopping capture is always allowed" };
  }
  // 5. T3 ALWAYS confirms — in every mode, on every site. No exceptions.
  if (proposal.actionTier === "T3") {
    return { decision: "ask", reason: "sensitive action always asks" };
  }
  // 5b. Closing the tab the user is actively looking at ALWAYS confirms
  // too — resolveTabContext stamps _forceAsk from ground truth, and no
  // session grant or whitelist entry can cover it.
  if (proposal._forceAsk) {
    return { decision: "ask", reason: "closing the tab you're looking at always asks" };
  }
  // 6. "Always ask" mode: everything asks.
  if (state.mode === "always-ask") {
    return { decision: "ask" };
  }
  // 7. "Ask for some actions": a whitelist entry for this EXACT domain
  // covering this tier + action type acts freely. T3 already asked at
  // step 5 and whitelistCovers refuses T3 again — there is no auto-allow
  // path for T3 in any mode. Unknown sites ask.
  var wl = whitelistCovers(proposal, host);
  if (wl) return { decision: "allow", via: "whitelist", domain: wl.domain, reason: "allowed by whitelist: " + wl.domain };
  return { decision: "ask", reason: "site not yet approved" };
}

// ---------------------------------------------------------------- relay (transport client)
//
// The socket itself lives in the offscreen document (see the transport
// helpers above and offscreen.js). This worker only expresses intent —
// connect with the configured URL, disconnect, send — and consumes the
// forwarded protocol messages in handleRelayMessage. Generation guards
// and stale-socket races are gone by construction: there is exactly one
// socket and it is not ours.

function connectRelay(url) {
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
  state.relayUrl = url;
  saveSettings();
  postRelayConnect();
}

function disconnectRelay(reason) {
  state.connected = false;
  state.relayDownSince = null;
  // Don't create an offscreen document just to tell it to disconnect.
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    try {
      chrome.offscreen.hasDocument(function (has) {
        if (has) {
          chrome.runtime.sendMessage({ kind: "jbb.relay.disconnect" })
            .catch(function () {});
        }
      });
    } catch (e) { /* transport already gone */ }
  }
}

function sendToRelay(msg) {
  postToOffscreen({ kind: "jbb.relay.send", data: JSON.stringify(msg) });
}

function handleRelayMessage(raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || msg.v !== JBB.PROTOCOL_VERSION || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "pair.confirm":
      state.connected = true;
      state.relayDownSince = null;
      if (!state.sessionStartedAt) {
        // A fresh pairing opens a new session window for the summary;
        // the previous session's summary card is retired.
        state.sessionStartedAt = Date.now();
        state.summaryBuiltFor = 0;
        state.lastSummary = null;
        chrome.storage.local.remove([K.SUMMARY]);
      }
      pushToPanel({ kind: "jbb.ui.status", connected: true });
      audit({ site: "-", action: "session paired", tier: "T0", result: "allowed", detail: "protocol " + msg.v });
      break;
    case "pair.error":
      // The relay refused pairing (e.g. this key was rotated away). Surface
      // it — a silent lonely state would look like an outage.
      state.connected = false;
      pushToPanel({ kind: "jbb.ui.status", connected: false,
        error: "relay refused pairing: " + (msg.message || msg.error || "unknown") });
      audit({ site: "-", action: "session paired", tier: "T0", result: "denied",
              detail: "pair refused (" + (msg.error || "?") + ")" });
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
      observeActiveTab(false, { textOffset: msg.textOffset }).then(
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
      buildSessionSummary();
      state.sessionStartedAt = 0;
      pushToPanel({ kind: "jbb.ui.status", connected: false, error: abortReason });
      disconnectRelay("peer abort");
      break;
    }
    // observe.request is answered on demand; unknown types are ignored.
  }
}

// ---------------------------------------------------------------- proposal -> consent -> execute
function handleProposal(proposal, source) {
  proposal.proposalId = proposal.proposalId || nextProposalId();

  // Idempotency: the driver gives every act a unique id (adopted above as
  // proposalId). A re-sent act.propose with an id we already executed gets
  // the stored result resent — never a second execution, never a second
  // prompt. One still awaiting consent or mid-execution gets a fresh
  // receipt (and shown, if already shown) and is otherwise ignored.
  var priorResult = state.actResults.get(proposal.proposalId);
  if (priorResult) {
    sendToRelay(JBB.Message.proposalReceived(proposal.proposalId));
    sendToRelay(JBB.Message.actResult(proposal.proposalId, priorResult.ok, priorResult.detail));
    audit({ site: proposal.site || "-", action: proposal.description || proposal.type,
            tier: proposal.actionTier, result: "duplicate",
            detail: "duplicate act id — stored result resent, act NOT re-applied" });
    return;
  }
  if (state.pending.has(proposal.proposalId) || state.executing.has(proposal.proposalId) ||
      state.gating.has(proposal.proposalId)) {
    sendToRelay(JBB.Message.proposalReceived(proposal.proposalId));
    var existing = state.pending.get(proposal.proposalId);
    if (existing && existing.shown) {
      sendToRelay(JBB.Message.consentShown(proposal.proposalId, existing.shownVia));
    }
    return;
  }

  // Lifecycle ack: the proposal is in the gate now. Sent before the verdict
  // so the driver can distinguish "never arrived" (PEER_DOWN) from what
  // happens next.
  sendToRelay(JBB.Message.proposalReceived(proposal.proposalId));
  proposal.source = source;

  // LOCAL ENFORCEMENT: the gate runs before anything else.
  // Snapshot versioning: an act built against a snapshot whose version
  // has moved must never land on the wrong element. Stable ids make most
  // older acts safe, but when the caller declares a version and it no
  // longer matches, refuse BEFORE consent is even asked — the caller
  // re-observes and rebuilds. Acts without a version (older drivers)
  // proceed on stable-id + label verification alone.
  if (typeof proposal.snapshotVersion === "number" &&
      proposal.snapshotVersion !== state.snapshotVersion) {
    var staleDetail = "stale snapshot: act built against v" + proposal.snapshotVersion +
      ", current snapshot is v" + state.snapshotVersion + " — re-observe and rebuild the act";
    recordActResult(proposal.proposalId, false, staleDetail);
    sendToRelay(JBB.Message.actResult(proposal.proposalId, false, staleDetail,
      "STALE_SNAPSHOT", state.snapshotVersion));
    audit({ site: proposal.site || "-", action: proposal.description || proposal.type,
            tier: proposal.actionTier, result: "denied", detail: staleDetail,
            type: proposal.type, proposalId: proposal.proposalId, via: "blocked" });
    return;
  }

  // Tab actions resolve their ground-truth context (real site, active
  // flag) before the gate runs. The receipt already went out above; the
  // gating set keeps a duplicate from double-processing meanwhile.
  if (TAB_ACTIONS[proposal.type]) {
    state.gating.add(proposal.proposalId);
    resolveTabContext(proposal).then(function () {
      state.gating.delete(proposal.proposalId);
      proceedWithVerdict(proposal);
    }, function () {
      state.gating.delete(proposal.proposalId);
      proceedWithVerdict(proposal);
    });
    return;
  }
  proceedWithVerdict(proposal);
}

function proceedWithVerdict(proposal) {
  var verdict = decideAction(proposal);

  // Session grants layer on top of "ask": a live time-boxed grant auto-allows
  // T1/T2 on its site. T3 is NEVER covered — sensitive actions always ask.
  // Neither is a _forceAsk action (closing the tab the user is looking
  // at): decideAction asks, and no grant layer may turn that into allow.
  var viaSession = verdict.decision === "ask" &&
                   !proposal._forceAsk &&
                   !state.grantsPaused &&
                   proposal.actionTier !== "T3" &&
                   sessionAllows(proposal);

  // Remember HOW this action was (or will be) authorized — the audit
  // feed and the session summary speak in these terms.
  proposal._via = verdict.via === "whitelist" ? "whitelist"
    : viaSession ? "session"
    : verdict.decision === "allow" ? "auto"
    : verdict.decision === "deny" ? "blocked" : "consent";

  audit({
    site: proposal.site || "-",
    action: proposal.description || proposal.type,
    tier: proposal.actionTier || "?",
    result: verdict.decision === "deny" ? "denied" :
            (verdict.decision === "allow" || viaSession) ? "allowed" : "awaiting consent",
    detail: viaSession ? "session grant (" + sessionRemaining() + " left)" : (verdict.reason || null),
    type: proposal.type, proposalId: proposal.proposalId, via: proposal._via
  });

  if (verdict.decision === "deny") {
    sendToRelay(JBB.Message.consentDeny(proposal.proposalId, verdict.reason));
    sendToRelay(JBB.Message.actResult(proposal.proposalId, false, verdict.reason));
    return;
  }
  if (verdict.decision === "allow" || viaSession) {
    // Auto-allowed (whitelist or session grant): the driver still needs
    // the verdict — otherwise it waits for a consent message that never
    // comes. Whitelist hits stamp lastUsedAt so stale entries are visible.
    if (verdict.via === "whitelist") {
      proposal._whitelistDomain = verdict.domain;
      var wle = state.whitelist[verdict.domain];
      if (wle && Date.now() - (wle.lastUsedAt || 0) > 60e3) {
        wle.lastUsedAt = Date.now();
        saveWhitelist();
      }
    }
    var autoScope = viaSession ? "session" : (verdict.via === "whitelist" ? "site" : "once");
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
  var VALID_CHOICES = { "once": 1, "site": 1, "whitelist": 1, "session1h": 1, "session24h": 1, "session1w": 1, "sessionCustom": 1, "deny": 1 };
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
      detail: "user denied",
      type: proposal.type, proposalId: proposal.proposalId, via: "consent"
    });
    pushToPanel({ kind: "jbb.ui.consentResolved", proposalId: proposal.proposalId, choice: "deny" });
    playVerdictTone(false);
    return;
  }

  // "once", or a permanent per-site grant: "whitelist" (the card's
  // "Always allow on this site") and its legacy alias "site" both write a
  // whitelist entry for the EXACT tier being asked about — never a
  // blanket allow. grantWhitelist refuses T3 in code, so a critical
  // action answered this way executes once and persists nothing.
  if (answer.choice === "whitelist" || answer.choice === "site") {
    var host = hostOf(proposal.site || "");
    var entry = grantWhitelist(host, proposal.actionTier);
    if (entry) {
      // Request host permission on demand — the trust story in action.
      chrome.permissions.request({ origins: ["https://" + host + "/*", "http://" + host + "/*"] })
        .catch(function () {});
    }
  }

  // Time-boxed session grant: Muse may act on this site without per-action
  // prompts until the window lapses. T3 actions are still never covered.
  if (answer.choice === "session1h" || answer.choice === "session24h" ||
      answer.choice === "session1w" || answer.choice === "sessionCustom") {
    var shost = hostOf(proposal.site || "");
    var SPANS = { session1h: 3600e3, session24h: 86400e3, session1w: 604800e3 };
    var sexp = SPANS[answer.choice] ? Date.now() + SPANS[answer.choice]
                                    : Number(answer.expiresAt);
    // A custom "until" fails closed: it must be a real timestamp, at least a
    // minute in the future, and at most 31 days out — beyond that the user
    // should pick the explicit permanent site grant, not a giant window.
    if (!isFinite(sexp) || sexp <= Date.now() + 60e3 || sexp > Date.now() + 31 * 86400e3) {
      sendToRelay(JBB.Message.consentDeny(proposal.proposalId, "invalid custom grant expiry"));
      sendToRelay(JBB.Message.actResult(proposal.proposalId, false, "invalid custom grant expiry"));
      audit({
        site: proposal.site || "-",
        action: proposal.description || proposal.type,
        tier: proposal.actionTier,
        result: "denied",
        detail: "invalid custom grant expiry"
      });
      pushToPanel({ kind: "jbb.ui.consentResolved", proposalId: proposal.proposalId, choice: "deny" });
      return;
    }
    var slabels = { session1h: "1 hour", session24h: "24 hours", session1w: "1 week" };
    state.session = {
      site: shost,
      grantedAt: Date.now(),
      expiresAt: sexp,
      epoch: state.keyEpoch,
      label: slabels[answer.choice] || ("until " + new Date(sexp).toLocaleString())
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
  playVerdictTone(true);
  executeProposal(proposal);
}

// ------------------------------------------------------------ tab actions
// Window-level actions (T2). They execute here in the worker via the
// tabs API — no content script — but pass the SAME consent gate as page
// actions: handleProposal resolves each proposal's real site first
// (resolveTabContext), and decideAction sees a normal proposal.
var TAB_ACTIONS = { listTabs: 1, switchTab: 1, closeTab: 1, closeInactiveTabs: 1, openTab: 1, pinTab: 1 };

function tabSummary(t) {
  return { id: t.id, title: t.title || "", url: t.url || "",
           audible: !!t.audible, active: !!t.active, pinned: !!t.pinned, windowId: t.windowId };
}

// Ground truth before the gate: the whitelist and the audit key off the
// tab's REAL url, not the driver-supplied site; and closing the tab the
// user is looking at forces a prompt no matter what grants exist.
function resolveTabContext(proposal) {
  if (proposal.type === "openTab") {
    if (proposal.url) proposal.site = proposal.url;
    return Promise.resolve();
  }
  if (proposal.type === "switchTab" || proposal.type === "closeTab" || proposal.type === "pinTab") {
    if (typeof proposal.tabId !== "number") return Promise.resolve(); // execution refuses cleanly
    return chrome.tabs.get(proposal.tabId).then(function (tab) {
      if (tab) {
        proposal.site = tab.url || proposal.site || "";
        proposal._tabActive = !!tab.active;
        if (proposal.type === "closeTab" && tab.active) proposal._forceAsk = true;
      }
    }, function () { /* tab already gone — execution reports it */ });
  }
  // listTabs / closeInactiveTabs span sites; their audit site is the
  // tab the user is on right now.
  return getActiveTab().then(function (tab) {
    if (tab && tab.url) proposal.site = tab.url;
  }, function () {});
}

function refreshTabsCache() {
  if (!chrome.tabs || !chrome.tabs.query) return;
  chrome.tabs.query({}).then(function (tabs) {
    state.tabsCache = tabs.map(tabSummary);
    pushToPanel({ kind: "jbb.ui.tabsChanged" });
  }, function () {});
}
if (chrome.tabs) {
  ["onCreated", "onRemoved", "onUpdated", "onActivated"].forEach(function (ev) {
    if (chrome.tabs[ev] && chrome.tabs[ev].addListener) {
      chrome.tabs[ev].addListener(function () { refreshTabsCache(); });
    }
  });
  // Capture follows its tab: navigating the captured tab to a DIFFERENT
  // site ends the capture (consent was per-site), and a finished load
  // re-asserts the indicator (the new page's content script is fresh).
  if (chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener) {
    chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
      if (!state.capture || tabId !== state.capture.tabId) return;
      if (changeInfo.url && hostOf(changeInfo.url) !== state.capture.host) {
        stopCapture("the captured tab navigated to a different site");
      } else if (changeInfo.status === "complete") {
        setCaptureIndicator(tabId, true);
      }
    });
  }
  if (chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener) {
    chrome.tabs.onRemoved.addListener(function (tabId) {
      if (state.capture && tabId === state.capture.tabId) stopCapture("the captured tab was closed");
    });
  }
}

function closeInactiveTabsNow() {
  return chrome.tabs.query({}).then(function (tabs) {
    var victims = tabs.filter(function (t) { return !t.active && !t.pinned && !t.audible; });
    if (!victims.length) return { closed: [], kept: tabs.length };
    return chrome.tabs.remove(victims.map(function (t) { return t.id; })).then(function () {
      return { closed: victims.map(tabSummary), kept: tabs.length - victims.length };
    });
  });
}

function executeTabAction(proposal) {
  switch (proposal.type) {
    case "listTabs":
      return chrome.tabs.query({}).then(function (tabs) {
        var list = tabs.map(tabSummary);
        return { detail: list.length + (list.length === 1 ? " tab open" : " tabs open"),
                 data: { tabs: list } };
      });
    case "switchTab": {
      if (typeof proposal.tabId !== "number") {
        return Promise.reject(new Error("switchTab needs a tab id (run listTabs first)"));
      }
      return chrome.tabs.get(proposal.tabId).then(function (tab) {
        return chrome.windows.update(tab.windowId, { focused: true })
          .then(function () { return chrome.tabs.update(tab.id, { active: true }); })
          .then(function () { return { detail: "switched to '" + (tab.title || tab.url) + "'" }; });
      });
    }
    case "closeTab": {
      if (typeof proposal.tabId !== "number") {
        return Promise.reject(new Error("closeTab needs a tab id (run listTabs first)"));
      }
      return chrome.tabs.get(proposal.tabId).then(function (tab) {
        return chrome.tabs.query({ windowId: tab.windowId }).then(function (inWindow) {
          if (inWindow.length <= 1) {
            throw new Error("refusing to close the last tab in its window");
          }
          if (tab.active && !proposal._forceAsk) {
            // It was background when granted (maybe auto-allowed) and the
            // user has since started looking at it. No prompt covered
            // THIS state — fail safe and let the caller re-propose,
            // which will force a prompt.
            throw new Error("that tab is now the one you're looking at — not closing it without a fresh prompt");
          }
          return chrome.tabs.remove(tab.id).then(function () {
            return { detail: "closed '" + (tab.title || tab.url) + "'" };
          });
        });
      });
    }
    case "closeInactiveTabs":
      return closeInactiveTabsNow().then(function (r) {
        return { detail: "closed " + r.closed.length + " inactive tab(s); kept " + r.kept +
                 " (active, pinned, or playing audio)", data: r };
      });
    case "openTab": {
      if (!proposal.url) return Promise.reject(new Error("openTab needs a URL"));
      return chrome.tabs.create({ url: proposal.url, active: false }).then(function (tab) {
        return { detail: "opened " + proposal.url + " in a new tab (id " + tab.id + ")",
                 data: { tab: tabSummary(tab) } };
      });
    }
    case "pinTab": {
      if (typeof proposal.tabId !== "number") {
        return Promise.reject(new Error("pinTab needs a tab id (run listTabs first)"));
      }
      return chrome.tabs.get(proposal.tabId).then(function (tab) {
        return chrome.tabs.update(tab.id, { pinned: true }).then(function () {
          return { detail: "pinned '" + (tab.title || tab.url) + "'" };
        });
      });
    }
  }
  return Promise.reject(new Error("unknown tab action: " + proposal.type));
}

// ---------------------------------------------------------------- audio capture
// Tab audio capture (T2). The chain of custody is deliberate:
//   consent (gate) → the tabCapture OPTIONAL permission, which only the
//   user can grant, from the side panel, in plain language → a stream
//   id for the ACTIVE tab → the offscreen document records and chunks
//   → chunks relay live to the driver. Nothing is stored anywhere.
// The captured tab shows an on-page indicator the whole time (plus
// Chrome's own capture icon), the panel shows it too, and capture
// stops on: agent stop, panel stop, the indicator's own Stop button,
// tab navigation to another site, driver disconnect, or the capture
// engine dying. Per-tab and per-site by construction: one capture,
// bound to the tab + host it was consented for.
function refreshCapturePermission() {
  return new Promise(function (resolve) {
    var done = false;
    function fin(has) {
      if (done) return;
      done = true;
      state.capturePermission = !!has;
      resolve(state.capturePermission);
    }
    try {
      var ret = chrome.permissions.contains({ permissions: ["tabCapture"] }, function (has) {
        fin(has && !chrome.runtime.lastError);
      });
      if (ret && typeof ret.then === "function") ret.then(function (has) { fin(has); }, function () { fin(false); });
    } catch (e) { fin(false); }
  });
}

function getCaptureStreamId(tabId) {
  return new Promise(function (resolve, reject) {
    var done = false;
    function ok(id) { if (!done) { done = true; id ? resolve(id) : reject(new Error("Chrome did not hand over a capture stream for this tab")); } }
    function fail(e) { if (!done) { done = true; reject(e instanceof Error ? e : new Error(String((e && e.message) || e))); } }
    try {
      var ret = chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, function (id) {
        if (chrome.runtime.lastError) fail(new Error(chrome.runtime.lastError.message));
        else ok(id);
      });
      if (ret && typeof ret.then === "function") ret.then(ok, fail);
    } catch (e) { fail(e); }
  });
}

function setCaptureIndicator(tabId, active) {
  try {
    var p = chrome.tabs.sendMessage(tabId, { kind: "jbb.capture.indicator", active: !!active });
    if (p && typeof p.catch === "function") p.catch(function () {});
  } catch (e) { /* no content script there — Chrome's own capture icon still shows */ }
}

function stopCapture(reason) {
  postToOffscreen({ kind: "jbb.capture.stop" });
  if (!state.capture) return;
  var cap = state.capture;
  state.capture = null;
  setCaptureIndicator(cap.tabId, false);
  pushToPanel({ kind: "jbb.ui.captureChanged" });
  audit({ site: cap.host, action: "audio capture stopped", tier: "T0",
          result: "executed", detail: reason || "stopped" });
}

function waitCaptureActive(captureId, streamId) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      state.captureWaiter = null;
      reject(new Error("the capture engine did not start in time — Chrome may require the captured tab to be the active one"));
    }, 6000);
    state.captureWaiter = {
      captureId: captureId,
      resolve: function () { clearTimeout(timer); state.captureWaiter = null; resolve(); },
      reject: function (e) { clearTimeout(timer); state.captureWaiter = null; reject(e); }
    };
    postToOffscreen({ kind: "jbb.capture.start", streamId: streamId, captureId: captureId });
  });
}

function executeAudioCapture(proposal) {
  var action = (proposal.capture && proposal.capture.action) || "start";
  if (action === "stop") {
    if (!state.capture) return Promise.resolve({ detail: "audio capture was not running" });
    var wasHost = state.capture.host;
    stopCapture("agent request");
    return Promise.resolve({ detail: "audio capture stopped (was listening to " + wasHost + ")" });
  }
  if (state.capture) {
    return Promise.reject(new Error("audio capture is already running on " + state.capture.host + " — stop it before starting another"));
  }
  return refreshCapturePermission().then(function (granted) {
    if (!granted) {
      throw new Error("audio capture is not enabled yet: the tabCapture permission is granted only by the user, from the side panel — Session tab → Audio capture → Enable. Nothing was captured.");
    }
    return getActiveTab();
  }).then(function (tab) {
    if (!tab || tab.id == null) throw new Error("no active tab to capture");
    var host = hostOf(tab.url || "");
    return getCaptureStreamId(tab.id).then(function (streamId) {
      var captureId = "cap-" + Date.now().toString(36);
      return waitCaptureActive(captureId, streamId).then(function () {
        state.capture = { tabId: tab.id, host: host, captureId: captureId, startedAt: Date.now() };
        setCaptureIndicator(tab.id, true);
        pushToPanel({ kind: "jbb.ui.captureChanged" });
        return {
          detail: "listening to " + (host || "this tab") + " — audio streams to the driver in chunks; nothing is stored",
          data: { captureId: captureId, site: host }
        };
      });
    });
  });
}

function executeProposal(proposal) {
  state.executing.add(proposal.proposalId);
  var run = proposal.type === "audioCapture" ? executeAudioCapture(proposal)
          : TAB_ACTIONS[proposal.type] ? executeTabAction(proposal) : runOnPage(proposal);
  run.then(
    function (out) {
      var detail = (out && out.detail) || "";
      state.executing.delete(proposal.proposalId);
      recordActResult(proposal.proposalId, true, detail);
      // An applied act may have changed the page: the snapshot version
      // moves, so further acts built against the old version refuse
      // instead of guessing. The new version rides the result so a
      // caller chaining deliberately can declare it on the next act.
      // matchQuality (exact/fuzzy) rides along when a label resolved the
      // target, so the caller can see how its target was found.
      state.snapshotVersion++;
      sendToRelay(JBB.Message.actResult(proposal.proposalId, true, detail,
        null, state.snapshotVersion, out && out.matchQuality, out && out.data));
      audit({
        site: proposal.site || "-",
        action: proposal.description || proposal.type,
        tier: proposal.actionTier,
        result: "executed",
        detail: detail + (proposal._whitelistDomain ? " [allowed by whitelist: " + proposal._whitelistDomain + "]" : ""),
        type: proposal.type, proposalId: proposal.proposalId, via: proposal._via || "consent"
      });
    },
    function (err) {
      state.executing.delete(proposal.proposalId);
      recordActResult(proposal.proposalId, false, String(err));
      sendToRelay(JBB.Message.actResult(proposal.proposalId, false, String(err)));
      audit({
        site: proposal.site || "-",
        action: proposal.description || proposal.type,
        tier: proposal.actionTier,
        result: "failed",
        detail: String(err),
        type: proposal.type, proposalId: proposal.proposalId, via: proposal._via || "consent"
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
        return { detail: "navigated to " + proposal.url };
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
      target: { tabId: tab.id, allFrames: true },
      files: ["protocol.js", "content.js"]
    }).then(function () {
      // navigate is handled by the background (tabs API), not the page.
      if (proposal.type === "navigate" && proposal.url) {
        return chrome.tabs.update(tab.id, { url: proposal.url }).then(function () {
          return { detail: "navigated to " + proposal.url };
        });
      }
      // A ref of the form "f<frameId>:e<n>" (produced by observe for elements
      // inside an iframe, e.g. a course player) routes the action to that
      // frame with its local ref; plain refs go to the top frame as before.
      var routed = routeFrameRef(proposal);
      var msg = { kind: "jbb.content.act", action: routed.proposal };
      var send = routed.frameId != null
        ? chrome.tabs.sendMessage(tab.id, msg, { frameId: routed.frameId })
        : chrome.tabs.sendMessage(tab.id, msg);
      return send.then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || "content script error");
        return { detail: res.detail, matchQuality: res.matchQuality, appeared: res.appeared, data: res.data };
      });
    });
  });
}

// Split a frame-prefixed ref ("f12:e3") into { frameId, local-proposal }.
// Returns the proposal untouched when the ref carries no frame prefix.
function routeFrameRef(proposal) {
  var target = (proposal && proposal.target) || {};
  var m = /^f(\d+):(.+)$/.exec(target.ref || "");
  if (!m) return { frameId: null, proposal: proposal };
  var clone = {};
  for (var k in proposal) clone[k] = proposal[k];
  clone.target = {};
  for (var k2 in target) clone.target[k2] = target[k2];
  clone.target.ref = m[2];
  return { frameId: parseInt(m[1], 10), proposal: clone };
}

// Serialized into every frame via chrome.scripting.executeScript — must stay
// fully self-contained. The content script shares this isolated world and
// exposes window.__jbbBuildSnapshot; frames where injection is impossible
// (or an older content script is still resident) return null and are skipped.
function jbbSnapshotInFrame(opts) {
  try {
    return window.__jbbBuildSnapshot ? window.__jbbBuildSnapshot(opts || {}) : null;
  } catch (e) {
    return null;
  }
}

// Total readable-text budget across all merged frames. Per-frame text is
// already capped in the content script; this keeps a page with many frames
// (LMS players, embedded widgets) comfortably under the relay's 1 MB limit.
var JBB_TOTAL_TEXT_CAP = 60000;

function prefixFrameRefs(snap, frameId) {
  if (!snap || !snap.interactives) return;
  snap.interactives.forEach(function (it) {
    it.ref = "f" + frameId + ":" + it.ref;
  });
}

function finishObserve(tab, snap, withScreenshot) {
  // Snapshot versioning: every observe response carries a fresh,
  // monotonically increasing version (on the message AND inside the
  // snapshot). Acts declare the version they were built against; a moved
  // version means the caller's view is outdated and the act is refused.
  state.snapshotVersion++;
  var v = state.snapshotVersion;
  if (snap) snap.snapshotVersion = v;
  var wrap = function (msg) { msg.snapshotVersion = v; return msg; };
  if (!withScreenshot) return wrap(JBB.Message.observeResult(snap, null));
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
    .catch(function () { return null; })
    .then(function (dataUrl) {
      return wrap(JBB.Message.observeResult(snap, dataUrl));
    });
}

function observeActiveTab(withScreenshot, observeOpts) {
  observeOpts = observeOpts || {};
  return getActiveTab().then(function (tab) {
    if (!tab || !tab.id) throw new Error("no active tab");
    return chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["protocol.js", "content.js"]
    }).then(function () {
      return chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: jbbSnapshotInFrame,
        args: [observeOpts]
      }).catch(function () { return null; });
    }).then(function (results) {
      var frames = [];
      (results || []).forEach(function (r) {
        if (r && r.result) frames.push({ frameId: r.frameId, snapshot: r.result });
      });
      if (!frames.length) {
        // Fallback: a content script from an older build may still be the
        // resident one in this tab (it has no __jbbBuildSnapshot). Its
        // message-based observe still answers — top frame only.
        return chrome.tabs.sendMessage(tab.id, { kind: "jbb.content.observe", textOffset: observeOpts.textOffset })
          .then(function (res) {
            if (!res || !res.ok) throw new Error("observe failed");
            return finishObserve(tab, res.snapshot, withScreenshot);
          });
      }
      var top = null;
      frames.forEach(function (f) { if (f.frameId === 0) top = f; });
      if (!top) top = frames[0];
      var snap = top.snapshot;
      var totalText = (snap.text || "").length;
      var others = [];
      frames.forEach(function (f) {
        if (f === top) return;
        var s = f.snapshot;
        s.frameId = f.frameId;
        prefixFrameRefs(s, f.frameId);
        if (s.text && totalText + s.text.length > JBB_TOTAL_TEXT_CAP) {
          s.text = s.text.slice(0, Math.max(0, JBB_TOTAL_TEXT_CAP - totalText));
          s.textTruncated = true;
        }
        totalText += (s.text || "").length;
        others.push(s);
      });
      if (others.length) snap.frames = others;
      return finishObserve(tab, snap, withScreenshot);
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
  buildSessionSummary();
  state.sessionStartedAt = 0;
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
      (msg.kind.indexOf("jbb.ui.") !== 0 && msg.kind !== "jbb.banner.decision" &&
       msg.kind.indexOf("jbb.offscreen.") !== 0 && msg.kind.indexOf("jbb.relay.") !== 0 &&
       msg.kind !== "jbb.media.progress" && msg.kind.indexOf("jbb.capture.") !== 0)) {
    return false;
  }
  // Audio capture plumbing. Chunks and engine state are accepted ONLY
  // from the offscreen document (same sender rule as the relay
  // transport — a page must never be able to inject fake audio or fake
  // a capture state). The stop request comes from the captured tab's
  // own on-page indicator.
  if (msg.kind.indexOf("jbb.capture.") === 0) {
    var fromOffscreen = !!(sender && sender.url && sender.url.indexOf("offscreen.html") !== -1);
    if (msg.kind === "jbb.capture.chunk") {
      if (!fromOffscreen) return false;
      if (state.capture && msg.captureId === state.capture.captureId &&
          state.connected && !state.sessionKilled) {
        sendToRelay(JBB.Message.audioChunk({
          captureId: msg.captureId, seq: msg.seq, mimeType: msg.mimeType, data: msg.data
        }));
      }
      return false;
    }
    if (msg.kind === "jbb.capture.state") {
      if (!fromOffscreen) return false;
      if (state.captureWaiter && msg.captureId === state.captureWaiter.captureId) {
        if (msg.active) state.captureWaiter.resolve();
        else state.captureWaiter.reject(new Error(msg.error || "the capture engine refused to start"));
      } else if (!msg.active && state.capture && msg.captureId === state.capture.captureId) {
        stopCapture("capture engine stopped");
      }
      return false;
    }
    if (msg.kind === "jbb.capture.stopRequest") {
      if (sender && sender.tab && state.capture && sender.tab.id === state.capture.tabId) {
        stopCapture("stopped from the on-page indicator");
      }
      return false;
    }
    return false;
  }
  // Media progress from content scripts: relayed live to the driver,
  // never stored. Only real tab senders count.
  if (msg.kind === "jbb.media.progress") {
    if (!sender || !sender.tab) return false;
    if (state.connected && !state.sessionKilled) {
      sendToRelay(JBB.Message.mediaProgress({
        tabId: sender.tab.id, title: msg.title, url: msg.url, event: msg.event,
        currentTime: msg.currentTime, duration: msg.duration,
        paused: msg.paused, ended: msg.ended
      }));
    }
    return false;
  }
  // Relay transport signals — accepted ONLY from the offscreen document.
  // Anything else claiming to be transport (a page, the panel, a content
  // script) is ignored: forged relay messages would be an injection path
  // straight into handleRelayMessage.
  if (msg.kind.indexOf("jbb.relay.") === 0) {
    if (!sender || !sender.url || sender.url.indexOf("offscreen.html") === -1) return false;
    state.offscreenSeenAt = Date.now();
    if (msg.kind === "jbb.relay.message") handleRelayMessage(msg.data);
    else if (msg.kind === "jbb.relay.state") onRelayState(!!msg.connected);
    else if (msg.kind === "jbb.relay.hello") {
      if (state.relayUrl && !state.sessionKilled && !state.signInBlocked) postRelayConnect();
    }
    return false;
  }
  // Offscreen page signals (no response needed).
  if (msg.kind === "jbb.offscreen.ready") { onOffscreenReady(); return false; }
  if (msg.kind === "jbb.offscreen.report") {
    audit({ site: "-", action: "consent tone", tier: "T0",
            result: msg.status === "played" ? "played" : "failed",
            detail: "offscreen player reports: " + (msg.status || "unknown") });
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
          whitelist: state.whitelist,
          whitelistSchema: WHITELIST_SCHEMA,
          grantsPaused: state.grantsPaused,
          lastSummary: state.lastSummary,
          tabs: state.tabsCache || [],
          capture: state.capture ? { active: true, host: state.capture.host, tabId: state.capture.tabId,
                                     startedAt: state.capture.startedAt } : { active: false },
          capturePermission: !!state.capturePermission,
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
      buildSessionSummary();
      state.sessionStartedAt = 0;
      disconnectRelay("user disconnect");
      pushToPanel({ kind: "jbb.ui.status", connected: false });
      done();
      break;

    case "jbb.ui.closeInactiveTabs":
      // The user clicking in their own panel IS the consent — this is
      // their control surface, not an agent action. Same guarded
      // implementation the agent's proposals use.
      closeInactiveTabsNow().then(function (r) {
        audit({ site: "-", action: "close inactive tabs (from the panel)", tier: "T2",
                result: "executed",
                detail: "closed " + r.closed.length + " inactive tab(s); kept " + r.kept });
        refreshTabsCache();
        done({ ok: true, closed: r.closed.length, kept: r.kept });
      }, function (err) { done({ ok: false, error: String(err) }); });
      return true;
    case "jbb.ui.stopCapture":
      stopCapture("stopped from the side panel");
      done({ ok: true });
      return true;

    case "jbb.ui.capturePermissionChanged":
      refreshCapturePermission().then(function (granted) {
        if (!granted && state.capture) stopCapture("capture permission revoked");
        pushToPanel({ kind: "jbb.ui.captureChanged" });
        done({ ok: true, granted: granted });
      });
      return true;

    case "jbb.ui.endSession":
      // The user's deliberate end: summarize first, then disconnect.
      // (Unlike the kill switch this does not block reconnection.)
      buildSessionSummary(function (summary) {
        state.sessionStartedAt = 0;
        disconnectRelay("user ended session");
        pushToPanel({ kind: "jbb.ui.status", connected: false });
        done({ ok: true, summary: summary });
      });
      return true;

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

    case "jbb.ui.consentShown":
      // The panel rendered the consent card — the prompt is actually
      // visible. This is one of only two paths allowed to mark it shown.
      markConsentShown(msg.proposalId, "panel");
      done();
      break;

    case "jbb.ui.rotateKey":
      // One click: new key (returned once, for the reveal), old key revoked
      // at the relay, driver disconnected, every grant invalidated.
      rotateConnectorKey(function (newKey) { done({ newKey: newKey }); });
      return true; // async

    case "jbb.ui.consent":
      // The worker may have restarted since the card was shown — recover the
      // proposal from storage, make sure the relay is up, then resolve.
      hydratePendings(function () {
        ensureRelayConnected(function () {
          var p = state.pending.get(msg.proposalId);
          if (p) {
            p.resolve({ choice: msg.choice, reason: msg.reason, expiresAt: msg.expiresAt });
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
        if (state.whitelist[msg.host]) { delete state.whitelist[msg.host]; saveWhitelist(); }
        saveSettings();
        chrome.permissions.remove({ origins: ["https://" + msg.host + "/*", "http://" + msg.host + "/*"] })
          .catch(function () {});
        pushToPanel({ kind: "jbb.ui.sitesChanged" });
      }
      done();
      break;

    // ------------------------------------------------ whitelist manager
    // The manager is the USER's control surface: it works entirely
    // through panel messages, no driver connection needed, and every
    // change lands in state immediately (revoke/pause bite mid-session,
    // on the very next proposal).
    case "jbb.ui.addWhitelist": {
      var domain = normalizeDomain(msg.domain || msg.host || "");
      if (!domain) { done({ ok: false, error: "that does not look like a domain" }); break; }
      if (looksPunycode(domain) && !msg.confirmed) {
        // Punycode (xn--) domains are the classic lookalike vector: make
        // the user confirm they mean THIS domain before it takes effect.
        done({ ok: false, warning: "punycode", domain: domain });
        break;
      }
      var added = addWhitelistEntry(domain, msg.tiers);
      audit({ site: domain, action: "whitelist entry added", tier: added.tiers.join("+"),
              result: "allowed", detail: "added from the whitelist manager" });
      done({ ok: true, entry: added });
      break;
    }

    case "jbb.ui.updateWhitelist": {
      var uEntry = state.whitelist[msg.domain];
      if (!uEntry) { done({ ok: false, error: "no such entry" }); break; }
      // Sanitize: tiers can only ever be T1/T2, actions only known types.
      // Anything else the UI sends is dropped, never stored.
      uEntry.tiers = (Array.isArray(msg.tiers) ? msg.tiers : uEntry.tiers)
        .filter(function (t) { return t === "T1" || t === "T2"; });
      uEntry.actions = (Array.isArray(msg.actions) ? msg.actions : uEntry.actions)
        .filter(function (a) { return WHITELIST_ACTIONS_V1.indexOf(a) !== -1; });
      saveWhitelist();
      pushToPanel({ kind: "jbb.ui.sitesChanged" });
      done({ ok: true, entry: uEntry });
      break;
    }

    case "jbb.ui.keepWhitelist": {
      // Review "Keep": re-confirm the entry. The 30-day clock restarts,
      // the schema is upgraded to current, and the action list extends
      // to the current vocabulary — re-confirming is exactly the moment
      // the user accepts coverage of action types added since the grant.
      var kEntry = state.whitelist[msg.domain];
      if (!kEntry) { done({ ok: false, error: "no such entry" }); break; }
      kEntry.reviewedAt = Date.now();
      kEntry.schemaVersion = WHITELIST_SCHEMA;
      WHITELIST_ACTIONS_V1.forEach(function (a) {
        if (kEntry.actions.indexOf(a) === -1) kEntry.actions.push(a);
      });
      saveWhitelist();
      pushToPanel({ kind: "jbb.ui.sitesChanged" });
      done({ ok: true, entry: kEntry });
      break;
    }

    case "jbb.ui.revokeAllWhitelist":
      state.whitelist = {};
      chrome.storage.local.remove([K.WHITELIST]);
      audit({ site: "-", action: "whitelist: revoke all", tier: "-",
              result: "executed", detail: "all whitelist entries removed from the manager" });
      pushToPanel({ kind: "jbb.ui.sitesChanged" });
      done({ ok: true });
      break;

    case "jbb.ui.setGrantsPaused":
      state.grantsPaused = !!msg.paused;
      saveSettings();
      audit({ site: "-", action: state.grantsPaused ? "grants paused" : "grants resumed", tier: "-",
              result: "executed", detail: "master switch in the whitelist manager" });
      pushToPanel({ kind: "jbb.ui.status", connected: state.connected });
      done({ ok: true, grantsPaused: state.grantsPaused });
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
