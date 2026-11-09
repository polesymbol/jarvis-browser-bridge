/**
 * Full-action-vocabulary guard tests.
 * Run: node extension/test/actions.guard.test.mjs
 *
 * Invariants:
 *  - every new action type is dispatched by the content script and
 *    travels the same consent path as click/type (no side channels —
 *    background has no type allowlist to bypass, the tiers decide);
 *  - set_value uses the NATIVE prototype setter (React-controlled
 *    inputs), never a bare assignment;
 *  - password fields refuse keyboard-style input on every path
 *    (press_key, set_value, type);
 *  - the whitelist vocabulary includes the new types for NEW grants,
 *    while stored entries keep their grant-time list (old entries ask).
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

for (const t of ["key", "hover", "select", "setValue", "drag"]) {
  check("content dispatches action type '" + t + "'",
    content.includes('a.type === "' + t + '"'));
}
check("press_key builds real keyboard events with modifiers",
  content.includes('new KeyboardEvent("keydown", init)') && content.includes("ctrlKey: ks.mods.ctrlKey"));
check("set_value goes through the native prototype setter + input/change events",
  content.includes('Object.getOwnPropertyDescriptor(proto, "value")') &&
  content.includes("desc.set.call(el, value)"));
check("password fields refuse on press_key, set_value, and type",
  (content.match(/isPasswordField\(el\)/g) || []).length >= 3 &&
  content.includes('throw new Error("refusing to type into a password field")') &&
  content.includes('throw new Error("refusing to press keys on a password field")') &&
  content.includes('throw new Error("refusing to set a value on a password field")'));
check("set_value detail never echoes the value",
  content.includes('String(value == null ? "" : value).length + " chars)"'));
check("hover waits and reports what appeared",
  content.includes("interactiveLabelsById()") && content.includes("appeared: appeared"));
check("driver builds proposals for every new type",
  ["hover", "select", "setValue", "drag"].every((t) => driver.includes("type === '" + t + "'")));
check("whitelist vocabulary (background + panel mirror) covers the new types",
  bg.includes('"hover", "select", "drag", "setValue"') && panel.includes('"hover", "select", "drag", "setValue"'));

console.log(failures === 0 ? "ALL ACTION GUARD TESTS PASSED" : failures + " ACTION GUARD CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
