/**
 * Jarvis Browser Bridge — side panel UI
 *
 * Renders: connection status, permission mode, connector key management,
 * consent cards, kill switch, per-site permissions, audit log.
 *
 * PRIVACY: in mock mode (no relay URL) nothing leaves this machine.
 * The connector key is generated with crypto.getRandomValues, stored in
 * chrome.storage.local, and displayed ONCE — the API-key model.
 */
"use strict";

/* global JBB */

var K = {
  KEY: "jbb.connectorKey",
  KEY_ACKED: "jbb.keyAcked" // true once the user confirmed they saved the key
};

var el = function (id) { return document.getElementById(id); };

function api(msg) {
  return chrome.runtime.sendMessage(msg);
}

function toast(text) {
  var t = el("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(function () { t.classList.add("hidden"); }, 2600);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return url || "-"; }
}

// ---------------------------------------------------------------- connector key
function generateKey() {
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  var hex = Array.prototype.map.call(bytes, function (b) {
    return ("0" + b.toString(16)).slice(-2);
  }).join("");
  return "jbb_" + hex;
}

function maskKey(key) {
  return key.slice(0, 4) + "…" + key.slice(-4);
}

function refreshKeyUI() {
  chrome.storage.local.get([K.KEY, K.KEY_ACKED], function (res) {
    var key = res[K.KEY];
    var acked = res[K.KEY_ACKED];
    el("keyNone").classList.toggle("hidden", !!key);
    el("keyReveal").classList.toggle("hidden", !(key && !acked));
    el("keyMasked").classList.toggle("hidden", !(key && acked));
    if (key && !acked) el("keyValue").textContent = key;
    if (key && acked) el("keyMaskedValue").textContent = maskKey(key);
  });
}

function setKey(key, showOnce) {
  var patch = {};
  patch[K.KEY] = key;
  patch[K.KEY_ACKED] = !showOnce;
  chrome.storage.local.set(patch, refreshKeyUI);
}

// ---------------------------------------------------------------- status / mode
function renderStatus(s) {
  var pill = el("statusPill");
  var label = pill.querySelector(".signal-text") || pill;
  function setSignal(cls, text) {
    pill.className = "signal" + (cls ? " " + cls : "");
    label.textContent = text;
  }
  if (s.killed) {
    setSignal("dead", "Killed");
  } else if (s.connected) {
    setSignal("on", "Connected");
    el("keyReconnectNotice").classList.add("hidden");
  } else if (s.mockMode) {
    setSignal("", "Mock mode");
  } else {
    setSignal("", "Idle");
  }
  el("mockBanner").classList.toggle("hidden", !s.mockMode);
  el("killBtn").classList.toggle("hidden", !!s.killed);
  el("reviveBtn").classList.toggle("hidden", !s.killed);
  el("killedBanner").classList.toggle("hidden", !s.killed);
}

function renderModes(mode) {
  var list = el("modeList");
  list.innerHTML = "";
  Object.keys(JBB.MODES).forEach(function (key) {
    var m = JBB.MODES[key];
    var label = document.createElement("label");
    label.className = "mode-opt" + (key === mode ? " selected" : "");
    label.innerHTML =
      '<input type="radio" name="mode" value="' + key + '"' + (key === mode ? " checked" : "") + ">" +
      '<span><span class="mode-label">' + esc(m.label) + "</span><br>" +
      '<span class="mode-desc">' + esc(m.desc) + "</span></span>";
    label.querySelector("input").addEventListener("change", function () {
      api({ kind: "jbb.ui.setMode", mode: key }).then(function () {
        toast("Mode: " + m.label);
      });
    });
    list.appendChild(label);
  });
}

// ---------------------------------------------------------------- consent cards
function renderConsentCard(proposal) {
  var area = el("consentArea");
  // One card per proposal; replace if re-rendered.
  var old = document.getElementById("consent-" + proposal.proposalId);
  if (old) old.remove();

  var tier = JBB.ACTION_TIERS[proposal.actionTier] || { label: proposal.actionTier, desc: "" };
  var card = document.createElement("div");
  card.className = "consent-card tier-" + proposal.actionTier;
  card.id = "consent-" + proposal.proposalId;
  card.innerHTML =
    '<div class="consent-head">' +
      '<span class="tier-badge">' + esc(tier.label) + "</span>" +
      '<span class="consent-site">' + esc(hostOf(proposal.site)) + "</span>" +
    "</div>" +
    '<div class="consent-desc">' + esc(proposal.description || proposal.type) + "</div>" +
    '<div class="consent-tier-desc">' + esc(tier.desc) + "</div>" +
    '<div class="consent-actions">' +
      '<button class="btn btn-primary" data-choice="once">Allow once</button>' +
      '<button class="btn btn-secondary" data-choice="site">Always on this site</button>' +
      '<button class="btn btn-secondary" data-choice="session1h">For 1 hour</button>' +
      '<button class="btn btn-secondary" data-choice="session24h">For 1 day</button>' +
      '<button class="btn btn-danger" data-choice="deny">Deny</button>' +
    "</div>";

  card.querySelectorAll("button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var choice = btn.getAttribute("data-choice");
      api({ kind: "jbb.ui.consent", proposalId: proposal.proposalId, choice: choice })
        .then(function () { card.remove(); });
    });
  });

  area.prepend(card);
}

