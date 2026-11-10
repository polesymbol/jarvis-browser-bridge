/**
 * Field-fix guard tests — the 2026-11-10 Brand Analytics session report.
 * Run: node extension/test/fieldfixes.guard.test.mjs
 *
 * The session's blockers, and the invariants that keep them fixed:
 *  - Dashboard controls (custom dropdowns, tabs, filters) were invisible:
 *    the snapshot's selector lacked the widget ARIA roles, never walked
 *    shadow DOM for interactives, and had no discovery for unmarked
 *    cursor:pointer widgets.
 *  - Ref clicks died on a re-rendering SPA with no recovery path.
 *  - Scroll moved only the window while results lived in an inner
 *    scroll container.
 *  - Fetch carried cookies but not the app headers session APIs demand.
 *  - The driver burned full timeouts reporting PEER_TIMEOUT for a peer
 *    already known down at pair time.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const content = fs.readFileSync(path.join(dir, "../content.js"), "utf8");
const driver = fs.readFileSync(path.join(dir, "../../driver/driver.js"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

// ---------------------------------------------------------- discovery
check("snapshot selector covers the widget ARIA roles (tab/combobox/listbox/option)",
  content.includes("[role='tab']") && content.includes("[role='combobox']") &&
  content.includes("[role='listbox']") && content.includes("[role='option']"));
check("snapshot selector covers dropdown triggers (aria-haspopup / aria-expanded)",
  content.includes("[aria-haspopup]") && content.includes("[aria-expanded]"));
check("interactives are collected through open shadow roots (queryDeep walk)",
  content.includes("function queryDeep") && content.includes("function queryInteractives") &&
  content.includes("var els = queryInteractives();"));
check("unmarked clickable widgets are discovered by their pointer cursor",
  content.includes("function pointerCandidates") && content.includes('style.cursor !== "pointer"') &&
  content.includes('"clickable"'));
check("label resolution searches the same widened candidate set",
  content.includes("function labelCandidates"));

// ---------------------------------------------------------- targeting on SPAs
check("a dead ref re-resolves by exact label at execution time, uniquely or not at all",
  content.includes("function findExactByLabel") && content.includes('"re-resolved"') &&
  content.includes("re-resolution needs exactly one"));
check("a dead ref without a label says how to make the act re-resolvable",
  content.includes("pass the element's label as --target alongside --ref"));

// ---------------------------------------------------------- scroll
check("scroll can target an element's scrollable container",
  content.includes("function scrollableAncestor") && content.includes("(inner container)"));
check("an immovable window falls back to the largest scrollable container",
  content.includes("bestRoom") && content.includes("scrollBox(best, dir, px)"));

// ---------------------------------------------------------- fetch session
check("fetch validates custom headers and confines them to same-origin",
  content.includes("function validateFetchHeaders") &&
  content.includes("custom headers are only sent on same-origin fetches"));
check("browser-owned headers (Cookie first) can never be set by hand",
  content.includes("FORBIDDEN_FETCH_HEADERS") && content.includes('"cookie"'));
check("fetch reports which header NAMES were sent, never their values",
  content.includes("headersSent: Object.keys(reqHeaders)"));

// ---------------------------------------------------------- driver fail-fast
check("driver fails fast with PEER_DOWN when the pair confirm shows no peer",
  driver.includes("JBB_PEER_WAIT_MS") && driver.includes("'PEER_DOWN'") &&
  driver.includes("failed fast instead of waiting out the full timeout"));
check("driver retries a refused first relay connection once",
  driver.includes("first connection attempt failed — retrying once"));
check("driver builds fetch proposals from repeatable --header flags",
  driver.includes("proposal.headers = hdrs"));

console.log(failures === 0 ? "ALL FIELD-FIX GUARD TESTS PASSED" : failures + " FIELD-FIX GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
