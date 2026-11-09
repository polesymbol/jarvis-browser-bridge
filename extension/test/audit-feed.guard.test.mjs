/**
 * Audit-feed / session-summary guard tests.
 * Run: node extension/test/audit-feed.guard.test.mjs
 *
 * Invariants:
 *  - the feed is a panel-side rendering of the on-machine audit log:
 *    background pushes auditAppended on every write, nothing about the
 *    feed or summary is ever sent to the relay (no sendToRelay in the
 *    summary builder);
 *  - finished-action audit entries carry type / proposalId / via so the
 *    feed can tell one row per action with its true authorization path;
 *  - session end is hooked at every exit (End session, disconnect,
 *    remote abort, kill switch) and the summary builds at most once
 *    per session window;
 *  - the panel has the feed card, the summary card, and the End session
 *    button, and renders through the shared JBB.feedRows.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const proto = fs.readFileSync(path.join(dir, "../protocol.js"), "utf8");
const panel = fs.readFileSync(path.join(dir, "../sidepanel.js"), "utf8");
const panelHtml = fs.readFileSync(path.join(dir, "../sidepanel.html"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

check("audit writes push a live panel update",
  bg.includes('pushToPanel({ kind: "jbb.ui.auditAppended", entry: entry })'));
check("executed/denied entries carry type, proposalId and via",
  bg.includes("type: proposal.type, proposalId: proposal.proposalId, via: proposal._via || \"consent\"") &&
  bg.includes('via: "consent"') && bg.includes('via: "blocked"'));
check("the summary builder reads only the local audit log and stores locally",
  bg.includes("function buildSessionSummary(done)") &&
  bg.includes("chrome.storage.local.set({ [K.SUMMARY]: summary })") &&
  !bg.slice(bg.indexOf("function buildSessionSummary"), bg.indexOf("function buildSessionSummary") + 2600).includes("sendToRelay"));
check("summary builds at most once per session window",
  bg.includes("state.summaryBuiltFor === since"));
check("every session exit builds the summary (end / disconnect / abort / kill)",
  bg.includes('case "jbb.ui.endSession"') &&
  (bg.match(/buildSessionSummary\(\)/g) || []).length >= 3);
check("pairing opens a fresh session window and retires the old summary",
  bg.includes("state.sessionStartedAt = Date.now()") && bg.includes("chrome.storage.local.remove([K.SUMMARY])"));
check("protocol exports the shared feed language",
  proto.includes("feedRows: feedRows") && proto.includes("plainReason: plainReason") &&
  proto.includes("Auto-allowed by whitelist: "));
check("panel: feed card, summary card, End session button exist and render via JBB.feedRows",
  panelHtml.includes('id="feedList"') && panelHtml.includes('id="summaryCard"') &&
  panelHtml.includes('id="endSessionBtn"') && panel.includes("JBB.feedRows(entries || [], 50)") &&
  panel.includes("renderSummary(s.lastSummary)"));

console.log(failures === 0 ? "ALL AUDIT FEED GUARD TESTS PASSED" : failures + " AUDIT FEED GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
