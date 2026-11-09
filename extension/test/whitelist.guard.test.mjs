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

console.log(failures === 0 ? "ALL WHITELIST GUARD TESTS PASSED" : failures + " WHITELIST GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
