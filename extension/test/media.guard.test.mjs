/**
 * Media guard tests (Prompt 13).
 * Run: node extension/test/media.guard.test.mjs
 *
 * Invariants:
 *  - play is verified by currentTime ADVANCING across two samples,
 *    never by a bare paused flag; failures carry a named reason;
 *  - captions read a disabled track via the documented hidden-mode
 *    load and return markup-stripped cue text;
 *  - frame grabs go through canvas and report DRM/cross-origin
 *    tainting honestly;
 *  - the driver keeps a per-player failure memory: two failures →
 *    NOT_VERIFIED, refused locally before any proposal is sent;
 *  - media + frameGrab are T2 in the driver; all three types are in
 *    the whitelist vocabulary for new grants.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const content = fs.readFileSync(path.join(dir, "../content.js"), "utf8");
const bg = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const panel = fs.readFileSync(path.join(dir, "../sidepanel.js"), "utf8");
const driver = fs.readFileSync(path.join(dir, "../../driver/driver.js"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

check("play verification is a currentTime-advance cross-check",
  content.includes("ct2 > ct1 + 0.1 && !el.paused"));
check("failure reasons are a named taxonomy (autoplay / source / viewport / no-source)",
  content.includes('"autoplay-blocked"') && content.includes('"source-error: "') &&
  content.includes('"not-in-viewport"') && content.includes('"no-source"') &&
  content.includes("paused: true, reason: "));
check("snapshot media tracks expose language list + active track + cue counts",
  content.includes('active: tr.mode === "showing"') && content.includes("ti.cues = tr.cues ? tr.cues.length : null"));
check("captions: hidden-load a disabled track, strip markup, honor the time range",
  content.includes('chosen.mode = "hidden"') && content.includes("text: stripCueMarkup(c.text)") &&
  content.includes("c.endTime < from || c.startTime > to"));
check("frame grab uses canvas and reports tainting honestly",
  content.includes('canvas.toDataURL("image/jpeg", 0.82)') && content.includes("the canvas is tainted (DRM or cross-origin media)"));
check("driver: NOT VERIFIED memory — two fails, local refusal, verified play clears",
  driver.includes("error: 'NOT_VERIFIED'") && driver.includes("entry.fails >= 2") &&
  driver.includes("JBB_PLAYER_MEMORY") && driver.includes("delete mem[key]"));
check("driver: memory is recorded at the act-result exit door, gate runs before proposing",
  driver.includes("mediaRecord(proposal, msg)") && driver.includes("mediaGate(proposal)"));
check("driver: media + frameGrab default to T2",
  driver.includes("type === 'media'") && driver.includes("type === 'frameGrab'"));
check("vocabulary covers media + captions + frameGrab for new grants (background + panel)",
  bg.includes('"media", "captions", "frameGrab"') && panel.includes('"media", "captions", "frameGrab"'));

console.log(failures === 0 ? "ALL MEDIA GUARD TESTS PASSED" : failures + " MEDIA GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
