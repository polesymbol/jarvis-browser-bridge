/**
 * wait_for / fetch_in_page / media-streaming guard tests.
 * Run: node extension/test/wait-fetch.guard.test.mjs
 *
 * Invariants:
 *  - fetch refuses non-HTTPS in code, sends credentials ONLY to the
 *    page's own origin, and caps both the read and the wire body;
 *  - wait_for is bounded (hard max), always resolves, and the driver's
 *    result budget covers the declared wait;
 *  - media progress is forwarded only from real tab senders, only while
 *    connected, and is never audited/stored;
 *  - fetch is T2 by default in the driver and both new types are in the
 *    whitelist vocabulary for new grants.
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

check("fetch refuses non-HTTPS in code",
  content.includes('throw new Error("refusing to fetch a non-HTTPS URL ("'));
check("credentials follow the origin rule (include same-origin, omit cross-origin)",
  content.includes('credentials: sameOrigin ? "include" : "omit"'));
check("fetch caps the read (~5 MB) and the wire body (relay ceiling)",
  content.includes("FETCH_READ_CAP = 5000000") && content.includes("FETCH_WIRE_CAP = 512000"));
check("wait_for is hard-bounded and resolves either way",
  content.includes("WAIT_MAX_MS = 120000") && content.includes("matched: false, condition:"));
check("media watcher lives in the top frame and reports on a ~10s cadence + events",
  content.includes("setInterval(scanMediaProgress, 10000)") && content.includes('"jbb.media.progress"'));
check("background forwards media progress only from tab senders, only while connected",
  bg.includes('if (msg.kind === "jbb.media.progress")') && bg.includes("if (!sender || !sender.tab) return false") &&
  bg.includes("state.connected && !state.sessionKilled"));
check("protocol carries media.progress as a live-only message",
  proto.includes('base("media.progress", fields || {})'));
check("driver: fetch defaults T2, waitFor is validated, watch streams, result budget covers waits",
  driver.includes("type === 'fetch' ? 'T2' : 'T1'") || driver.includes("isTabType || type === 'fetch' ? 'T2' : 'T1'") &&
  driver.includes("tmo < 250 || tmo > 120000") &&
  driver.includes("CMD === 'watch'") && driver.includes("(proposal.timeoutMs || 0) + 20000"));
check("vocabulary covers waitFor + fetch for new grants (background + panel)",
  bg.includes('"waitFor", "fetch"') &&
  fs.readFileSync(path.join(dir, "../sidepanel.js"), "utf8").includes('"waitFor", "fetch"'));

console.log(failures === 0 ? "ALL WAIT/FETCH GUARD TESTS PASSED" : failures + " WAIT/FETCH GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
