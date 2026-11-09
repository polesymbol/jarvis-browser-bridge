/**
 * Whitelist guard tests.
 * Run: node extension/test/whitelist.guard.test.mjs
 *
 * Source-level invariants for the per-site whitelist (the careful
 * "Always allow on this site"):
 *  - T3 is carved out in code in BOTH directions: the writer refuses to
 *    persist a T3 tier, and the coverage check refuses T3 proposals —
 *    on top of decideAction asking T3 before the whitelist is consulted.
 *  - Coverage requires exact-domain match, current schemaVersion, and
 *    the current key epoch; entries carry tier + concrete action lists.
 *  - Rotation deletes the store; legacy blanket allows migrate in.
 *  - The panel offers the whitelist choice for T1 proposals only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const panel = fs.readFileSync(path.join(dir, "../sidepanel.js"), "utf8");
const panelHtml = fs.readFileSync(path.join(dir, "../sidepanel.html"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

check("writer refuses T3 (no T3 entry can ever be persisted)",
  bg.includes('function grantWhitelist(host, tier)') && bg.includes('if (!host || tier === "T3") return null;'));
check("coverage refuses T3 proposals (second lock)",
  bg.includes('if (!host || proposal.actionTier === "T3") return null; // hard carve-out'));
check("coverage requires current schemaVersion and key epoch",
  bg.includes("e.schemaVersion !== WHITELIST_SCHEMA") && bg.includes("e.keyId !== state.keyEpoch"));
check("coverage requires the tier AND the concrete action type",
  bg.includes("e.tiers.indexOf(proposal.actionTier)") && bg.includes("e.actions.indexOf(proposal.type)"));
check("entries are exact-domain (host equality, no wildcard creation)",
  bg.includes("var wl = whitelistCovers(proposal, host);") && !bg.includes('"*." +'));
check("audit annotation names the whitelist and domain",
  bg.includes('"allowed by whitelist: " + wl.domain') && bg.includes('" [allowed by whitelist: "'));
check("rotation wipes the whitelist store outright",
  bg.includes("state.whitelist = {};") && bg.includes("chrome.storage.local.remove([K.WHITELIST]);"));
check("legacy blanket site-allows migrate into whitelist entries",
  bg.includes("migrated: true") && bg.includes('if (state.sites[host] !== "allow") return;'));
check("resolveConsent routes 'whitelist' and legacy 'site' through grantWhitelist",
  bg.includes('answer.choice === "whitelist" || answer.choice === "site"') &&
  bg.includes('"whitelist": 1'));
check("panel: 'Always allow on this site' is offered for T1 only",
  panel.includes('data-choice="whitelist">Always allow on this site') &&
  panel.includes('proposal.actionTier === "T1"'));
check("panel: grants line counts whitelist entries",
  panel.includes("Object.keys(s.whitelist || {}).length"));

// ------------------------------------------------------------- manager (v0.2.22)
check("pause switch gates BOTH auto-allow paths (whitelist + session)",
  bg.includes("if (state.grantsPaused) return null; // master pause") &&
  bg.includes("!state.grantsPaused &&"));
check("manager handlers exist (add / update / keep / revoke-all / pause)",
  bg.includes('case "jbb.ui.addWhitelist"') && bg.includes('case "jbb.ui.updateWhitelist"') &&
  bg.includes('case "jbb.ui.keepWhitelist"') && bg.includes('case "jbb.ui.revokeAllWhitelist"') &&
  bg.includes('case "jbb.ui.setGrantsPaused"'));
check("typed domains are normalized and wildcards refused",
  bg.includes("function normalizeDomain(raw)") && bg.includes('d.indexOf("*") !== -1'));
check("punycode adds are gated behind an explicit confirm",
  bg.includes('warning: "punycode"') && bg.includes("!msg.confirmed"));
check("manager update sanitizes tiers to T1/T2 and actions to the known vocabulary",
  bg.includes('.filter(function (t) { return t === "T1" || t === "T2"; })') &&
  bg.includes("WHITELIST_ACTIONS_V1.indexOf(a) !== -1"));
check("Keep re-confirms: schema upgrade + review clock restart",
  bg.includes("kEntry.schemaVersion = WHITELIST_SCHEMA") && bg.includes("kEntry.reviewedAt = Date.now()"));
check("panel: manager surface (pause, add, review prompt, schema warning, revoke all)",
  panelHtml.includes("Pause all grants") && panel.includes("Still want Muse to have") &&
  panel.includes("Review needed — new action types are not covered") &&
  panel.includes("jbb.ui.revokeAllWhitelist") && panel.includes('data-choice="whitelist"') &&
  panel.includes('proposal.actionTier === "T2"'));

console.log(failures === 0 ? "ALL WHITELIST GUARD TESTS PASSED" : failures + " WHITELIST GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
