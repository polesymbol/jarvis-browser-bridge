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
  KEY_ACKED: "jbb.keyAcked", // true once the user confirmed they saved the key
  KEYMETA: "jbb.keyMeta",    // { createdAt, ttlMs } — written with every new key
  KEYUSAGE: "jbb.keyUsage",  // { connectedMs, acts } — reset with every new key
  KEYEXPIRED: "jbb.keyExpired" // { at, reason } — set by the worker when a key expires
};

var el = function (id) { return document.getElementById(id); };

function api(msg) {
  return chrome.runtime.sendMessage(msg);
}

var lastState = null;      // most recent getState — cards look plans up here
var feedFilter = "all";    // Activity feed chip: all | asked | auto | denied | failed
var auditFilter = { cat: "all", site: "", session: "all" };
var statusOpen = false;    // header connection breakdown expanded

function fmtAge(ms) {
  var sec = Math.max(0, Math.floor(ms / 1000));
  var m = Math.floor(sec / 60);
  return m + ":" + String(sec % 60).padStart(2, "0");
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
  chrome.storage.local.get([K.KEY, K.KEY_ACKED, K.KEYEXPIRED], function (res) {
    var key = res[K.KEY];
    var acked = res[K.KEY_ACKED];
    el("keyNone").classList.toggle("hidden", !!key);
    el("keyReveal").classList.toggle("hidden", !(key && !acked));
    el("keyMasked").classList.toggle("hidden", !(key && acked));
    var expired = !key && res[K.KEYEXPIRED];
    el("keyExpiredNotice").classList.toggle("hidden", !expired);
    if (expired) el("keyExpiredReason").textContent = res[K.KEYEXPIRED].reason || "its lifetime elapsed";
    if (key && !acked) el("keyValue").textContent = key;
    if (key && acked) el("keyMaskedValue").textContent = maskKey(key);
  });
}

function setKey(key, showOnce, ttlMs) {
  var patch = {};
  patch[K.KEY] = key;
  patch[K.KEY_ACKED] = !showOnce;
  // A new key is born with the lifetime picked in the Key tab and a fresh
  // usage budget; the worker enforces both (see "key expiry" there).
  patch[K.KEYMETA] = { createdAt: Date.now(), ttlMs: ttlMs || 0 };
  patch[K.KEYUSAGE] = { connectedMs: 0, acts: 0 };
  chrome.storage.local.remove([K.KEYEXPIRED]);
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
  var peer = s.peer || { present: false, seenAt: 0, lastFlapAt: 0 };
  if (s.killed) {
    setSignal("dead", "Killed");
  } else if (s.takeover) {
    setSignal("", "Paused — you're driving");
  } else if (s.connected && peer.present) {
    setSignal("on", "Connected · peer live");
    el("keyReconnectNotice").classList.add("hidden");
  } else if (s.connected && peer.seenAt) {
    // The peer was here and is gone: that is "reconnecting", never
    // "connected" — the flap the old single green dot used to hide.
    setSignal("warn", "Reconnecting…");
  } else if (s.connected) {
    setSignal("dead", "Peer never joined");
  } else if (s.mockMode) {
    setSignal("", "Mock mode");
  } else if (s.relayUrl) {
    setSignal("dead", "Relay down");
  } else {
    setSignal("", "Idle");
  }
  if (s.grantsPaused && !s.killed) label.textContent += " · grants paused";
  // Sound header icon mirrors the Setup checkbox.
  var soundOn = (typeof s.soundOn === "boolean") ? s.soundOn : true;
  el("iconSoundOn").classList.toggle("hidden", !soundOn);
  el("iconSoundOff").classList.toggle("hidden", soundOn);
  renderStatusDetail(s);
  el("mockBanner").classList.toggle("hidden", !s.mockMode);
  el("killBtn").classList.toggle("hidden", !!s.killed);
  el("reviveBtn").classList.toggle("hidden", !s.killed);
  el("killedBanner").classList.toggle("hidden", !s.killed);
}

function renderStatusDetail(s) {
  var box = el("statusDetail");
  if (!statusOpen) { box.classList.add("hidden"); return; }
  var peer = s.peer || { present: false, seenAt: 0, lastFlapAt: 0, pendingCount: 0 };
  var lines = [
    "Relay: " + (s.connected ? "up — extension joined" : (s.relayUrl ? "down — cannot reach it" : "not configured (mock mode)")),
    "Peer (driver): " + (peer.present ? "live in the room" : (peer.seenAt ? "absent — was here, dropped out" : "never joined — a wrong key pairs into an empty room silently; the key may not match")),
    "Worker: alive (it answered this panel)",
    "Pending proposals: " + ((s.pending || []).length),
    "Last flap: " + (peer.lastFlapAt ? new Date(peer.lastFlapAt).toLocaleTimeString() : "—")
  ];
  box.textContent = lines.join(" · ");
  box.classList.remove("hidden");
}

