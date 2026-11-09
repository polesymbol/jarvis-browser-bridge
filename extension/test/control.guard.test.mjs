/**
 * Control guard tests (Prompt 15): levels, take-over, plans, temporary
 * grants. Run: node extension/test/control.guard.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const proto = fs.readFileSync(path.join(dir, "../protocol.js"), "utf8");
const panel = fs.readFileSync(path.join(dir, "../sidepanel.js"), "utf8");
const panelHtml = fs.readFileSync(path.join(dir, "../sidepanel.html"), "utf8");
const driver = fs.readFileSync(path.join(dir, "../../driver/driver.js"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

check("levels exist as the mode presets (Light/Balanced/Strict + Readonly)",
  proto.includes('"light"') && proto.includes('"balanced"') && proto.includes('"strict"') &&
  proto.includes("Balanced (recommended)"));
const decideBody = bg.slice(bg.indexOf("function decideAction"), bg.indexOf("function decideAction") + 3600);
check("the gate: T3 and _forceAsk ask BEFORE the Light allow and the whitelist",
  decideBody.indexOf('proposal.actionTier === "T3"') < decideBody.indexOf('state.mode === "light"') &&
  decideBody.indexOf("if (proposal._forceAsk)") < decideBody.indexOf("whitelistCovers(proposal, host)") &&
  decideBody.indexOf('state.mode === "light"') < decideBody.indexOf("whitelistCovers(proposal, host)"));
check("Strict short-circuits to ask before the whitelist step",
  decideBody.indexOf('state.mode === "strict"') < decideBody.indexOf("whitelistCovers(proposal, host)"));
check("temporary grant: choice wired, nav-away + time expiry in code, says so at creation",
  bg.includes('"untilLeave": 1') && bg.includes("until you leave this site or 15 minutes pass") &&
  bg.includes('expireTemp("you left "') && panel.includes('data-choice="untilLeave"'));
check("take-over: proposals hold with queued heartbeats, hand-back replays via handleProposal",
  bg.includes("state.holdQueue.push") && bg.includes("proposalQueued") &&
  bg.includes("q.forEach(function (h) { handleProposal(h.proposal") &&
  bg.includes('case "jbb.ui.setTakeover"') && panelHtml.includes('id="takeoverBtn"'));
check("plans: bounded at 20 steps, per-site, T3 excluded from the plan layer",
  bg.includes("PLAN_MAX_STEPS = 20") && bg.includes("plan.sites.indexOf(hostOf(proposal.site") &&
  bg.includes("proposal.actionTier !== \"T3\"") && bg.includes('case "jbb.ui.planResolve"') &&
  driver.includes("PLAN_DENIED") && driver.includes("CMD === 'plan'"));
check("driver pump waits through take-over instead of timing out",
  driver.includes("'proposal.queued'") && driver.includes("[queued] user has taken over"));
check("the audit feed names plan/temp/level authorizations",
  proto.includes("Auto-allowed by approved plan") && proto.includes("Auto-allowed by temporary grant") &&
  proto.includes("Auto-allowed by Light level"));

console.log(failures === 0 ? "ALL CONTROL GUARD TESTS PASSED" : failures + " CONTROL GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
