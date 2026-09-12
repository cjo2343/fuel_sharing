import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertParityCoverage } from "./simulator/lib/parity-coverage.mjs";

const cell = { invariant: "client_parity", skipped: false, detail: { periods: [{}] } };
assert.equal(assertParityCoverage([cell]), 1);
assert.equal(assertParityCoverage([cell, cell]), 2);
assert.throws(() => assertParityCoverage([]), /not exercised/);
assert.throws(() => assertParityCoverage([{ ...cell, skipped: true }]), /not exercised/);
assert.throws(() => assertParityCoverage([{ ...cell, detail: { periods: [] } }]), /zero periods/);
assert.throws(() => assertParityCoverage([cell, { ...cell, skipped: true }]), /not exercised/);
assert.throws(() => assertParityCoverage([cell, { ...cell, detail: { periods: [] } }]), /zero periods/);
assert.throws(() => assertParityCoverage([{ ...cell, detail: {} }]), /zero periods/);

function loadFrom(root, requireAll) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { loadClientModules } from './tools/simulator/lib/client-parity.mjs';
    const result = await loadClientModules({ requireAll: ${requireAll} });
    console.log(JSON.stringify(result));
  `], { encoding: "utf8", env: { ...process.env, SIMULATOR_MOBILE_ROOT: root } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Separate processes prevent import caching from hiding missing/broken modules.
const missing = mkdtempSync(path.join(tmpdir(), "vehlo-missing-mobile-"));
try {
  assert.equal(loadFrom(missing, true).available, false);
  assert.match(loadFrom(missing, true).reason, /not found/);
  const lib = path.join(missing, "src", "lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(path.join(lib, "settlement-calc.ts"),
    ["calculateSettlements", "toExpenseInputs", "toRepairInputs", "scopeRepairsToPeriod"]
      .map(name => `export function ${name}() {}`).join("\n"));
  assert.equal(loadFrom(missing, false).available, true, "ordinary local runs retain partial coverage");
  assert.equal(loadFrom(missing, true).available, false, "nightly cannot omit optional modules");
  writeFileSync(path.join(lib, "period-balance.ts"), "export function periodSettlement() {}\n");
  writeFileSync(path.join(lib, "period-snapshot.ts"), "export function periodEntryFingerprint() {}\n");
  writeFileSync(path.join(lib, "odometer.ts"), "export function deriveOdometer() {}\n");
  const complete = loadFrom(missing, true);
  assert.equal(complete.available, true);
  assert.equal(complete.report.filter(item => item.loaded).length, 4);
  writeFileSync(path.join(lib, "odometer.ts"), "export const wrongExport = 1;\n");
  assert.match(loadFrom(missing, true).reason, /missing deriveOdometer/);
  writeFileSync(path.join(lib, "odometer.ts"), "throw new Error('fixture import failure');\n");
  assert.match(loadFrom(missing, true).reason, /could not be imported/);
} finally {
  rmSync(missing, { recursive: true, force: true });
}

const workflow = readFileSync(new URL('../.github/workflows/nightly-simulator.yml', import.meta.url), 'utf8');
assert.match(workflow, /repository: cjo2343\/vehloshare-mobile/);
assert.match(workflow, /--headless --require-parity/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /if: always\(\)/);
assert.doesNotMatch(workflow, /pull_request_target/);
console.log('Required parity coverage and nightly checkout guards passed.');
