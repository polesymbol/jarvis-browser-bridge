// Guard test for key rotation — run: node extension/test/rotate.guard.test.mjs
// The rules that must NEVER regress:
//   1. Rotation is a background operation (atomic): it revokes the old key
//      at the relay, drops the socket, and invalidates grants in one flow.
//   2. Grants are bound to the key epoch: session grants are stamped at
//      creation and rejected by sessionAllows after a rotation.
//   3. Rotation clears per-site "allow" grants too (denies are not grants).
//   4. The panel has a Rotate key button wired to the background, and the
//      "0 active grants — re-grant to continue" state exists.
//   5. The relay poisons revoked rooms and answers pair.error KEY_ROTATED;
//      the driver surfaces KEY_ROTATED with "key rotated — pair again".
import fs from "node:fs";

const bg = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const panelJs = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
const panelHtml = fs.readFileSync(new URL("../sidepanel.html", import.meta.url), "utf8");
const relay = fs.readFileSync(new URL("../../relay/server.js", import.meta.url), "utf8");
const driver = fs.readFileSync(new URL("../../driver/driver.js", import.meta.url), "utf8");
const checks = [];
function check(name, ok) { checks.push([name, !!ok]); }

check("background: rotateConnectorKey exists and revokes at the relay",
  bg.includes("function rotateConnectorKey") && bg.includes('type: "key.revoked"'));
check("background: rotation bumps the stored epoch",
  bg.includes("patch[K.EPOCH] = newEpoch") && bg.includes('EPOCH: "jbb.keyEpoch"'));
check("background: new key stored un-acked (shown-once reveal)",
  bg.includes("patch[K.KEY_ACKED] = false"));
check("background: UI case wired", bg.includes('case "jbb.ui.rotateKey"'));
check("background: session grants stamped with their epoch",
  bg.includes("epoch: state.keyEpoch"));
check("background: sessionAllows rejects older-epoch grants",
  bg.includes("s.epoch !== state.keyEpoch") && bg.includes('expireSession("key rotated")'));
check("background: rotation clears session grant + per-site allows",
  bg.includes('state.sites[h] === "allow"') && bg.includes("delete state.sites[h]"));
check("background: rotation never audits the key itself",
  !/action: "connector key"[^}]*detail:[^}]*newKey/.test(bg));

check("relay: revoked-room registry + pair.error KEY_ROTATED",
  relay.includes("revokedRooms") && relay.includes("'pair.error'") && relay.includes("KEY_ROTATED"));
check("relay: only the extension can revoke its own room's key",
  relay.includes("ws._role === 'extension'") && relay.includes("roomIdFor(msg.key) === ws._roomId"));
check("relay: connected driver is notified (key.rotated)",
  relay.includes("type: 'key.rotated'"));

check("driver: KEY_ROTATED with the exact message",
  driver.includes("KEY_ROTATED") && driver.includes("key rotated — pair again"));
check("driver: pair.error handled at pairing time",
  driver.includes("'pair.error'") && driver.includes("confirm.type === 'pair.error'"));

check("panel: Rotate key button present, old Regenerate gone",
  panelHtml.includes('id="rotateKeyBtn"') && panelHtml.includes("Rotate key") &&
  !panelHtml.includes("regenKeyBtn") && !panelJs.includes("regenKeyBtn"));
check("panel: button wired to the background rotation",
  panelJs.includes('kind: "jbb.ui.rotateKey"'));
check("panel: 0-grants state text present",
  panelJs.includes("0 active grants — re-grant to continue") && panelHtml.includes('id="grantsLine"'));

let fail = 0;
for (const [name, ok] of checks) { console.log((ok ? "PASS" : "FAIL") + " " + name); if (!ok) fail++; }
process.exit(fail ? 1 : 0);