// The mode selector lives in the header now — always visible, one tap,
// takes effect immediately (the worker audits the change). Four segments:
// Readonly stays (Pratik's call, 2026-11-09) — observe-only is a real
// safety posture, not a legacy mode.
function renderModes(mode) {
  var seg = el("modeSeg");
  seg.innerHTML = "";
  Object.keys(JBB.MODES).forEach(function (key) {
    var m = JBB.MODES[key];
    var btn = document.createElement("button");
    btn.className = "mode-seg-btn" + (key === mode ? " active" : "");
    btn.textContent = m.label;
    btn.setAttribute("aria-pressed", key === mode ? "true" : "false");
    btn.addEventListener("click", function () {
      if (key === mode) return;
      api({ kind: "jbb.ui.setMode", mode: key }).then(function () {
        toast("Mode: " + m.label);
        refresh();
      });
    });
    seg.appendChild(btn);
  });
  var cur = JBB.MODES[mode];
  el("modeCaption").textContent = cur ? cur.label + ": " + cur.desc : "";
}

// ---------------------------------------------------------------- consent cards
// The hero element. One card per pending proposal, newest first: tier,
// plain-words action, exact domain, WHY (plan/step), an age timer that
// counts up, and the decisions — four max, with timed grants folded into
// "More options". A card never auto-denies and never vanishes: after the
// driver's 120s window it stays queued here, and says so.
function planWhyLine(proposal) {
  if (!proposal.planId) return "No plan context — asked on its own.";
  var plans = (lastState && lastState.plans) || [];
  var pending = (lastState && lastState.planPending) || [];
  var found = null;
  plans.concat(pending).forEach(function (pl) { if (pl.planId === proposal.planId) found = pl; });
  if (!found) return "Plan step — asked on its own.";
  var stepNote = found.stepCount ? "step " + (Math.min((found.usedSteps || 0) + 1, found.stepCount)) + " of " + found.stepCount : "a step";
  return "Plan “" + (found.title || "Untitled plan") + "” · " + stepNote + ".";
}