// ---------------------------------------------------------------- session grant
function fmtRemaining(ms) {
  var m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return m + "m left";
  var h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m left";
}

function renderSession(session) {
  var bar = el("sessionBar");
  if (!session) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML = "";
  var dot = document.createElement("span");
  dot.className = "session-dot";
  var txt = document.createElement("span");
  txt.className = "session-text";
  var strong = document.createElement("strong");
  strong.textContent = "Session active";
  txt.appendChild(strong);
  txt.appendChild(document.createTextNode(
    " — " + session.site + " · " + fmtRemaining(session.remainingMs) + " · T3 still asks"));
  var revoke = document.createElement("button");
  revoke.className = "session-revoke";
  revoke.textContent = "Revoke";
  revoke.addEventListener("click", function () {
    api({ kind: "jbb.ui.revokeSession" }).then(function () { refresh(); });
  });
  bar.appendChild(dot);
  bar.appendChild(txt);
  bar.appendChild(revoke);
}

// ---------------------------------------------------------------- sites
function renderSites(sites) {
  var list = el("sitesList");
  list.innerHTML = "";
  var hosts = Object.keys(sites || {});
  if (!hosts.length) {
    list.innerHTML = '<div class="empty">No site grants yet. Approve an action with “Always on this site” to add one.</div>';
    return;
  }
  hosts.sort().forEach(function (host) {
    var row = document.createElement("div");
    row.className = "site-row";
    var tag = sites[host] === "deny"
      ? '<span class="mini-tag tag-bad">blocked</span>'
      : '<span class="mini-tag tag-ok">allowed</span>';
    row.innerHTML = '<span class="site-host">' + esc(host) + "</span>" + tag;
    var btn = document.createElement("button");
    btn.className = "btn btn-danger";
    btn.textContent = "Revoke";
    btn.addEventListener("click", function () {
      api({ kind: "jbb.ui.revokeSite", host: host }).then(function () {
        toast("Revoked: " + host);
      });
    });
    row.appendChild(btn);
    list.appendChild(row);
  });
}

// ---------------------------------------------------------------- audit
function auditRow(e) {
  var row = document.createElement("div");
  row.className = "audit-row";
  var t = new Date(e.ts || Date.now());
  var time = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  var tierLabel = String(e.tier || "?");
  if (tierLabel.charAt(0) !== "T") tierLabel = "T" + tierLabel;
  row.innerHTML =
    '<div class="audit-top">' +
      '<span class="tier-badge">' + esc(tierLabel) + "</span>" +
      '<span class="result result-' + esc(e.result || "allowed") + '">' + esc(e.result || "") + "</span>" +
      '<span class="audit-time">' + esc(time) + "</span>" +
    "</div>" +
    '<div class="audit-action">' + esc(e.action || "") + "</div>" +
    '<div class="audit-site">' + esc(e.site || "") + (e.detail ? " · " + esc(e.detail) : "") + "</div>";
  return row;
}

function renderAudit(entries) {
  var list = el("auditList");
  list.innerHTML = "";
  var items = (entries || []).slice().reverse();
  if (!items.length) {
    list.innerHTML = '<div class="empty">No activity yet.</div>';
    return;
  }
  items.slice(0, 200).forEach(function (e) { list.appendChild(auditRow(e)); });
}

// ---------------------------------------------------------------- boot & events
function refresh() {
  api({ kind: "jbb.ui.getState" }).then(function (s) {
    if (!s || !s.ok) return;
    renderStatus(s);
    renderModes(s.mode);
    renderSites(s.sites);
    renderSession(s.session);
    renderAudit(s.audit);
    // Don't clobber the relay URL while the user is typing it: status
    // updates arrive on every (re)connect attempt, and the old code wiped
    // the field back to the stored value mid-edit.
    if (document.activeElement !== el("relayUrl")) {
      el("relayUrl").value = s.relayUrl || "";
    }
    (s.pending || []).forEach(renderConsentCard);
  });
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || typeof msg.kind !== "string") return;
  switch (msg.kind) {
    case "jbb.ui.consentRequest":
      renderConsentCard(msg.proposal);
      toast("Approval needed — see top of panel");
      break;
    case "jbb.ui.consentResolved": {
      var card = document.getElementById("consent-" + msg.proposalId);
      if (card) card.remove();
      break;
    }
    case "jbb.ui.status":
      refresh();
      if (msg.error) toast(msg.error);
      break;
    case "jbb.ui.sessionChanged":
      refresh();
      break;
    case "jbb.ui.notifFailed":
      el("notifWarnErr").textContent = msg.error || "unknown error";
      el("notifWarn").classList.remove("hidden");
      break;
    case "jbb.ui.notifOk":
      el("notifWarn").classList.add("hidden");
      toast("Notification works — approval prompts will reach you");
      break;
    case "jbb.ui.killed":
    case "jbb.ui.revived":
    case "jbb.ui.modeChanged":
    case "jbb.ui.sitesChanged":
      refresh();
      break;
    case "jbb.ui.auditAppended":
      api({ kind: "jbb.ui.getState" }).then(function (s) {
        if (s && s.ok) renderAudit(s.audit);
      });
      break;
    case "jbb.ui.toast":
      toast(msg.text);
      break;
  }
});

