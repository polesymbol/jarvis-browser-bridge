/**
 * Stable-targeting guard tests.
 * Run: node extension/test/stable.targeting.guard.test.mjs
 *
 * Invariants (Pratik's brief, 2026-11-09):
 *  - Element identity is a stable id stamped on the element itself
 *    (data-jbb-id), never a snapshot position: the positional REF_ATTR
 *    model is gone from the content script.
 *  - The background refuses an act whose declared snapshot version has
 *    moved (STALE_SNAPSHOT) BEFORE consent, and bumps the version on
 *    every observe and every applied act.
 *  - Label normalization (zero-width strip, NBSP -> space) exists in all
 *    three copies — protocol.js (canonical), content.js, driver.js —
 *    with the same character classes.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const content = fs.readFileSync(path.join(dir, "../content.js"), "utf8");
const bg = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const proto = fs.readFileSync(path.join(dir, "../protocol.js"), "utf8");
const driver = fs.readFileSync(path.join(dir, "../../driver/driver.js"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

// ---------------------------------------------------------- stable ids
check("content: stable id attribute is data-jbb-id", content.includes('ID_ATTR = "data-jbb-id"'));
check("content: positional ref model is gone", !content.includes("REF_ATTR") && !content.includes("data-jbb-ref"));
check("content: ids come from a forward-only counter, adopted when already stamped",
  content.includes("nextIdNum++") && content.includes("stableIdFor"));
check("content: lookup checks the registry before querying the DOM",
  content.includes("idRegistry[ref]"));

// ---------------------------------------------------------- versioning + stale refusal
check("background: stale check runs before the consent gate",
  bg.indexOf('"STALE_SNAPSHOT"') !== -1 &&
  bg.indexOf("proposal.snapshotVersion !== state.snapshotVersion") !== -1 &&
  bg.indexOf("proposal.snapshotVersion !== state.snapshotVersion") < bg.indexOf("var verdict = decideAction(proposal);"));
check("background: version bumps on observe and on applied acts",
  (bg.match(/state\.snapshotVersion\+\+/g) || []).length >= 2);
check("background: observe carries the version on message and snapshot",
  bg.includes("msg.snapshotVersion = v") && bg.includes("snap.snapshotVersion = v"));
check("protocol: actResult can carry error + snapshotVersion",
  proto.includes("if (error) m.error = error;") && proto.includes("m.snapshotVersion = snapshotVersion"));

// ---------------------------------------------------------- driver plumbing
check("driver: --snapshot-version is parsed into the proposal",
  driver.includes("--snapshot-version") && driver.includes("proposal.snapshotVersion = sv"));
check("driver: STALE_SNAPSHOT gets the structured non-zero surface",
  driver.includes("msg.error === 'STALE_SNAPSHOT'") && driver.includes("error: 'STALE_SNAPSHOT'"));

// ---------------------------------------------------------- normalization: three copies, one behavior
for (const [name, src] of [["protocol", proto], ["content", content], ["driver", driver]]) {
  check(name + ": normalizeLabel strips zero-width + NBSP classes",
    src.includes("normalizeLabel") && src.includes("\\u200B-\\u200D\\uFEFF") && src.includes("\\u00A0\\u202F"));
}
// The canonical implementation, executed: invisible characters must not
// survive, and a visible-text label must match its dirty twin.
const sandbox = { console };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(proto, sandbox, { filename: "protocol.js" });
const n = sandbox.JBB.normalizeLabel;
check("canonical normalizeLabel: 'Les\\u200Bson\\u00A03' === 'Lesson 3'",
  n("Les\u200Bson\u00A03") === "Lesson 3" && n("  a \u202F b ") === "a b" && n(null) === "");

console.log(failures === 0 ? "ALL STABLE-TARGETING GUARD TESTS PASSED" : failures + " GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