function renderConsentCard(proposal) {
  var area = el("consentArea");
  // One card per proposal; replace if re-rendered.
  var old = document.getElementById("consent-" + proposal.proposalId);
  if (old) old.remove();

  var tier = JBB.ACTION_TIERS[proposal.actionTier] || { label: proposal.actionTier, desc: "" };
  var isT3 = proposal.actionTier === "T3";
  var routine = proposal.actionTier === "T1" || proposal.actionTier === "T2";
  var createdAt = proposal._createdAt || Date.now();
  var card = document.createElement("div");
  card.className = "consent-card tier-" + proposal.actionTier;
  card.id = "consent-" + proposal.proposalId;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "Approval request");
  card.innerHTML =
    '<div class="consent-head">' +
      '<span class="tier-badge">' + esc(tier.label) + "</span>" +
      '<span class="consent-site">' + esc(hostOf(proposal.site)) + "</span>" +
      '<span class="consent-age" data-age-since="' + createdAt + '">waiting ' + fmtAge(Date.now() - createdAt) + "</span>" +
    "</div>" +
    '<div class="consent-desc">' + esc(proposal.description || proposal.type) + "</div>" +
    '<div class="consent-why">' + esc(planWhyLine(proposal)) + "</div>" +
    '<div class="consent-tier-desc">' + esc(tier.desc) + "</div>" +
    (isT3 ? '<div class="consent-t3warn">⚠ Critical action. This always asks, even inside a grant or a plan.</div>' : "") +
    '<div class="consent-actions">' +
      '<button class="btn btn-primary" data-choice="once">Allow once</button>' +
      (routine ? '<button class="btn btn-secondary" data-choice="session1h">Allow for this session</button>' : "") +
      (routine ? '<button class="btn btn-secondary" data-choice="whitelist">Always allow on this site</button>' : "") +
      '<button class="btn btn-danger" data-choice="deny">Deny</button>' +
    "</div>" +
    (routine ?
    '<details class="consent-more"><summary>More options — timed grants</summary>' +
      '<div class="consent-actions">' +
        '<button class="btn btn-secondary" data-choice="untilLeave">Until I leave this site</button>' +
        '<button class="btn btn-secondary" data-choice="session24h">For 1 day</button>' +
        '<button class="btn btn-secondary" data-choice="session1w">For 1 week</button>' +
      "</div>" +
      '<div class="consent-custom">' +
        '<label for="until-' + proposal.proposalId + '">Or until</label>' +
        '<input type="datetime-local" class="consent-until" id="until-' + proposal.proposalId + '">' +
        '<button class="btn btn-secondary" data-choice="sessionCustom">Allow until then</button>' +
      "</div>" +
    "</details>" : "") +
    '<div class="consent-grant-note">Timed grants cover routine (T1–T2) actions on this site until they lapse. “Always allow on this site” writes a whitelist entry for this action’s tier on this exact domain only — subdomains are separate entries, and you can narrow it per action in the Sites tab. Critical T3 actions — sign-in, payments, sending, publishing, deleting — will still ask every time, even inside a grant.</div>' +
    '<div class="consent-queue-note">Unanswered — still queued, never auto-denied. It will wait here until you answer or the session ends.</div>' +
    (proposal._escalated ? '<div class="consent-esc-line">Escalated at 1:00 — chimed again with a new notification.</div>' : "") +
    '<div class="consent-driver-note hidden">Timed out on the driver side — still queued here. You can still answer it.</div>';

  card.querySelectorAll("button[data-choice]").forEach(function (btn) {
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

// ---------------------------------------------------------------- control: take-over + plans
function renderControl(s) {
  var status = el("takeoverStatus"), btn = el("takeoverBtn");
  if (!status || !btn) return;
  if (s.takeover) {
    status.textContent = "🙌 You have control — Muse is paused." +
      (s.queuedCount ? " " + s.queuedCount + " action" + (s.queuedCount === 1 ? "" : "s") + " queued." : "");
    btn.textContent = "Hand back to Muse";
  } else {
    status.textContent = "Muse is driving.";
    btn.textContent = "Take over";
  }
}

el("takeoverBtn").addEventListener("click", function () {
  api({ kind: "jbb.ui.getState" }).then(function (s) {
    var on = !(s && s.takeover);
    api({ kind: "jbb.ui.setTakeover", on: on }).then(function () {
      toast(on ? "You have control — Muse is paused" : "Handed back — Muse resumes");
      refresh();
    });
  });
});

function renderPlanCard(plan) {
  var area = el("planArea");
  if (!area || document.getElementById("plan-" + plan.planId)) return;
  var card = document.createElement("div");
  card.className = "consent-card plan-card";
  card.id = "plan-" + plan.planId;
  var steps = (plan.steps || []).slice();
  function stepsHtml(editing) {
    return steps.map(function (st, i) {
      var t3 = st.actionTier === "T3";
      return '<div class="plan-step">' + (i + 1) + ". " + esc(st.description || st.type) +
        ' <span class="mini-tag' + (t3 ? " tag-bad" : "") + '">' + esc(st.actionTier || "T1") + (t3 ? " — will ask" : "") + "</span>" +
        ' <span class="hint-inline">' + esc(hostOf(st.site || "")) + "</span>" +
        (editing ? ' <button class="plan-remove" data-remove="' + i + '" aria-label="Remove step ' + (i + 1) + '">✕</button>' : "") +
        "</div>";
    }).join("");
  }
  function paint(editing) {
    card.innerHTML =
      '<div class="consent-head"><span class="tier-badge">PLAN</span>' +
        '<span class="consent-site">' + esc(plan.title || "Plan") + "</span></div>" +
      '<div class="consent-desc">Plan: ' + esc(plan.title || "Untitled plan") + " — " + steps.length +
        " steps. Approving scopes the run; it does not start it — you start it with a separate Start task.</div>" +
      '<div class="plan-steps">' + stepsHtml(editing) + "</div>" +
      '<div class="consent-tier-desc">Sites covered: ' + esc((plan.sites || []).join(", ")) +
        '. T3 steps still ask individually, even inside the plan.</div>' +
      (editing
        ? '<div class="consent-actions"><button class="btn btn-primary" data-plan="doneedit">Done editing</button></div>'
        : '<div class="consent-actions">' +
            '<button class="btn btn-primary" data-plan="approve">Approve plan</button>' +
            '<button class="btn btn-secondary" data-plan="edit">Edit</button>' +
            '<button class="btn btn-danger" data-plan="deny">Deny</button>' +
          "</div>");
    card.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var rm = btn.getAttribute("data-remove");
        if (rm !== null && rm !== undefined) {
          steps.splice(Number(rm), 1);
          paint(true);
          return;
        }
        var act = btn.getAttribute("data-plan");
        if (act === "edit") { paint(true); return; }
        if (act === "doneedit") {
          var keep = steps.map(function (st) { return (plan.steps || []).indexOf(st); })
                          .filter(function (i) { return i >= 0; });
          api({ kind: "jbb.ui.planEdit", planId: plan.planId, keep: keep }).then(function (res) {
            if (res && res.removedAll) { card.remove(); toast("Plan emptied — treated as denied"); }
            else paint(false);
          });
          return;
        }
        api({ kind: "jbb.ui.planResolve", planId: plan.planId, approved: act === "approve" })
          .then(function () { card.remove(); refresh(); });
      });
    });
  }
  paint(false);
  area.prepend(card);
}

