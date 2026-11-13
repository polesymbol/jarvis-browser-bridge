// Source pins for the 2026-11-13 reliability fixes (v0.3.3) — run:
//   node extension/test/reliability.guard.test.mjs
// Behavioral checks live in content.reliability.test.mjs and
// driver/test/driver.cli.test.mjs; these pins keep the mechanisms from
// being silently refactored away. Each pin names the fix it protects.
import fs from "node:fs";

const content = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const bg = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const proto = fs.readFileSync(new URL("../protocol.js", import.meta.url), "utf8");
const driver = fs.readFileSync(new URL("../../driver/driver.js", import.meta.url), "utf8");

let failures = 0;
function check(name, ok) {
  console.log((ok ? "PASS " : "FAIL ") + name);
  if (!ok) failures++;
}

// Fix 1 — selector at snapshot time + retry loop + blank-page wait.
check("Fix 1: snapshot remembers a stable selector per id (idMemory)",
  content.includes("idMemory[ref] = { label: label, selector: stableSelectorFor(el), type: type }"));
check("Fix 1: resolution retries across re-renders for up to 5s",
  content.includes("|| 5000;") && content.includes("function resolveWithRetry(ref, label, selector)"));
check("Fix 1: a blank page waits for the re-mount before resolving",
  content.includes("bodyText.trim().length > 0") && content.includes("has not re-mounted after a navigation"));
check("Fix 1: the listener re-dispatches after a successful retry, once",
  content.includes("resolveWithRetry(t.ref, t.label, a.selector).then(function ()"));
check("Fix 1: a tab that moved during the wait refuses the act, naming both URLs",
  bg.includes("the tab moved during the wait (was ") && bg.includes("re-observe and retry instead of acting on the wrong page"));

// Fix 2 — tab-wander reporting + top-frame provenance.
check("Fix 2: observe reports the tab move (from/to) instead of silently serving the new page",
  bg.includes("snap.tabMoved = tabMoved") && bg.includes("tabUrl = tab.url"));
check("Fix 2: frame provenance lists each frame's url + text chars, top first",
  bg.includes("snap.frameSources = sources") && bg.includes("topFrameEmpty"));
check("Fix 2: the driver warns loudly on stderr when a snapshot carries tabMoved",
  driver.includes("[wander] the tab moved on its own"));

// Fix 3 + Fix 4 — post-click verification + state in the snapshot.
check("Fix 4: snapshot entries carry checked / selected / disabled",
  content.includes("checked: st.checked,") && content.includes("selected: st.selected,") &&
  content.includes("disabled: st.disabled"));
check("Fix 3: clicks verify post-click state (VERIFIED / UNCONFIRMED / N/A)",
  content.includes("function verifyStateChange(before, getEl)") &&
  content.includes('verification: "VERIFIED"') && content.includes('verification: "UNCONFIRMED"') &&
  content.includes('verification: "N/A"'));
check("Fix 3: select / type / setValue verify the value landed",
  content.includes('state " + verification'));

// Fix 5 + Fix 6 — interactive pagination + 30k text cap.
check("Fix 5: observe pages interactives (offset/limit/total/next_offset)",
  bg.includes("interactive_next_offset") && bg.includes("interactive_total") &&
  driver.includes("--interactive-offset") && driver.includes("--interactive-limit"));
check("Fix 6: text chunk cap is 30000",
  content.includes("var TEXT_CAP = 30000;"));

// Fix 7 + Fix 8 — empty-observe retry + named fetch errors.
check("Fix 7: the driver retries an empty snapshot once before returning it",
  driver.includes("snapEmpty") && driver.includes("empty snapshot — retrying once"));
check("Fix 8: fetch has a 30s abort timeout with a named error",
  content.includes("fetch timed out after 30s"));
check("Fix 8: fetch rejections are classified (network/CSP vs timeout)",
  content.includes("network error, or the page's CSP blocks requests to"));
check("Fix 8: a bare ok:false gets a synthesized reason in the driver",
  driver.includes("act failed with no reported reason"));

// Fix 9 — shadow-text labels.
check("Fix 9: labelFor falls back to open shadow-root text before the tag name",
  content.includes("el.shadowRoot") && content.includes("Fall back to the shadow text"));

// Fix 12 — status report + cancel.
check("Fix 12: protocol carries status.report and proposal.cancelled",
  proto.includes("statusReport: function") && proto.includes("proposalCancelled: function"));
check("Fix 12: background answers status.request and proposal.cancel",
  bg.includes('case "status.request"') && bg.includes('case "proposal.cancel"') &&
  bg.includes("function buildStatusReport()") && bg.includes("function cancelQueuedProposal(proposalId)"));
check("Fix 12: the driver has a cancel command and treats proposal.cancelled as CANCELLED",
  driver.includes("CMD === 'cancel'") && driver.includes("proposal.cancelled") &&
  driver.includes("new DriverError('CANCELLED'"));

// Fix 14 + Fix 16 — wrong-key wording + key epoch + sign-in block in status.
check("Fix 14: PEER_DOWN names the wrong/stale key as the cause when the panel says Connected",
  driver.includes("or the key is wrong/stale") && driver.includes("Rotate a fresh key in Setup"));
check("Fix 14/16: the status report carries keyEpoch, keyExpiresAt and the sign-in block",
  bg.includes("keyEpoch: state.keyEpoch") && bg.includes("keyExpiresAt: keyExpiresAt") &&
  bg.includes("blocked: !!state.signInBlocked"));

// What must NOT regress (the prompt's constraints, pinned where they live):
check("no regression: custom dropdowns/tabs still discovered via shadow + ARIA roles",
  content.includes("function queryDeep") && content.includes("role"));
check("no regression: fetch still sends headers same-origin only",
  content.includes("custom headers are only sent on same-origin fetches"));
check("no regression: T3 actions still always ask (no silent-permanent grants)",
  bg.includes("T3") && bg.includes("always ask"));

console.log(failures === 0 ? "ALL RELIABILITY GUARD TESTS PASSED" : failures + " RELIABILITY GUARD TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
