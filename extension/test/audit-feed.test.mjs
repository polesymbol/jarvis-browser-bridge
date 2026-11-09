/**
 * Audit-feed unit tests — the shared categorization in protocol.js.
 * Run: node extension/test/audit-feed.test.mjs
 *
 * Proves:
 *  - finished actions become feed rows (one per action), newest first,
 *    capped at the limit; verdict intermediates and bookkeeping entries
 *    (no proposalId) never reach the feed;
 *  - categories speak plainly: allowed / asked-granted / asked-denied /
 *    auto-allowed-by-whitelist (with the EXACT granting domain) /
 *    blocked / failed;
 *  - denied and blocked rows carry a plain-language why + what would
 *    allow it.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const protoSrc = fs.readFileSync(path.join(dir, "../protocol.js"), "utf8");
const sandbox = { console };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(protoSrc, sandbox, { filename: "protocol.js" });
const JBB = sandbox.JBB;

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

const E = (over) => Object.assign({
  ts: 1000, site: "https://example.com/page", action: "click 'X'", type: "click",
  tier: "T1", result: "executed", detail: "clicked 'X'", proposalId: "p-1", via: "consent",
}, over);

const entries = [
  E({ proposalId: "a", ts: 1000 }),                                                        // asked-granted
  E({ proposalId: "b", ts: 2000, via: "whitelist", type: "type", action: "type into 'Search'",
      detail: "typed [allowed by whitelist: example.com]" }),                              // auto-whitelist
  E({ proposalId: "c", ts: 3000, result: "denied", via: "consent", detail: "user denied" }), // asked-denied
  E({ proposalId: "d", ts: 4000, result: "denied", via: "blocked", detail: "site is blocked" }), // blocked
  E({ proposalId: "e", ts: 5000, result: "denied", via: "blocked",
      detail: "stale snapshot: act built against v1, current snapshot is v2 — re-observe and rebuild the act" }), // blocked (stale)
  E({ proposalId: "f", ts: 6000, result: "awaiting consent" }),                             // intermediate — excluded
  E({ proposalId: "g", ts: 7000, result: "allowed", detail: "session grant (30m left)" }),  // intermediate — excluded
  { ts: 8000, site: "-", action: "session paired", tier: "T0", result: "allowed", detail: "protocol 1" }, // bookkeeping — excluded
];
const rows = JBB.feedRows(entries, 10);
check("exactly the 5 finished actions appear", rows.length === 5);
check("newest first", rows[0].ts === 5000 && rows[4].ts === 1000);
check("asked-granted label", rows.some((r) => r.category === "asked-granted" && r.label === "Asked — you approved"));
const wl = rows.find((r) => r.category === "auto-whitelist");
check("auto-allowed row names the exact granting domain",
  !!wl && wl.label === "Auto-allowed by whitelist: example.com");
const denied = rows.find((r) => r.category === "asked-denied");
check("asked-denied carries the plain reason",
  !!denied && denied.why === "You denied this action." && /Approve it next time/.test(denied.fix));
const blocked = rows.find((r) => r.ts === 4000);
check("blocked row explains the block list and the fix",
  !!blocked && blocked.category === "blocked" && /block list/.test(blocked.why) && /Sites tab/.test(blocked.fix));
const stale = rows.find((r) => r.ts === 5000);
check("stale-snapshot refusal explains itself in plain language",
  !!stale && /page changed after Muse looked/.test(stale.why));

// cap + failure category
const many = [];
for (let i = 0; i < 12; i++) many.push(E({ proposalId: "m" + i, ts: 100 + i }));
check("feed caps at the limit", JBB.feedRows(many, 10).length === 10);
const fail = JBB.feedRows([E({ proposalId: "z", result: "failed", detail: "no active tab" })], 10);
check("failed actions show as Didn't work with the cause",
  fail.length === 1 && fail[0].category === "failed" && /no active tab/.test(fail[0].why));

console.log(failures === 0 ? "ALL AUDIT FEED TESTS PASSED" : failures + " AUDIT FEED CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
