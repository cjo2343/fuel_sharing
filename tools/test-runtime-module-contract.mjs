import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const utilsSource = readFileSync("utils.js", "utf8");

assert.match(utilsSource, /function\s+formatMoneyFor\s*\(/, "utils.js must expose formatMoneyFor before app.js loads.");
assert.match(utilsSource, /function\s+formatMoney\s*\(/, "utils.js must expose formatMoney before app.js loads.");

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

console.log("Runtime module contract helpers expose expected globals.");
