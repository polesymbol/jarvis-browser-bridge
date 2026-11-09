/**
 * Tab-actions guard tests.
 * Run: node extension/test/tabs.guard.test.mjs
 *
 * Invariants:
 *  - tab actions resolve ground truth BEFORE the gate (real site,
 *    active flag) and closing the viewed tab force-asks ahead of the
 *    whitelist step in decideAction;
 *  - the hard guards live in the executor: last tab in a window, and a
 *    tab that became active after its grant;
 *  - closeInactiveTabs excludes active, pinned, and audible tabs in the
 *    one shared implementation both the agent and the panel use;
 *  - the vocabulary includes the tab actions for NEW grants (background
 *    + panel mirror); the panel has the Tabs card, the close-inactive
 *    button, and duplicate detection.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const panel = fs.readFileSync(path.join(dir, "../sidepanel.js"), "utf8");
const panelHtml = fs.readFileSync(path.join(dir, "../sidepanel.html"), "utf8");
const driver = fs.readFileSync(path.join(dir, "../../driver/driver.js"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

check("tab context resolves before the verdict, duplicates gated meanwhile",
  bg.includes("resolveTabContext(proposal)") && bg.includes("state.gating.add(proposal.proposalId)") &&
  bg.includes("proceedWithVerdict(proposal)"));
const decideBody = bg.slice(bg.indexOf("function decideAction"), bg.indexOf("function decideAction") + 2600);
check("closing the viewed tab force-asks ahead of the whitelist step (inside decideAction)",
  decideBody.includes("if (proposal._forceAsk)") &&
  decideBody.indexOf('proposal.actionTier === "T3"') < decideBody.indexOf("if (proposal._forceAsk)") &&
  decideBody.indexOf("if (proposal._forceAsk)") < decideBody.indexOf("whitelistCovers(proposal, host)"));
check("session grants cannot cover the forced ask either",
  bg.includes("!proposal._forceAsk &&"));
check("executor guards: last tab + became-active",
  bg.includes("refusing to close the last tab in its window") &&
  bg.includes("now the one you're looking at"));
check("closeInactiveTabs excludes active, pinned, and audible in one shared implementation",
  bg.includes("!t.active && !t.pinned && !t.audible") &&
  bg.includes('case "jbb.ui.closeInactiveTabs"') && bg.includes("closeInactiveTabsNow()"));
check("act results can carry structured data (the tab list)",
  bg.includes("out && out.data") && fs.readFileSync(path.join(dir, "../protocol.js"), "utf8").includes("if (data !== undefined) m.data = data"));
check("vocabulary covers tab actions in background + panel mirror",
  bg.includes('"listTabs", "switchTab", "closeTab", "closeInactiveTabs", "openTab", "pinTab"') &&
  panel.includes('"listTabs", "switchTab", "closeTab", "closeInactiveTabs", "openTab", "pinTab"'));
check("driver defaults tab actions to T2 and validates --tab-id",
  driver.includes("isTabType || type === 'fetch' ? 'T2' : 'T1'") && driver.includes("--tab-id must be a number"));
check("panel: Tabs card, close-inactive button, duplicate badges",
  panelHtml.includes('id="tabsList"') && panelHtml.includes('id="closeInactiveBtn"') &&
  panel.includes("duplicate ×") && panel.includes("renderTabs(s.tabs)"));

console.log(failures === 0 ? "ALL TAB GUARD TESTS PASSED" : failures + " TAB GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
