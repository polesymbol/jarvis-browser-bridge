// Guard test for the consent-lifecycle acknowledgements — run:
//   node extension/test/consent.lifecycle.guard.test.mjs
// Source-level guards for the rules that must NEVER regress:
//   1. proposal.received is sent, and dedupe is checked, BEFORE the gate
//      decides — a duplicate act id can never reach execution twice.
//   2. consent.shown is sent only from markConsentShown, whose only callers
//      are the panel-render ack and the banner-visibility confirmation.
//   3. The waiting heartbeat exists (~10s) and the 60s escalation fires once.
//   4. A consent timeout NEVER resolves to deny — the proposal stays queued.
import fs from "node:fs";

const bg = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const proto = fs.readFileSync(new URL("../protocol.js", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
const checks = [];
function check(name, ok) { checks.push([name, !!ok]); }
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a + from.length) : src.length;
  return a === -1 ? "" : src.slice(a, b === -1 ? src.length : b);
}

// Protocol builders for the three new lifecycle messages.
check("protocol: proposal.received builder", proto.includes('base("proposal.received"'));
check("protocol: consent.shown builder", proto.includes('base("consent.shown"'));
check("protocol: consent.waiting builder", proto.includes('base("consent.waiting"'));

// handleProposal ordering: dedupe lookup and the receipt both precede the gate.
const hp = slice(bg, "function handleProposal", "function resolveConsent");
check("handleProposal: dedupe (actResults) checked before decideAction",
  hp.indexOf("actResults.get(proposal.proposalId)") !== -1 &&
  hp.indexOf("actResults.get(proposal.proposalId)") < hp.indexOf("decideAction(proposal)"));
check("handleProposal: duplicate pending/executing ids short-circuit",
  hp.includes("state.pending.has(proposal.proposalId)") && hp.includes("state.executing.has(proposal.proposalId)"));
check("handleProposal: proposal.received sent before decideAction",
  hp.indexOf("proposalReceived(proposal.proposalId)") !== -1 &&
  hp.indexOf("proposalReceived(proposal.proposalId)") < hp.indexOf("decideAction(proposal)"));

// Executed results are recorded (the dedupe store writers).
const ep = slice(bg, "function executeProposal", "function runOnPage");
check("executeProposal: results recorded for both outcomes",
  (ep.match(/recordActResult\(proposal\.proposalId/g) || []).length >= 2);
check("executeProposal: executing set guards in-flight duplicates",
  ep.includes("state.executing.add(proposal.proposalId)"));

// consent.shown discipline.
check("markConsentShown sends consent.shown exactly once per proposal",
  bg.includes("function markConsentShown") && bg.includes("if (!entry || entry.shown) return;"));
check("shown via banner only on confirmed visibility",
  bg.includes('markConsentShown(proposal.proposalId, "banner")') &&
  bg.includes("results[0].result === true"));
check("shown via panel render ack",
  bg.includes('markConsentShown(msg.proposalId, "panel")') &&
  panel.includes('kind: "jbb.ui.consentShown"'));
const banner = slice(bg, "function jbbConsentBanner", "function showBannerConsent");
check("banner func returns visibility confirmation", banner.includes("return true;"));

// Heartbeat + escalation.
check("heartbeat sweep runs every ~10s while a prompt waits",
  bg.includes("setInterval(consentHeartbeatSweep, 10000)") &&
  bg.includes("JBB.Message.consentWaiting(proposalId, waited)"));
check("heartbeat also swept on the keepalive alarm (worker suspensions)",
  (bg.match(/consentHeartbeatSweep/g) || []).length >= 3);
check("60s escalation fires once: re-raise + badge flash",
  bg.includes("waited >= 60000 && !entry.escalated") &&
  bg.includes("function flashBadge"));

// No deny-and-forget.
check("consent timeout never auto-denies (old deny-on-timeout is gone)",
  !bg.includes('"consent timed out"') && bg.includes("remains queued"));
const hp2 = slice(bg, "function hydratePendings", "// ---------------------------------------------------------------- universal consent prompt");
check("hydration re-tracks elapsed proposals instead of dropping them",
  !hp2.includes("unpersistPending(id)") || hp2.includes("trackPending(rec.proposal, remaining, rec.createdAt)"));

let fail = 0;
for (const [name, ok] of checks) { console.log((ok ? "PASS" : "FAIL") + " " + name); if (!ok) fail++; }
process.exit(fail ? 1 : 0);
