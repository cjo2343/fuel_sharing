import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import vm from "node:vm";

const utilsSource = readFileSync("utils.js", "utf8");
const appSource = readFileSync("app.js", "utf8");

assert.match(utilsSource, /function\s+formatMoneyFor\s*\(/, "utils.js must expose formatMoneyFor before app.js loads.");
assert.match(utilsSource, /function\s+formatMoney\s*\(/, "utils.js must expose formatMoney before app.js loads.");

assert.equal(appSource.includes("?.["), false, "app.js should avoid optional chaining bracket syntax for older Safari login/invite screens.");

const runtimeJsFiles = readdirSync(".").filter((name) => name.endsWith(".js"));
for (const file of runtimeJsFiles) {
  const source = readFileSync(file, "utf8");
  assert.equal(
    /\bcatch\s*\{/.test(source),
    false,
    `${file} should avoid optional catch binding syntax because older Safari/WebKit parses it as a syntax error.`
  );
}

assert.match(
  appSource,
  /status:\s*healthcheck\s*&&\s*healthcheck\.ok\s*\?\s*"Legacy healthcheck passed"\s*:\s*"Needs review"/,
  "Admin guardrail overview should not dereference healthcheck.ok when Security Health has not returned a legacy healthcheck row."
);

const sandbox = {
  Intl,
  Math,
  Number,
  String,
  Date,
  window: { CSS: { escape: (value) => String(value) } },
  CSS: { escape: (value) => String(value) }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(utilsSource, sandbox, { filename: "utils.js" });

assert.equal(typeof sandbox.formatMoneyFor, "function", "formatMoneyFor must be a global runtime helper.");
assert.equal(typeof sandbox.formatMoney, "function", "formatMoney must be a global runtime helper.");
assert.equal(sandbox.formatMoney(12.3), "12,30 DKK", "formatMoney should default safely before app.js state exists.");
assert.equal(sandbox.formatMoney(12.3, "EUR"), "12,30 EUR", "formatMoney should allow explicit currencies.");

console.log("Runtime module contract helpers expose expected globals and Safari-safe syntax guards passed.");