// Approved plans: progress view + the two-stage gate controls. Rendered
// from getState on every refresh, into #planProgress.
function renderPlans(plans) {
  var box = el("planProgress");
  if (!box) return;
  box.innerHTML = "";
  (plans || []).forEach(function (pl) {
    var card = document.createElement("div");
    card.className = "consent-card plan-progress";
    var status = !pl.started
      ? "Approved — not started. Steps are holding; nothing runs until you start the task."
      : pl.paused
        ? "Paused at step " + Math.min(pl.usedSteps + 1, pl.stepCount) + " of " + pl.stepCount + "."
        : "Running — step " + Math.min(pl.usedSteps + 1, pl.stepCount) + " of " + pl.stepCount + ".";
    card.innerHTML =
      '<div class="consent-head"><span class="tier-badge">PLAN</span>' +
        '<span class="consent-site">' + esc(pl.title || "Plan") + "</span></div>" +
      '<div class="plan-status">' + esc(status) +
        (pl.heldCount ? ' <span class="hint-inline">(' + pl.heldCount + " step" + (pl.heldCount === 1 ? "" : "s") + " held)</span>" : "") +
      "</div>" +
      '<div class="plan-bar"><div class="plan-bar-fill"></div></div>' +
      '<div class="consent-actions">' +
        (!pl.started ? '<button class="btn btn-primary" data-pact="start">Start task</button>' : "") +
        (pl.started && !pl.paused ? '<button class="btn btn-secondary" data-pact="pause">Pause</button>' : "") +
        (pl.paused ? '<button class="btn btn-primary" data-pact="resume">Resume</button>' : "") +
        '<button class="btn btn-danger" data-pact="stop">Stop</button>' +
      "</div>";
    // Progress width via JS property — a style="" attribute in innerHTML
    // would trip the panel's CSP (the v0.2.3 lesson).
    var fill = card.querySelector(".plan-bar-fill");
    if (fill) fill.style.width = (pl.stepCount ? Math.round(100 * pl.usedSteps / pl.stepCount) : 0) + "%";
    card.querySelectorAll("button[data-pact]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var kind = { start: "jbb.ui.planStart", pause: "jbb.ui.planPause",
                     resume: "jbb.ui.planResume", stop: "jbb.ui.planStop" }[btn.getAttribute("data-pact")];
        api({ kind: kind, planId: pl.planId }).then(function () { refresh(); });
      });
    });
    box.appendChild(card);
  });
}

// ------------------------------------------------------------- now strip
// The sticky "what is Muse doing" strip: visible only while something
// is happening — a plan, a pending approval, a capture, or take-over.
function renderNowStrip(s) {
  var strip = el("nowStrip");
  if (!strip) return;
  var plan = (s.plans || []).filter(function (pl) { return pl.started; })[0] ||
             (s.plans || [])[0];
  var pending = (s.pending || [])[0];
  var show = !!(s.takeover || plan || pending || (s.capture && s.capture.active));
  strip.classList.toggle("hidden", !show);
  if (!show) return;
  var l1 = "", l2 = "";
  if (s.takeover) {
    l1 = "You're driving — Muse is paused";
    l2 = "Proposals queue; nothing runs, nothing is lost. Nothing is recorded or screenshotted while you drive.";
  } else if (plan && plan.started) {
    l1 = "Step " + Math.min(plan.usedSteps + 1, plan.stepCount) + " of " + plan.stepCount + ": " + (plan.title || "Plan");
    l2 = (plan.sites || []).join(", ") + (plan.paused ? " · paused" : "");
  } else if (plan) {
    l1 = "Plan approved — waiting for Start task";
    l2 = plan.title || "";
  } else if (pending) {
    l1 = "Waiting for your approval — " + (pending.description || pending.type);
    l2 = hostOf(pending.site || "");
  } else if (s.capture && s.capture.active) {
    l1 = "Listening to " + (s.capture.host || "a tab");
    l2 = "Audio capture is running — the tab shows a red pill.";
  }
  el("nowLine1").textContent = l1;
  el("nowLine2").textContent = l2;
  el("nowTakeoverBtn").classList.toggle("hidden", !!s.takeover);
  el("nowHandbackBtn").classList.toggle("hidden", !s.takeover);
  el("nowStopBtn").textContent = plan ? "Stop plan" : "Stop";
  strip.dataset.planId = plan ? plan.planId : "";
}

// ------------------------------------------------------------- media mini-player
function fmtClock(sec) {
  if (typeof sec !== "number" || !isFinite(sec)) return "0:00";
  var m = Math.floor(sec / 60), ss = Math.floor(sec % 60);
  return m + ":" + String(ss).padStart(2, "0");
}

