import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {
  window: {},
  console,
  Date,
  Number,
  String,
  Math
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(readFileSync("fuel-price-helpers.js", "utf8"), context, { filename: "fuel-price-helpers.js" });

const helpers = context.window.FuelPriceHelpers;
const deps = {
  state: {
    currency: "DKK",
    fuelPriceWarningMinDkkPerLiter: 8,
    fuelPriceWarningMaxDkkPerLiter: 25,
    fuel: [
      { id: "old", date: "2026-06-01", amount: 100, liters: 5 },
      { id: "new", date: "2026-06-10", amount: 180, liters: 10 }
    ]
  },
  latestFuelPrice: { price: 16.5, source: "test feed" },
  formatNumber: (value) => String(Number(value)),
  formatMoneyFor: (value, currency = "DKK") => `${Number(value).toFixed(2)} ${currency}`,
  formatDate: (value) => value,
  escapeHtml: (value) => String(value),
  roundMoney: (value) => Math.round(Number(value) * 100) / 100
};

function testWarningRangeNormalizesInvalidSettings() {
  const range = helpers.getFuelPriceWarningRange({
    fuelPriceWarningMinDkkPerLiter: -1,
    fuelPriceWarningMaxDkkPerLiter: 1
  });
  assert.equal(range.minDkkPerLiter, 8);
  assert.equal(range.maxDkkPerLiter, 25);
  assert.equal(helpers.isFuelPriceOutsideWarningRange(30, deps.state, deps), true);
  assert.equal(helpers.isFuelPriceOutsideWarningRange(18, deps.state, deps), false);
}

function testHistoricalSuggestionUsesLatestValidReceipt() {
  const suggestion = helpers.getSuggestedFuelPricePerLiter({ amount: 500, liters: 10 }, deps);
  assert.equal(suggestion.source, "historical");
  assert.equal(suggestion.price, 18);
  assert.match(suggestion.detail, /2026-06-10/);
}

function testCorrectionUsesSuggestedPriceForAmount() {
  const correction = helpers.buildFuelPriceCorrection({ amount: 500, liters: 10 }, deps);
  assert.equal(correction.suggestedPricePerLiter, 18);
  assert.equal(correction.suggestedAmount, 180);
  assert.equal(correction.range.minDkkPerLiter, 8);
}

function testValidationReturnsCorrectionForOutOfRangePrice() {
  const validation = helpers.validateFuelLogInput({ amount: 500, liters: 10 }, deps);
  assert.equal(validation.ok, false);
  assert.match(validation.message, /outside the configured fuel price range/);
  assert.equal(validation.correction.suggestedAmount, 180);
}

const tests = [
  testWarningRangeNormalizesInvalidSettings,
  testHistoricalSuggestionUsesLatestValidReceipt,
  testCorrectionUsesSuggestedPriceForAmount,
  testValidationReturnsCorrectionForOutOfRangePrice
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}
