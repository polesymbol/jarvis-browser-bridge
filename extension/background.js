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
  PENDING: "jbb.pending"       // { proposalId: { proposal, createdAt } } — survives worker restarts
};

var AUDIT_CAP = 500;
var CONSENT_TIMEOUT_MS = 120000;

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
  consentNotifs: {}            // notificationId -> proposalId (universal prompt)
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
});

chrome.runtime.onStartup.addListener(function () { loadPersisted(); hydratePendings(); });

// Fires every ~30s, even after the worker was suspended and restarted.
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (!alarm || alarm.name !== "jbb-keepalive") return;
  hydratePendings();
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

function loadPersisted() {
  chrome.storage.local.get([K.SETTINGS, K.SITES], function (res) {
    var s = res[K.SETTINGS] || {};
    state.mode = s.mode || "ask-some";
    state.relayUrl = s.relayUrl || "";
    state.sites = res[K.SITES] || {};
    state.sessionKilled = !!s.killed;
  });
}

function saveSettings() {
  chrome.storage.local.set({
    [K.SETTINGS]: { mode: state.mode, relayUrl: state.relayUrl, killed: state.sessionKilled },
    [K.SITES]: state.sites
  });
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
      // Idempotent: the card and the notification are two paths to one
      // decision — the first one wins, the second is a no-op.
      if (!state.pending.has(proposal.proposalId)) return;
      clearTimeout(timer);
      state.pending.delete(proposal.proposalId);
      unpersistPending(proposal.proposalId);
      clearConsentPrompt(proposal.proposalId);
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

function notifyConsent(proposal) {
  var notifId = "jbb-consent-" + proposal.proposalId;
  state.consentNotifs[notifId] = proposal.proposalId;
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
    if (chrome.runtime.lastError) delete state.consentNotifs[notifId];
  });
  chrome.action.setBadgeText({ text: "?" });
  chrome.action.setBadgeBackgroundColor({ color: "#E8710A" });
}

function clearConsentPrompt(proposalId) {
  Object.keys(state.consentNotifs).forEach(function (notifId) {
    if (state.consentNotifs[notifId] === proposalId) {
      delete state.consentNotifs[notifId];
      chrome.notifications.clear(notifId);
    }
  });
  if (Object.keys(state.consentNotifs).length === 0) {
    chrome.action.setBadgeText({ text: "" });
  }
}

function decideFromNotification(proposalId, choice, reason) {
  var entry = state.pending.get(proposalId);
  if (entry) entry.resolve({ choice: choice, reason: reason });
  else clearConsentPrompt(proposalId); // already decided elsewhere
}

chrome.notifications.onButtonClicked.addListener(function (notifId, btnIdx) {
  var proposalId = state.consentNotifs[notifId];
  if (!proposalId) return;
  if (btnIdx === 0) decideFromNotification(proposalId, "once");
  else decideFromNotification(proposalId, "deny", "denied from notification");
});

chrome.notifications.onClosed.addListener(function (notifId, byUser) {
  var proposalId = state.consentNotifs[notifId];
  if (!proposalId) return;
  // Dismissed without a decision: fail closed.
  decideFromNotification(proposalId, "deny", "notification dismissed");
});

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
    case "session.abort":
      killSession("relay requested abort: " + (msg.reason || "no reason"));
      break;
    // observe.request is answered on demand; unknown types are ignored.
  }
}

// ---------------------------------------------------------------- proposal -> consent -> execute
function handleProposal(proposal, source) {
  proposal.proposalId = proposal.proposalId || nextProposalId();
  proposal.source = source;

  // LOCAL ENFORCEMENT: the gate runs before anything else.
  var verdict = decideAction(proposal);

  audit({
    site: proposal.site || "-",
    action: proposal.description || proposal.type,
    tier: proposal.actionTier || "?",
    result: verdict.decision === "allow" ? "allowed" : verdict.decision === "deny" ? "denied" : "awaiting consent",
    detail: verdict.reason || null
  });

  if (verdict.decision === "deny") {
    sendToRelay(JBB.Message.consentDeny(proposal.proposalId, verdict.reason));
    sendToRelay(JBB.Message.actResult(proposal.proposalId, false, verdict.reason));
    return;
  }
  if (verdict.decision === "allow") {
    // Auto-allowed (e.g. trusted site): the driver still needs the verdict —
    // otherwise it waits for a consent message that never comes.
    var autoScope = (function () {
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
}

function resolveConsent(proposal, answer) {
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
    if (/^chrome:|^edge:|^about:/.test(tab.url || "")) {
      throw new Error("cannot act on browser-internal pages");
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
  if (!msg || typeof msg.kind !== "string" || msg.kind.indexOf("jbb.ui.") !== 0) {
    return false;
  }
  var done = function (payload) { sendResponse(Object.assign({ ok: true }, payload || {})); };

  switch (msg.kind) {
    case "jbb.ui.getState":
      chrome.storage.local.get([K.AUDIT], function (res) {
        done({
          connected: state.connected,
          mockMode: !state.relayUrl,
          relayUrl: state.relayUrl,
          mode: state.mode,
          sites: state.sites,
          killed: state.sessionKilled,
          pending: Array.from(state.pending.values()).map(function (p) { return p.proposal; }),
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

    case "jbb.ui.setRelayUrl":
      state.relayUrl = (msg.url || "").trim();
      saveSettings();
      done({ mockMode: !state.relayUrl });
      break;

    case "jbb.ui.connect":
      if (state.relayUrl) { state.sessionKilled = false; connectRelay(state.relayUrl); }
      done();
      break;

    case "jbb.ui.disconnect":
      disconnectRelay("user disconnect");
      pushToPanel({ kind: "jbb.ui.status", connected: false });
      done();
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