function renderMedia(s) {
  var card = el("mediaCard");
  if (!card) return;
  var m = s.media;
  if (!m || !m.at || Date.now() - m.at > 45000) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  el("mediaTitle").textContent = m.title || hostOf(m.url || "");
  el("mediaTime").textContent = fmtClock(m.currentTime) + " / " + fmtClock(m.duration);
  var seek = el("mediaSeek");
  if (document.activeElement !== seek && m.duration) {
    seek.max = m.duration;
    seek.value = m.currentTime || 0;
  }
}

// ---------------------------------------------------------------- session grant
function fmtRemaining(ms) {
  var m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return m + "m left";
  var h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m left";
}

// Neutral duration (no "left") for the key-life line: used / budget / TTL.
function fmtDur(ms) {
  var m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60);
  if (h < 48) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
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

// ---------------------------------------------------------------- audio capture
function renderCapture(st) {
  var status = el("captureStatus");
  var enableBtn = el("capEnableBtn"), revokeBtn = el("capRevokeBtn"), stopBtn = el("capStopBtn");
  if (!status) return;
  var cap = st.capture || { active: false };
  if (cap.active) {
    status.textContent = "🎙 Listening to " + (cap.host || "a tab") + " since " +
      new Date(cap.startedAt).toLocaleTimeString() + " — the tab shows a red pill while this runs.";
  } else if (st.capturePermission) {
    status.textContent = "Enabled. Capture still asks before it starts, every time, unless you whitelist it per site.";
  } else {
    status.textContent = "Not enabled. Muse cannot hear any tab until you enable this.";
  }
  enableBtn.classList.toggle("hidden", !!st.capturePermission);
  revokeBtn.classList.toggle("hidden", !st.capturePermission);
  stopBtn.classList.toggle("hidden", !cap.active);
}

el("capEnableBtn").addEventListener("click", function () {
  // The permission request must come from THIS click (a user gesture in
  // an extension page) — the background can never ask for it.
  chrome.permissions.request({ permissions: ["tabCapture"] }, function () {
    api({ kind: "jbb.ui.capturePermissionChanged" }).then(function () { refresh(); });
  });
});
el("capRevokeBtn").addEventListener("click", function () {
  chrome.permissions.remove({ permissions: ["tabCapture"] }, function () {
    api({ kind: "jbb.ui.capturePermissionChanged" }).then(function () { refresh(); });
  });
});
el("capStopBtn").addEventListener("click", function () {
  api({ kind: "jbb.ui.stopCapture" }).then(function () { refresh(); });
});

// ---------------------------------------------------------------- sites
// The action vocabulary mirrors WHITELIST_ACTIONS_V1 in background.js;
// the background sanitizes whatever the manager sends, so drift here can
// only ever narrow coverage, never widen it.
var WL_ACTIONS = ["click", "type", "scroll", "navigate", "clickAt", "clickSelector", "key",
                  "hover", "select", "drag", "setValue",
                  "listTabs", "switchTab", "closeTab", "closeInactiveTabs", "openTab", "pinTab",
                  "waitFor", "fetch", "media", "captions", "frameGrab", "audioCapture"];
var WL_REVIEW_MS = 30 * 86400e3;

function lastConfirmedTs(entry) {
  return Math.max(entry.grantedAt || 0, entry.reviewedAt || 0);
}

