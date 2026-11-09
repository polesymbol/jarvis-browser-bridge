/**
 * Audio capture + read-aloud guard tests (Prompt 14).
 * Run: node extension/test/capture.guard.test.mjs
 *
 * Invariants:
 *  - tabCapture is an OPTIONAL permission (never in the hard list); the
 *    request happens only in the panel, from the user's own click;
 *  - capture chunks/states are accepted only from the offscreen
 *    document; stopping is always allowed in the gate; capture stops
 *    on disconnect and on cross-site navigation;
 *  - the indicator pill exists in content with its own stop path;
 *  - tones: waiting/grant/deny are distinct melodies in the offscreen,
 *    and the worker plays verdict tones on resolve;
 *  - audioChunk exists in the protocol; the driver has listen.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "../manifest.json"), "utf8"));
const bg = fs.readFileSync(path.join(dir, "../background.js"), "utf8");
const off = fs.readFileSync(path.join(dir, "../offscreen.js"), "utf8");
const content = fs.readFileSync(path.join(dir, "../content.js"), "utf8");
const panel = fs.readFileSync(path.join(dir, "../sidepanel.js"), "utf8");
const proto = fs.readFileSync(path.join(dir, "../protocol.js"), "utf8");
const driver = fs.readFileSync(path.join(dir, "../../driver/driver.js"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failures++;
}

check("tabCapture is optional-only, requested from the panel click",
  (manifest.optional_permissions || []).includes("tabCapture") &&
  !(manifest.permissions || []).includes("tabCapture") &&
  panel.includes('chrome.permissions.request({ permissions: ["tabCapture"] }'));
check("the worker refuses to start without the permission, in plain language",
  bg.includes("audio capture is not enabled yet: the tabCapture permission is granted only by the user, from the side panel"));
check("capture plumbing is sender-verified to the offscreen document",
  bg.includes('msg.kind === "jbb.capture.chunk"') && bg.includes('sender.url.indexOf("offscreen.html")') &&
  bg.includes('msg.kind === "jbb.capture.stopRequest"'));
check("stopping capture is always allowed in the gate",
  bg.includes('proposal.capture.action === "stop"') && bg.includes("stopping capture is always allowed"));
check("capture stops on driver disconnect and cross-site navigation",
  bg.includes('stopCapture("driver disconnected")') && bg.includes("navigated to a different site"));
check("offscreen records tab audio via the stream id and chunks it",
  off.includes('chromeMediaSource: "tab"') && off.includes("new MediaRecorder") &&
  off.includes('"jbb.capture.chunk"') && off.includes("rec.start(1000)"));
check("the on-page indicator exists with its own stop path",
  content.includes('"jbb-capture-pill"') && content.includes("Muse is listening to this tab's audio") &&
  content.includes('"jbb.capture.stopRequest"'));
check("tones: three distinct melodies, verdict tones wired on resolve",
  off.includes('kind === "grant"') && off.includes('kind === "deny"') &&
  bg.includes("playVerdictTone(true)") && bg.includes("playVerdictTone(false)"));
check("protocol carries audio.chunk; driver has listen with a pre-attached collector",
  proto.includes('base("audio.chunk", fields || {})') &&
  driver.includes("CMD === 'listen'") && driver.includes("CAPTURE_NOT_STARTED"));
check("audioCapture is in the whitelist vocabulary for new grants",
  bg.includes('"audioCapture"') && panel.includes('"audioCapture"'));

console.log(failures === 0 ? "ALL CAPTURE GUARD TESTS PASSED" : failures + " CAPTURE GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
