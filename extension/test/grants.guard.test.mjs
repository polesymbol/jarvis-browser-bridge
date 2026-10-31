// Guard test for the grant invariants in extension/background.js — run:
//   node extension/test/grants.guard.test.mjs
// These are source-level guards for the rules that must NEVER regress:
//   1. T3 (critical) actions are decided BEFORE any site/session grant can
//      auto-allow — a grant must never cover a critical action.
//   2. The session-grant fast path in handleProposal excludes T3 explicitly.
//   3. Custom "until" grants validate their expiry and fail closed.
// If a refactor breaks the ordering, this test fails before a user gets hurt.
import fs from "node:fs";

const src = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const checks = [];
function check(name, ok) { checks.push([name, !!ok]); }

// 1. Inside decideAction, the T3 rule precedes the trusted-site allow.
const decide = src.slice(src.indexOf("function decideAction"), src.indexOf("function hostOf") > 0 ? src.length : src.length);
const t3Pos = decide.indexOf('proposal.actionTier === "T3"');
const siteAllowPos = decide.indexOf('state.sites[host] === "allow"');
check("decideAction: T3 asks before site-allow applies", t3Pos !== -1 && siteAllowPos !== -1 && t3Pos < siteAllowPos);

// 2. Session fast path excludes T3.
check("handleProposal: session grant excludes T3",
  src.includes('proposal.actionTier !== "T3"') && src.includes("sessionAllows(proposal)"));

// 3. Custom expiry validated + fail-closed deny path present.
check("custom grant validates expiry window",
  src.includes('"sessionCustom"') && src.includes("31 * 86400e3") && src.includes("invalid custom grant expiry"));

// 4. All grant choices are whitelisted (unknown choices deny).
check("consent choices whitelisted incl. 1 week + custom",
  src.includes('"session1w": 1') && src.includes('"sessionCustom": 1') && src.includes("VALID_CHOICES"));

let fail = 0;
for (const [name, ok] of checks) { console.log((ok ? "PASS" : "FAIL") + " " + name); if (!ok) fail++; }
process.exit(fail ? 1 : 0);
