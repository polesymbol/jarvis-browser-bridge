/**
 * Snapshot-enrichment guard tests.
 * Run: node extension/test/enrichment.guard.test.mjs
 *
 * Invariants (Pratik's brief, 2026-11-09 — "Prompt 6"):
 *  - Snapshot text is paginated (text_chunk / text_offset /
 *    text_total_chars / text_next_offset), default chunk cap unchanged;
 *    password values are still never read into a snapshot.
 *  - Interactives carry href / box / inViewport; snapshots carry scroll
 *    state with a contentChanged flag.
 *  - Fuzzy label matching exists ONLY as the ref-less fallback, reports
 *    matchQuality, and ambiguous matches fail closed.
 *  - clickAt / clickSelector exist as fallback act types on both the
 *    content side and the driver side; observe --text-offset plumbs
 *    through the background to the snapshot builder.
 */
import fs from "node:fs";
import path from "node:path";
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

// ---------------------------------------------------------- pagination + fields
check("content: pagination fields are produced",
  content.includes("text_chunk: chunk") && content.includes("text_total_chars: fullText.length") &&
  content.includes("text_next_offset"));
check("content: default chunk cap raised to 30000 (Fix 6 — a 26k page reads in one observe)",
  content.includes("var TEXT_CAP = 30000;"));
check("content: interactives carry href, box, inViewport",
  content.includes("href: hrefFor(el)") && content.includes("box: geo.box") && content.includes("inViewport: geo.inViewport"));
check("content: scroll state + contentChanged signature",
  content.includes("contentChanged: contentChanged") && content.includes("pageSignature"));
check("content: password values still excluded from labels",
  content.includes("isPassword") && content.includes('(!isPassword && el.value)'));

// ---------------------------------------------------------- fuzzy + fallbacks
check("content: fuzzy fallback exists with quality reporting",
  content.includes("function findByLabel(query)") && content.includes('matchQuality: "fuzzy"') &&
  content.includes('matchQuality: "exact"'));
check("content: ambiguous fuzzy match fails closed",
  content.includes("fuzzy-matches") && content.includes("use a stable ref or a longer label"));
check("content: ref-based verification stays exact (fuzzy is fallback-only)",
  content.includes("normalizeLabel(labelFor(el)) !== normalizeLabel(expectedLabel)"));
check("content: clickAt uses elementFromPoint; clickSelector uses querySelector",
  content.includes("document.elementFromPoint(point.x, point.y)") && content.includes("function doClickSelector(selector)"));

// ---------------------------------------------------------- plumbing
check("background: observe offset reaches the snapshot builder via args",
  bg.includes("args: [observeOpts]") && bg.includes("textOffset: msg.textOffset"));
check("background: matchQuality rides the act.result",
  bg.includes("out && out.matchQuality") && proto.includes("if (matchQuality) m.matchQuality = matchQuality;"));
check("driver: --text-offset, clickAt, clickSelector are wired",
  driver.includes("--text-offset") && driver.includes("proposal.point = { x, y }") &&
  driver.includes("proposal.selector = selector"));

console.log(failures === 0 ? "ALL ENRICHMENT GUARD TESTS PASSED" : failures + " ENRICHMENT GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
