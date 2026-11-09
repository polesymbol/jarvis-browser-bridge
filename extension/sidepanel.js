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
      (proposal.actionTier === "T1" || proposal.actionTier === "T2"
        ? '<button class="btn btn-secondary" data-choice="whitelist">Always allow on this site</button>'
        : '') +
      '<button class="btn btn-secondary" data-choice="session1h">For 1 hour</button>' +
      '<button class="btn btn-secondary" data-choice="session24h">For 1 day</button>' +
      '<button class="btn btn-secondary" data-choice="session1w">For 1 week</button>' +
      '<button class="btn btn-danger" data-choice="deny">Deny</button>' +
    "</div>" +
    '<div class="consent-custom">' +
      '<label for="until-' + proposal.proposalId + '">Or until</label>' +
      '<input type="datetime-local" class="consent-until" id="until-' + proposal.proposalId + '">' +
      '<button class="btn btn-secondary" data-choice="sessionCustom">Allow until then</button>' +
    "</div>" +
    '<div class="consent-grant-note">Timed grants cover routine (T1–T2) actions on this site until they lapse. “Always allow on this site” writes a whitelist entry for this action’s tier on this exact domain only — subdomains are separate entries, and you can narrow it per action in the Sites tab. Critical T3 actions — sign-in, payments, sending, publishing, deleting — will still ask every time, even inside a grant.</div>';

  card.querySelectorAll("button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var choice = btn.getAttribute("data-choice");
      var payload = { kind: "jbb.ui.consent", proposalId: proposal.proposalId, choice: choice };
      if (choice === "sessionCustom") {
        var input = card.querySelector(".consent-until");
        var ts = input && input.value ? Date.parse(input.value) : NaN;
        if (!isFinite(ts) || ts <= Date.now()) { if (input) input.focus(); return; }
        payload.expiresAt = ts;
      }
      api(payload).then(function () { card.remove(); });
    });
  });

  area.prepend(card);

  // Acknowledge visibility: the background may only tell the driver
  // "consent.shown" once a prompt is actually on screen — this render is
  // one of the two proofs (the in-page banner is the other).
  api({ kind: "jbb.ui.consentShown", proposalId: proposal.proposalId }).catch(function () {});
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
// The action vocabulary mirrors WHITELIST_ACTIONS_V1 in background.js;
// the background sanitizes whatever the manager sends, so drift here can
// only ever narrow coverage, never widen it.
var WL_ACTIONS = ["click", "type", "scroll", "navigate", "clickAt", "clickSelector", "key",
                  "hover", "select", "drag", "setValue"];
var WL_REVIEW_MS = 30 * 86400e3;