function fmtDate(ts) {
  if (!ts) return "never";
  return new Date(ts).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function renderSites(sites, whitelist, currentSchema) {
  var list = el("sitesList");
  list.innerHTML = "";
  var countEl = el("sitesCount");
  if (countEl) {
    var nWl = Object.keys(whitelist || {}).length;
    var nBlocked = Object.keys(sites || {}).filter(function (h) { return sites[h] === "deny"; }).length;
    var due = Object.keys(whitelist || {}).filter(function (h) {
      return Date.now() - lastConfirmedTs(whitelist[h]) > WL_REVIEW_MS;
    }).length;
    countEl.textContent = nWl + " site" + (nWl === 1 ? "" : "s") + " whitelisted" +
      (due ? " · " + due + " due for review" : "") +
      (nBlocked ? " · " + nBlocked + " blocked" : "");
  }
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
    var reviewInDays = Math.ceil((lastConfirmedTs(entry) + WL_REVIEW_MS - Date.now()) / 86400e3);
    meta.textContent = "Granted " + fmtDate(entry.grantedAt) + " · Last used " + fmtDate(entry.lastUsedAt) +
      " · schema v" + (entry.schemaVersion || "?") +
      " · " + (reviewInDays > 0 ? "review due in " + reviewInDays + "d" : "review overdue") +
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
    var lastConfirmed = lastConfirmedTs(entry);
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
    btn.className = "btn btn-secondary";
    btn.textContent = "Unblock";
    btn.addEventListener("click", function () {
      api({ kind: "jbb.ui.revokeSite", host: host }).then(function () {
        toast("Unblocked: " + host);
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
    '<div class="audit-site">' + esc(e.site || "") + (e.detail ? " · " + esc(e.detail) : "") +
      (e.proposalId ? " · " + esc(e.proposalId) : "") + "</div>" +
    (plain && plain.why ? '<div class="feed-why">' + esc(plain.why) + (plain.fix ? " " + esc(plain.fix) : "") + "</div>" : "");
  return row;
}

function auditCatOf(e) {
  var cat = JBB.feedCategory(e);
  if (cat) {
    if (cat.category.indexOf("auto") === 0) return "auto";
    if (cat.category.indexOf("asked") === 0) return "asked";
    if (cat.category === "blocked") return "denied";
    if (cat.category === "failed") return "failed";
    return "allowed";
  }
  if (e.result === "denied") return "denied";
  if (e.result === "failed") return "failed";
  return "allowed";
}

function renderAudit(entries) {
  var list = el("auditList");
  list.innerHTML = "";
  var items = (entries || []).slice().reverse();
  var s = lastState || {};
  items = items.filter(function (e) {
    if (auditFilter.cat !== "all") {
      var c = auditCatOf(e);
      if (auditFilter.cat === "allowed" && c !== "allowed") return false;
      if (auditFilter.cat === "denied" && c !== "denied") return false;
      if (auditFilter.cat === "failed" && c !== "failed") return false;
      if (auditFilter.cat === "asked" && c !== "asked" && c !== "denied") return false;
      if (auditFilter.cat === "auto" && c !== "auto") return false;
    }
    if (auditFilter.site && (e.site || "").indexOf(auditFilter.site) === -1) return false;
    if (auditFilter.session === "this" && s.sessionStartedAt && (e.ts || 0) < s.sessionStartedAt) return false;
    if (auditFilter.session === "last" && s.lastSummary) {
      if ((e.ts || 0) < (s.lastSummary.startedAt || 0) || (e.ts || 0) > (s.lastSummary.endedAt || Infinity)) return false;
    }
    return true;
  });
  if (!items.length) {
    list.innerHTML = '<div class="empty">No activity matches these filters.</div>';
    return;
  }
  items.slice(0, 200).forEach(function (e) { list.appendChild(auditRow(e)); });
}

// ------------------------------------------------------------- live feed
// One feed (the Session "recent activity" and this merge — the Audit tab
// is the same truth, full-length). Rows carry the plain category, the
// grant's name for auto-allowed actions, and why + fix for failures.
function feedRowMatches(r) {
  if (feedFilter === "all") return true;
  if (feedFilter === "asked") return r.category.indexOf("asked") === 0 || r.category === "blocked";
  if (feedFilter === "auto") return r.category.indexOf("auto") === 0;
  if (feedFilter === "denied") return r.category === "asked-denied" || r.category === "blocked";
  if (feedFilter === "failed") return r.category === "failed";
  return true;
}

function renderFeed(entries) {
  var list = el("feedList");
  if (!list) return;
  list.innerHTML = "";
  // In-flight row: a proposal waiting on the user right now, with the
  // same age timer as its card.
  var pend = (lastState && lastState.pending) || [];
  pend.forEach(function (pr) {
    if (feedFilter !== "all" && feedFilter !== "asked") return;
    var row = document.createElement("div");
    row.className = "feed-row feed-live";
    row.innerHTML =
      '<div class="feed-top"><span class="feed-label cat-asked">Waiting for consent…</span>' +
      '<span class="feed-time" data-age-since="' + (pr._createdAt || Date.now()) + '">' +
      fmtAge(Date.now() - (pr._createdAt || Date.now())) + "</span></div>" +
      '<div class="feed-action">' + esc(pr.description || pr.type) + "</div>" +
      '<div class="feed-site">' + esc(hostOf(pr.site || "")) + "</div>";
    list.appendChild(row);
  });
  var rows = JBB.feedRows(entries || [], 50).filter(feedRowMatches);
  if (!rows.length && !pend.length) {
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
function renderTabs(tabs) {
  var box = el("tabsList");
  if (!box) return;
  tabs = tabs || [];
  if (!tabs.length) {
    box.innerHTML = '<p class="muted">No tab information yet.</p>';
    return;
  }
  var counts = {};
  tabs.forEach(function (t) { if (t.url) counts[t.url] = (counts[t.url] || 0) + 1; });
  box.innerHTML = "";
  tabs.forEach(function (t) {
    var row = document.createElement("div");
    row.className = "tabrow";
    var title = document.createElement("span");
    title.className = "tt";
    title.textContent = t.title || "(untitled)";
    row.appendChild(title);
    function badge(text, warn) {
      var b = document.createElement("span");
      b.className = "badge" + (warn ? " warn" : "");
      b.textContent = text;
      row.appendChild(b);
    }
    if (t.active) badge("active");
    if (t.pinned) badge("pinned");
    if (t.audible) badge("playing audio");
    if (t.url && counts[t.url] > 1) badge("duplicate ×" + counts[t.url], true);
    var url = document.createElement("div");
    url.className = "tu";
    url.textContent = t.url || "";
    row.appendChild(url);
    box.appendChild(row);
  });
}

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
  var row = document.createElement("div");
  row.className = "row";
  var startBtn = document.createElement("button");
  startBtn.className = "btn btn-primary";
  startBtn.textContent = "Start new session";
  startBtn.addEventListener("click", function () {
    api({ kind: "jbb.ui.revive" }).then(function () { toast("New session started"); refresh(); });
  });
  var auditBtn = document.createElement("button");
  auditBtn.className = "btn btn-secondary";
  auditBtn.textContent = "View full audit";
  auditBtn.addEventListener("click", function () {
    var t = document.querySelector('.tab[data-tab="audit"]');
    if (t) t.click();
  });
  row.appendChild(startBtn);
  row.appendChild(auditBtn);
  body.appendChild(row);
}

// ---------------------------------------------------------------- boot & events
function refresh() {
  api({ kind: "jbb.ui.getState" }).then(function (s) {
    if (!s || !s.ok) return;
    lastState = s;
    renderStatus(s);
    renderPlans(s.plans);
    renderNowStrip(s);
    renderMedia(s);
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
    renderCapture(s);
    renderControl(s);
    (s.planPending || []).forEach(renderPlanCard);
    el("tempGrantLine").textContent = s.tempGrant
      ? "⏳ Temporary grant: " + s.tempGrant.host + " — until you leave the site (" + fmtRemaining(s.tempGrant.remainingMs) + " at most)"
      : "";
    // Key life: countdown or usage budget, the armed state, or the
    // pre-expiry-key note. Data comes from the worker's getState mirror.
    var ke = s.keyExpiry;
    if (ke) {
      var usedStr = "Used " + fmtDur(ke.usage.connectedMs) + " connected · " + ke.usage.acts +
        " actions on this key (it retires at " + fmtDur(ke.budget.ms) + " / " + ke.budget.acts + " actions).";
      el("keyLifeLine").textContent = ke.armed
        ? "⏳ This key will expire when the current session disconnects — " + ke.armed + "."
        : !ke.hasMeta
          ? "Key expiry isn't set on this key (it predates expiry) — it applies from your next Generate or Rotate."
          : ke.expiresAt
            ? (ke.expiresAt - Date.now() > 0
                ? "Key expires in " + fmtDur(ke.expiresAt - Date.now()) + ". " + usedStr
                : "This key's lifetime has elapsed — it expires when the current session disconnects. " + usedStr)
            : "This key has no lifetime expiry. " + usedStr;
    }
    renderFeed(s.audit);
    renderSummary(s.lastSummary);
    renderTabs(s.tabs);
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
      if (typeof renderSignInBlock === "function") renderSignInBlock(msg);
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
        if (s && s.ok) { lastState = s; renderAudit(s.audit); renderFeed(s.audit); renderNowStrip(s); renderMedia(s); }
      });
      break;
    case "jbb.ui.planChanged":
      refresh();
      break;
    case "jbb.ui.consentEscalated": {
      var ecard = document.getElementById("consent-" + msg.proposalId);
      if (ecard && !ecard.querySelector(".consent-esc-line")) {
        var line = document.createElement("div");
        line.className = "consent-esc-line";
        line.textContent = "Escalated at 1:00 — chimed again with a new notification.";
        ecard.appendChild(line);
      }
      break;
    }
    case "jbb.ui.sessionSummary":
      refresh();
      break;
    case "jbb.ui.tabsChanged":
      refresh();
      break;
    case "jbb.ui.captureChanged":
      refresh();
      break;
    case "jbb.ui.takeoverChanged":
    case "jbb.ui.tempChanged":
      refresh();
      break;
    case "jbb.ui.planRequest":
      renderPlanCard(msg.plan);
      toast("Plan approval needed — see top of panel");
      break;
    case "jbb.ui.planResolved": {
      var pc = document.getElementById("plan-" + msg.planId);
      if (pc) pc.remove();
      break;
    }
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

  // Header: status detail toggle + sound icon (mirrors the Setup toggle)
  el("statusPill").addEventListener("click", function () {
    statusOpen = !statusOpen;
    if (lastState) renderStatusDetail(lastState);
  });
  el("soundBtn").addEventListener("click", function () {
    var on = !(lastState && lastState.soundOn === false);
    api({ kind: "jbb.ui.setSound", on: !on }).then(function () { refresh(); });
  });

  // Now strip controls — the same actions as the Control card / plan card.
  function stripTakeover(on) {
    api({ kind: "jbb.ui.setTakeover", on: on }).then(function () {
      toast(on ? "You have control — Muse is paused" : "Handed back — Muse resumes");
      refresh();
    });
  }
  el("nowTakeoverBtn").addEventListener("click", function () { stripTakeover(true); });
  el("nowHandbackBtn").addEventListener("click", function () { stripTakeover(false); });
  el("nowStopBtn").addEventListener("click", function () {
    var strip = el("nowStrip");
    if (strip.dataset.planId) {
      api({ kind: "jbb.ui.planStop", planId: strip.dataset.planId }).then(function () {
        toast("Plan stopped");
        refresh();
      });
    } else {
      api({ kind: "jbb.ui.endSession" }).then(function () {
        toast("Session ended");
        refresh();
      });
    }
  });

  // Activity feed chips — the choice persists for the panel session.
  document.querySelectorAll("#feedChips .chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      feedFilter = chip.getAttribute("data-feed");
      document.querySelectorAll("#feedChips .chip").forEach(function (c) {
        c.classList.toggle("active", c === chip);
      });
      if (lastState) renderFeed(lastState.audit);
    });
  });

  // Audit filters.
  document.querySelectorAll("#auditChips .chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      auditFilter.cat = chip.getAttribute("data-audit");
      document.querySelectorAll("#auditChips .chip").forEach(function (c) {
        c.classList.toggle("active", c === chip);
      });
      if (lastState) renderAudit(lastState.audit);
    });
  });
  el("auditSiteFilter").addEventListener("input", function () {
    auditFilter.site = el("auditSiteFilter").value.trim();
    if (lastState) renderAudit(lastState.audit);
  });
  el("auditSessionSel").addEventListener("change", function () {
    auditFilter.session = el("auditSessionSel").value;
    if (lastState) renderAudit(lastState.audit);
  });

  // Media mini-player: the panel's own buttons (user click = consent).
  function mediaAct(payload, doneMsg) {
    api(Object.assign({ kind: "jbb.ui.mediaAct" }, payload)).then(function (res) {
      var msg = el("mediaMsg");
      if (res && res.ok) {
        msg.textContent = res.detail || doneMsg || "";
        if (res.data && res.data.image) {
          var img = el("mediaFrame");
          img.src = res.data.image;
          img.classList.remove("hidden");
        }
        if (res.data && res.data.cues) {
          var cues = el("mediaCues");
          cues.textContent = res.data.cues.map(function (c) { return c.text; }).join("\n");
          cues.classList.remove("hidden");
        }
      } else {
        msg.textContent = "Could not: " + ((res && res.error) || "unknown error");
      }
      refresh();
    });
  }
  el("mediaPlayBtn").addEventListener("click", function () { mediaAct({ actType: "media", action: "play" }); });
  el("mediaPauseBtn").addEventListener("click", function () { mediaAct({ actType: "media", action: "pause" }); });
  el("mediaSeek").addEventListener("change", function () {
    mediaAct({ actType: "media", action: "seek", seekTo: Number(el("mediaSeek").value) });
  });
  el("mediaCapBtn").addEventListener("click", function () { mediaAct({ actType: "captions" }); });
  el("mediaGrabBtn").addEventListener("click", function () { mediaAct({ actType: "frameGrab" }); });

  // 1s ticker: age timers on consent cards + the feed's waiting rows,
  // and the driver-timeout note once a card passes the 120s window.
  setInterval(function () {
    var now = Date.now();
    document.querySelectorAll("[data-age-since]").forEach(function (node) {
      var since = Number(node.getAttribute("data-age-since"));
      if (since) node.textContent = (node.classList.contains("consent-age") ? "waiting " : "") + fmtAge(now - since);
    });
    document.querySelectorAll(".consent-card").forEach(function (card) {
      var ageEl = card.querySelector(".consent-age");
      var note = card.querySelector(".consent-driver-note");
      if (ageEl && note) {
        var since = Number(ageEl.getAttribute("data-age-since"));
        note.classList.toggle("hidden", !(since && now - since >= 120000));
      }
    });
  }, 1000);

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
    setKey(generateKey(), true, Number(el("keyTtlSelect").value));
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
    api({ kind: "jbb.ui.rotateKey", ttlMs: Number(el("keyTtlSelect").value) }).then(function (r) {
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
      chrome.storage.local.remove([K.KEY, K.KEY_ACKED, K.KEYMETA, K.KEYUSAGE], function () {
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
  el("closeInactiveBtn").addEventListener("click", function () {
    api({ kind: "jbb.ui.closeInactiveTabs" }).then(function (res) {
      if (res && res.ok) {
        el("tabsMsg").textContent = "Closed " + res.closed + " inactive tab(s); kept " + res.kept + ".";
      } else {
        el("tabsMsg").textContent = "Could not close tabs: " + ((res && res.error) || "unknown error");
      }
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
