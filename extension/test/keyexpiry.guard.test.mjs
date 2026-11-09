/**
 * Key-expiry guard tests (v0.2.33) — source-level invariants.
 * Run: node extension/test/keyexpiry.guard.test.mjs
 *
 *  - Expiry is enforced locally in the worker (the architecture rule:
 *    enforcement lives in the extension, never the relay).
 *  - It NEVER fires mid-task: a peer's presence only arms it.
 *  - Expiry (hygiene) and rotation (distrust) differ exactly where the
 *    design says: expiry drops session/temp grants and keeps the
 *    whitelist; rotation wipes the whitelist too.
 *  - The panel offers the lifetime choice and renders the key's life.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const panel = fs.readFileSync(path.join(dir, "../sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(dir, "../sidepanel.html"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

function section(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a === -1) return "";
  const b = src.indexOf(endMarker, a + startMarker.length);
  return src.slice(a, b === -1 ? undefined : b);
}

check("expiry state is stored (meta / usage / expired marker)",
  bg.includes('"jbb.keyMeta"') && bg.includes('"jbb.keyUsage"') && bg.includes('"jbb.keyExpired"'));
check("big-task budget constants match the brief (5h / 200 acts)",
  bg.includes("KEY_BIG_TASK_MS = 5 * 60 * 60 * 1000") && bg.includes("KEY_BIG_TASK_ACTS = 200"));
check("the keepalive alarm drives expiry checks",
  bg.includes("foldPeerTime();") && bg.includes("checkKeyExpiry();"));
check("peer.left is the firing boundary",
  bg.includes('case "peer.left":') && bg.includes("checkKeyExpiry();"));

const checkFn = section(bg, "function checkKeyExpiry()", "function expireConnectorKey(");
check("a connected peer only ARMS the expiry (never fires mid-task)",
  checkFn.includes("state.peerPresent") && checkFn.includes("state.keyExpiryArmed = reason") &&
  checkFn.includes("expireConnectorKey(reason)"));

const expireFn = section(bg, "function expireConnectorKey(", "function refreshBadge()");
check("expiry revokes at the relay (key.revoked poisoning, like rotation)",
  expireFn.includes('"key.revoked"'));
check("expiry drops the ephemeral grants (session + temp)",
  expireFn.includes("state.session = null") && expireFn.includes("state.tempGrant = null"));
check("expiry does NOT touch the whitelist (hygiene, not distrust)",
  !expireFn.includes("WHITELIST"));
check("expiry wipes key + meta + usage and records KEYEXPIRED",
  expireFn.includes("K.KEY, K.KEYMETA, K.KEYUSAGE") && expireFn.includes("K.KEYEXPIRED"));
check("browser-closed deadlines pair briefly just to revoke (pendingRevoke)",
  expireFn.includes("state.pendingRevoke = true") &&
  bg.includes('if (state.pendingRevoke) {'));

const rotateFn = section(bg, "function rotateConnectorKey(", "// ---------------------------------------------------------------- key expiry");
check("rotation stamps the successor key's lifetime + fresh budget",
  rotateFn.includes("K.KEYMETA") && rotateFn.includes("K.KEYUSAGE"));
check("rotation still wipes the whitelist (the distrust path)",
  rotateFn.includes("chrome.storage.local.remove([K.WHITELIST])"));
check("pre-expiry keys (no meta) are exempt in the due check",
  bg.includes("function keyExpiryDueReason()") && bg.includes("var meta = state.keyMeta;"));

check("panel offers the lifetime choice (24h default / 7d / 30d / never)",
  html.includes('id="keyTtlSelect"') && html.includes('value="86400000" selected') &&
  html.includes('value="604800000"') && html.includes('value="2592000000"') && html.includes('value="0"'));
check("panel stamps meta + budget on Generate and passes the choice to Rotate",
  panel.includes("patch[K.KEYMETA]") && panel.includes("ttlMs: Number(el(\"keyTtlSelect\").value)"));
check("panel renders the key's life (countdown / usage / armed) and the expired notice",
  html.includes('id="keyLifeLine"') && html.includes('id="keyExpiredNotice"') &&
  panel.includes("ke.armed") && panel.includes("Key expires in "));

console.log(failures === 0 ? "ALL KEY-EXPIRY GUARD TESTS PASSED" : failures + " KEY-EXPIRY GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