function fmtDate(ts) {
  if (!ts) return "never";
  return new Date(ts).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function renderSites(sites, whitelist, currentSchema) {
  var list = el("sitesList");
  list.innerHTML = "";
  var hosts = Object.keys(sites || {});
  var wlHosts = Object.keys(whitelist || {});
  if (!hosts.length && !wlHosts.length) {
    list.innerHTML = '<div class="empty">No site grants yet. Approve a T1/T2 action with “Always allow on this site”, or add a domain above.</div>';
    return;
  }
  // Whitelist entries: the manager. Domain, coverage, dates, schema,
  // review state, per-action checkboxes, revoke.
  wlHosts.sort().forEach(function (host) {
    var entry = whitelist[host];
    var wrap = document.createElement("div");
    wrap.className = "wl-entry";

    var head = document.createElement("div");
    head.className = "wl-entry-head";
    head.innerHTML = '<span class="site-host">' + esc(host) + "</span>" +
      '<span class="mini-tag tag-ok">whitelisted · ' + esc((entry.tiers || []).join("+") || "—") + "</span>";
    var manageBtn = document.createElement("button");
    manageBtn.className = "btn btn-secondary";
    manageBtn.textContent = "Manage";
    var revokeBtn = document.createElement("button");
    revokeBtn.className = "btn btn-danger";
    revokeBtn.textContent = "Revoke";
    revokeBtn.addEventListener("click", function () {
      api({ kind: "jbb.ui.revokeSite", host: host }).then(function () {
        toast("Revoked: " + host);
      });
    });
    head.appendChild(manageBtn);
    head.appendChild(revokeBtn);
    wrap.appendChild(head);

    var meta = document.createElement("div");
    meta.className = "wl-meta";
    meta.textContent = "Granted " + fmtDate(entry.grantedAt) + " · Last used " + fmtDate(entry.lastUsedAt) +
      " · schema v" + (entry.schemaVersion || "?") +
      " · Allows: " + ((entry.actions || []).join(", ") || "nothing (all ask)");
    wrap.appendChild(meta);

    var staleSchema = typeof currentSchema === "number" && entry.schemaVersion !== currentSchema;
    if (staleSchema) {
      var sw = document.createElement("div");
      sw.className = "wl-schema-warn";
      sw.textContent = "Review needed — new action types are not covered by this entry (schema v" +
        entry.schemaVersion + " < v" + currentSchema + ").";
      wrap.appendChild(sw);
    }

    // 30-day review: no silent permanence. Keep re-confirms (and adopts
    // the current schema); Revoke removes.
    var lastConfirmed = Math.max(entry.grantedAt || 0, entry.reviewedAt || 0);
    var reviewDue = staleSchema || (Date.now() - lastConfirmed > WL_REVIEW_MS);
    if (reviewDue) {
      var rv = document.createElement("div");
      rv.className = "wl-review";
      var q = document.createElement("span");
      q.textContent = "Still want Muse to have " + ((entry.tiers || []).join("/") || "access") + " on " + host + "?";
      var keepBtn = document.createElement("button");
      keepBtn.className = "btn btn-primary";
      keepBtn.textContent = "Keep";
      keepBtn.addEventListener("click", function () {
        api({ kind: "jbb.ui.keepWhitelist", domain: host }).then(function () {
          toast("Kept: " + host);
        });
      });
      var rvRevoke = document.createElement("button");
      rvRevoke.className = "btn btn-danger";
      rvRevoke.textContent = "Revoke";
      rvRevoke.addEventListener("click", function () {
        api({ kind: "jbb.ui.revokeSite", host: host }).then(function () {
          toast("Revoked: " + host);
        });
      });
      rv.appendChild(q);
      rv.appendChild(keepBtn);
      rv.appendChild(rvRevoke);
      wrap.appendChild(rv);
    }

    // Per-action manager: tier toggles + action checkboxes. Unchecked
    // means "ask" — the default for everything.
    var grid = document.createElement("div");
    grid.className = "wl-grid hidden";
    function pushUpdate() {
      var tiers = Array.prototype.slice.call(grid.querySelectorAll("input[data-tier]:checked"))
        .map(function (i) { return i.getAttribute("data-tier"); });
      var actions = Array.prototype.slice.call(grid.querySelectorAll("input[data-action]:checked"))
        .map(function (i) { return i.getAttribute("data-action"); });
      api({ kind: "jbb.ui.updateWhitelist", domain: host, tiers: tiers, actions: actions });
    }
    ["T1", "T2"].forEach(function (t) {
      var lab = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-tier", t);
      cb.checked = (entry.tiers || []).indexOf(t) !== -1;
      cb.addEventListener("change", pushUpdate);
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(t));
      grid.appendChild(lab);
    });
    WL_ACTIONS.forEach(function (a) {
      var lab = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-action", a);
      cb.checked = (entry.actions || []).indexOf(a) !== -1;
      cb.addEventListener("change", pushUpdate);
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(a));
      grid.appendChild(lab);
    });
    manageBtn.addEventListener("click", function () { grid.classList.toggle("hidden"); });
    wrap.appendChild(grid);

    list.appendChild(wrap);
  });
  // Blocked hosts (sites map deny entries).
  hosts.sort().forEach(function (host) {
    if (sites[host] !== "deny") return;
    var row = document.createElement("div");
    row.className = "site-row";
    row.innerHTML = '<span class="site-host">' + esc(host) + "</span>" +
      '<span class="mini-tag tag-bad">blocked</span>';
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
  // Finished actions speak plainly (same words as the live feed);
  // bookkeeping entries keep their raw result.
  var cat = JBB.feedCategory(e);
  var resultLabel = cat ? cat.label : (e.result || "");
  var plain = (cat && (e.result === "denied" || e.result === "failed")) ? JBB.plainReason(e) : null;
  row.innerHTML =
    '<div class="audit-top">' +
      '<span class="tier-badge">' + esc(tierLabel) + "</span>" +
      '<span class="result result-' + esc(e.result || "allowed") + '">' + esc(resultLabel) + "</span>" +
      '<span class="audit-time">' + esc(time) + "</span>" +
    "</div>" +
    '<div class="audit-action">' + esc(e.action || "") + "</div>" +
    '<div class="audit-site">' + esc(e.site || "") + (e.detail ? " · " + esc(e.detail) : "") + "</div>" +
    (plain && plain.why ? '<div class="feed-why">' + esc(plain.why) + (plain.fix ? " " + esc(plain.fix) : "") + "</div>" : "");
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

// ------------------------------------------------------------- live feed
// The last ~10 finished actions, in plain language. One row per action:
// what happened, where, and — for anything stopped — why, and what would
// allow it. Updates live via the auditAppended push (no reload).
function renderFeed(entries) {
  var list = el("feedList");
  if (!list) return;
  list.innerHTML = "";
  var rows = JBB.feedRows(entries || [], 10);
  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nothing yet — actions will appear here as Muse works.</div>';
    return;
  }
  rows.forEach(function (r) {
    var row = document.createElement("div");
    row.className = "feed-row";
    var time = new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    var html =
      '<div class="feed-top"><span class="feed-label cat-' + esc(r.category) + '">' + esc(r.label) + "</span>" +
      '<span class="feed-time">' + esc(time) + "</span></div>" +
      '<div class="feed-action">' + esc(r.action) + "</div>" +
      '<div class="feed-site">' + esc(r.site) + "</div>";
    if (r.why) html += '<div class="feed-why">' + esc(r.why) + "</div>";
    if (r.fix) html += '<div class="feed-fix">' + esc(r.fix) + "</div>";
    row.innerHTML = html;
    list.appendChild(row);
  });
}

// ------------------------------------------------------------- session summary
function renderSummary(summary) {
  var card = el("summaryCard");
  var body = el("summaryBody");
  if (!card || !body) return;
  if (!summary) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  var when = new Date(summary.endedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  var html = '<div class="sum-head">' + esc(summary.sentence || "") + "</div>" +
    '<div class="wl-meta">Session ended ' + esc(when) + " · " + summary.executed + " action" +
    (summary.executed === 1 ? "" : "s") + " carried out</div>";
  var sites = Object.keys(summary.bySite || {});
  if (sites.length) {
    html += '<div class="wl-meta">By site:</div><ul class="sum-sites">' + sites.sort().map(function (h) {
      return "<li>" + esc(h) + " — " + summary.bySite[h] + "</li>";
    }).join("") + "</ul>";
  }
  if ((summary.denied || []).length) {
    html += '<div class="wl-meta">Denied or blocked:</div><ul class="sum-denied">' + summary.denied.map(function (d) {
      return "<li>" + esc(d.action) + " (" + esc(d.site) + ")</li>";
    }).join("") + "</ul>";
  }
  body.innerHTML = html;
}

// ---------------------------------------------------------------- boot & events
function refresh() {
  api({ kind: "jbb.ui.getState" }).then(function (s) {
    if (!s || !s.ok) return;
    renderStatus(s);
    renderModes(s.mode);
    renderSites(s.sites, s.whitelist, s.whitelistSchema);
    el("grantsPauseToggle").checked = !!s.grantsPaused;
    renderSession(s.session);
    // Grants line: session grant + whitelist entries are the active grants.
    var grantCount = (s.session ? 1 : 0) + Object.keys(s.sites || {}).filter(function (h) {
      return s.sites[h] === "allow";
    }).length + Object.keys(s.whitelist || {}).length;
    el("grantsLine").textContent = grantCount === 0
      ? "0 active grants — re-grant to continue"
      : grantCount + " active grant" + (grantCount === 1 ? "" : "s");
    renderAudit(s.audit);
    renderFeed(s.audit);
    renderSummary(s.lastSummary);
    // Don't clobber the relay URL while the user is typing it: status
    // updates arrive on every (re)connect attempt, and the old code wiped
    // the field back to the stored value mid-edit.
    if (document.activeElement !== el("relayUrl")) {
      el("relayUrl").value = s.relayUrl || "";
    }
    el("soundToggle").checked = (typeof s.soundOn === "boolean") ? s.soundOn : true;
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
    case "jbb.ui.signInChanged":
      renderSignInBlock(msg);
      refresh();
      break;
    case "jbb.ui.notifFailed":
      el("notifWarnErr").textContent = msg.error || "unknown error";
      el("notifWarn").classList.remove("hidden");
      break;
    case "jbb.ui.notifPermission":
      el("notifWarnErr").textContent = "Notifications blocked (" + (msg.level || "?") +
        ") — approval prompts fall back to badge + banner. Enable Chrome notifications in OS settings.";
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
        if (s && s.ok) { renderAudit(s.audit); renderFeed(s.audit); }
      });
      break;
    case "jbb.ui.sessionSummary":
      refresh();
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

  // Sign-in hard block UI.
  function renderSignInBlock(s) {
    var show = !!(s && s.blocked);
    el("signInBlock").classList.toggle("hidden", !show);
    if (s && s.email) el("signInEmail").textContent = s.email;
    el("connectBtn").disabled = show;
  }
  // Safety banner: fresh-profile requirement. Shown until acknowledged.
  chrome.storage.local.get(["jbb.safetyAcked"], function (res) {
    if (!res["jbb.safetyAcked"]) el("safetyBanner").classList.remove("hidden");
  });
  el("safetyAckBtn").addEventListener("click", function () {
    chrome.storage.local.set({ "jbb.safetyAcked": true });
    el("safetyBanner").classList.add("hidden");
  });
  el("signInAckBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.ackSignIn" }).then(function () { refresh(); });
  });
  // Ask the background for current sign-in state on panel open.
  api({ kind: "jbb.ui.getSignInState" }).then(function (s) {
    if (s && s.ok) renderSignInBlock(s);
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
  el("rotateKeyBtn").addEventListener("click", function () {
    if (!confirm("Rotate the connector key? This disconnects the connected driver, revokes the old key at the relay, and invalidates ALL grants made under it (session grants + per-site allows). The new key is shown once.")) return;
    api({ kind: "jbb.ui.rotateKey" }).then(function (r) {
      // The background stored the new key un-acked, so refreshKeyUI reveals
      // it exactly once through the standard shown-once flow. The key is
      // never written anywhere else.
      refreshKeyUI();
      el("grantsLine").textContent = "0 active grants — re-grant to continue";
      toast("Key rotated — driver disconnected, all grants invalidated");
      refresh();
    });
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
  el("endSessionBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.endSession" }).then(function (res) {
      if (res && res.summary) toast("Session ended — summary below");
      refresh();
    });
  });
  el("testNotifBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.testNotif" });
  });
  el("soundToggle").addEventListener("change", function () {
    api({ kind: "jbb.ui.setSound", on: el("soundToggle").checked }).then(refresh);
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

  // Whitelist manager: pause switch, add-by-typing, add-current, revoke all.
  el("grantsPauseToggle").addEventListener("change", function () {
    api({ kind: "jbb.ui.setGrantsPaused", paused: el("grantsPauseToggle").checked }).then(function (res) {
      toast(res && res.grantsPaused ? "All grants paused — everything will ask" : "Grants resumed");
    });
  });
  function wlAdd(domain, confirmed) {
    api({ kind: "jbb.ui.addWhitelist", domain: domain, tiers: ["T1"], confirmed: !!confirmed }).then(function (res) {
      var warn = el("wlWarn");
      if (res && res.ok) {
        warn.classList.add("hidden");
        el("wlDomainInput").value = "";
        toast("Whitelisted: " + domain + " (T1)");
      } else if (res && res.warning === "punycode") {
        warn.innerHTML = "";
        var span = document.createElement("span");
        span.textContent = "⚠ " + res.domain + " is a punycode (xn--) domain — the classic lookalike trick. " +
          "Double-check this is really the site you mean.";
        var btn = document.createElement("button");
        btn.className = "btn btn-danger";
        btn.textContent = "Add anyway";
        btn.addEventListener("click", function () { wlAdd(res.domain, true); });
        warn.appendChild(span);
        warn.appendChild(btn);
        warn.classList.remove("hidden");
      } else {
        warn.textContent = "Could not add: " + ((res && res.error) || "unknown error");
        warn.classList.remove("hidden");
      }
    });
  }
  el("wlAddBtn").addEventListener("click", function () {
    var v = el("wlDomainInput").value.trim();
    if (v) wlAdd(v, false);
  });
  el("wlAddCurrentBtn").addEventListener("click", function () {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(function (tabs) {
      var host = hostOf(tabs[0] && tabs[0].url);
      if (host && host !== "-") wlAdd(host, false);
    });
  });
  el("wlRevokeAllBtn").addEventListener("click", function () {
    if (!confirm("Remove ALL whitelist entries? Muse will ask before acting on every site again.")) return;
    api({ kind: "jbb.ui.revokeAllWhitelist" }).then(function () {
      toast("All whitelist entries revoked");
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