document.addEventListener("DOMContentLoaded", function () {
  // Theme: day / night. Applied first to avoid a flash.
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var isLight = theme === "light";
    el("iconMoon").classList.toggle("hidden", isLight);
    el("iconSun").classList.toggle("hidden", !isLight);
  }
  chrome.storage.local.get(["jbb.theme"], function (res) {
    applyTheme(res["jbb.theme"] === "light" ? "light" : "dark");
  });
  el("themeBtn").addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    chrome.storage.local.set({ "jbb.theme": next });
    applyTheme(next);
  });

  // Tabs
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      el("tab-" + tab.getAttribute("data-tab")).classList.add("active");
    });
  });

  // Kill switch
  el("killBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.kill" }).then(function () { toast("Session killed"); });
  });
  el("reviveBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.revive" }).then(function () { toast("New session started"); });
  });

  // Key management
  el("genKeyBtn").addEventListener("click", function () {
    setKey(generateKey(), true);
    el("keyReconnectNotice").classList.remove("hidden");
  });
  el("copyKeyBtn").addEventListener("click", function () {
    navigator.clipboard.writeText(el("keyValue").textContent).then(
      function () { toast("Key copied — store it somewhere safe"); },
      function () { toast("Copy failed — select the key manually"); }
    );
  });
  el("keySavedBtn").addEventListener("click", function () {
    chrome.storage.local.set({ [K.KEY_ACKED]: true }, refreshKeyUI);
  });
  el("regenKeyBtn").addEventListener("click", function () {
    if (confirm("Regenerate the connector key? The old key stops working immediately.")) {
      setKey(generateKey(), true);
      el("keyReconnectNotice").classList.remove("hidden");
      toast("Key regenerated — reconnect for it to take effect");
    }
  });
  el("revokeKeyBtn").addEventListener("click", function () {
    if (confirm("Revoke the connector key? This browser will be unlinked immediately.")) {
      chrome.storage.local.remove([K.KEY, K.KEY_ACKED], function () {
        refreshKeyUI();
        toast("Key revoked");
      });
    }
  });

  // Relay
  el("saveRelayBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.setRelayUrl", url: el("relayUrl").value }).then(refresh);
  });
  el("connectBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.setRelayUrl", url: el("relayUrl").value }).then(function () {
      return api({ kind: "jbb.ui.connect" });
    }).then(refresh);
  });
  el("disconnectBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.disconnect" }).then(refresh);
  });
  el("testNotifBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.testNotif" });
  });
  el("reconnectKeyBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.disconnect" }).then(function () {
      return api({ kind: "jbb.ui.connect" });
    }).then(function () {
      el("keyReconnectNotice").classList.add("hidden");
      toast("Reconnected with the new key");
      refresh();
    });
  });

  // Mock mode
  el("mockBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.mockPropose" });
  });

  // Observe current page
  el("observeBtn").addEventListener("click", function () {
    var out = el("snapshotOut");
    out.classList.remove("hidden");
    out.textContent = "observing…";
    api({ kind: "jbb.ui.observe", screenshot: false }).then(function (res) {
      if (res && res.observation) {
        out.textContent = JSON.stringify(res.observation.snapshot, null, 1).slice(0, 4000);
      } else {
        out.textContent = "observe failed: " + ((res && res.error) || "unknown");
      }
    });
  });

  // Sites
  el("blockCurrentBtn").addEventListener("click", function () {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(function (tabs) {
      var host = hostOf(tabs[0] && tabs[0].url);
      if (host && host !== "-") {
        api({ kind: "jbb.ui.blockSite", host: host }).then(function () {
          toast("Blocked: " + host);
        });
      }
    });
  });

  // Audit export
  el("exportAuditBtn").addEventListener("click", function () {
    chrome.storage.local.get(["jbb.audit"], function (res) {
      var blob = new Blob(
        [JSON.stringify({ exportedAt: new Date().toISOString(), entries: res["jbb.audit"] || [] }, null, 2)],
        { type: "application/json" }
      );
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "jbb-audit-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    });
  });

  refreshKeyUI();
  refresh();
  try {
    el("brandSub").textContent = "v" + chrome.runtime.getManifest().version + " · protocol 1.0";
  } catch (e) { /* cosmetic only */ }
});
