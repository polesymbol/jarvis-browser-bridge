/**
 * Prompt 16 redesign guard tests — source-level invariants for the
 * v0.3.0 panel rebuild. Run: node extension/test/redesign.guard.test.mjs
 *
 *  - IA: Now / Sites / Audit / Setup; the Key tab is gone (Setup holds it).
 *  - The header tells the truth: connected·peer-live / reconnecting /
 *    relay-down / peer-never-joined are distinct panel states.
 *  - Readonly survives as the fourth mode segment (Pratik, 2026-11-09).
 *  - Forest Lime tokens; --line defined; no light-theme tab-row leftovers.
 *  - Escalation uses a FRESH notification ID and recreates the offscreen
 *    chime engine first — the same-ID silent re-raise is gone.
 *  - Plans are two-stage: approve ≠ start; steps hold at the gate.
 *  - Scroll results name what happened; the driver sends a direction.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const proto = fs.readFileSync(path.join(dir, "../protocol.js"), "utf8");
const panel = fs.readFileSync(path.join(dir, "../sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(dir, "../sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(dir, "../sidepanel.css"), "utf8");
const content = fs.readFileSync(path.join(dir, "../content.js"), "utf8");
const driver = fs.readFileSync(path.join(dir, "../../driver/driver.js"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

check("tabs are Now / Sites / Audit / Setup — Key tab retired into Setup",
  html.includes('data-tab="now"') && html.includes('data-tab="sites"') &&
  html.includes('data-tab="audit"') && html.includes('data-tab="setup"') &&
  !html.includes('data-tab="key"') && !html.includes('data-tab="session"') &&
  html.includes('id="tab-setup"') && html.includes('id="keyTtlSelect"'));
check("kill dock stays pinned at the bottom with its meta line",
  html.includes('id="killBtn"') && html.includes("jarvis bridge · local enforcement"));
check("header carries the mode segmented control + caption + status detail",
  html.includes('id="modeSeg"') && html.includes('id="modeCaption"') &&
  html.includes('id="statusDetail"') && html.includes('id="statusPill"'));
check("panel header states are honest and distinct",
  panel.includes("Connected · peer live") && panel.includes("Reconnecting…") &&
  panel.includes("Peer never joined") && panel.includes("Relay down") &&
  panel.includes("Paused — you're driving"));
check("Readonly is the fourth mode (protocol keeps all four modes)",
  proto.includes('"readonly"') && proto.includes('"light"') &&
  proto.includes('"balanced"') && proto.includes('"strict"') &&
  panel.includes("Object.keys(JBB.MODES)"));
check("Now strip exists with take-over / hand-back / stop reachable",
  html.includes('id="nowStrip"') && html.includes('id="nowTakeoverBtn"') &&
  html.includes('id="nowHandbackBtn"') && html.includes('id="nowStopBtn"') &&
  panel.includes("Nothing is recorded or screenshotted while you drive"));

check("Forest Lime tokens are the :root palette",
  css.includes("--bg: #0a120c") && css.includes("--ember: #84cc16") &&
  css.includes("--surface: #101b12") && css.includes("--warn: #fbbf24"));
check("--line is defined (whitelist/feed rows no longer reference a void)",
  css.includes("--line: #26382b") && css.includes("--line: #e3dac6"));
check("tab rows use panel tokens — no light-theme leftovers",
  !css.includes("border-bottom: 1px solid #eee") && !css.includes("color: #666") &&
  !css.includes("background: #eef"));

check("escalation raises under a FRESH notification id",
  bg.includes('"-esc"') && bg.includes("opts.escalation"));
check("escalation recreates the offscreen engine before chiming + audits failure",
  bg.includes("function escalateConsent(entry)") && bg.includes("ensureOffscreenDocument(fire)") &&
  bg.includes("escalation chime failed"));
check("the same-ID in-place escalation is gone from the sweep",
  !bg.includes("notifyConsent does both, same notification ID in place)"));
check("the panel learns about escalation (card line)",
  bg.includes("jbb.ui.consentEscalated") && panel.includes("consentEscalated"));

check("plans are two-stage: approval stores started:false",
  bg.includes("started: false, startedAt: 0, paused: false"));
check("plan steps HOLD at the start/pause gate (queued, never executed)",
  bg.includes("state.planHold.push") && bg.includes("PLAN START GATE"));
check("viaPlan requires a started, unpaused plan",
  bg.includes("plan.started && !plan.paused"));
check("unstarted plans release held steps after the start window",
  bg.includes("PLAN_START_WINDOW_MS = 120000") && bg.includes("flushPlanHold"));
check("panel renders the Start task gate + plan progress",
  panel.includes("Start task") && panel.includes("jbb.ui.planStart") &&
  html.includes('id="planProgress"'));

check("consent cards carry tier, domain, why, age timer, queued note",
  panel.includes("planWhyLine") && panel.includes("data-age-since") &&
  panel.includes("never auto-denied") && panel.includes("No plan context — asked on its own."));
check("T3 cards warn and the timed grants live under More options",
  panel.includes("consent-t3warn") && panel.includes("More options — timed grants"));
check("the 120s driver-timeout note exists on the card",
  panel.includes("Timed out on the driver side — still queued here"));

check("driver sends scroll direction + amount; description names it",
  driver.includes("--direction") && driver.includes("proposal.direction = direction") &&
  driver.includes("scroll ${direction}"));
check("content scroll verifies movement and never prints undefined",
  content.includes("the page did not move") && !content.includes('"scrolled " + direction'));

check("feed has filter chips and renders 50 rows; audit has combinable filters + export",
  html.includes('id="feedChips"') && panel.includes("JBB.feedRows(entries || [], 50)") &&
  html.includes('id="auditSiteFilter"') && html.includes('id="auditSessionSel"') &&
  html.includes('id="exportAuditBtn"'));
check("sites tab states the key-binding + review-due, blocked rows Unblock",
  html.includes("Grants are bound to the current connector key") &&
  panel.includes("review due in ") && panel.includes('"Unblock"'));
check("media mini-player is panel-driven (user click = consent)",
  html.includes('id="mediaCard"') && bg.includes('case "jbb.ui.mediaAct"') &&
  panel.includes("jbb.ui.mediaAct"));
check("buttons are keyboard-reachable with a visible focus ring",
  css.includes(":focus-visible") && css.includes("min-height: 40px"));

console.log(failures === 0 ? "ALL REDESIGN GUARD TESTS PASSED" : failures + " REDESIGN GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
