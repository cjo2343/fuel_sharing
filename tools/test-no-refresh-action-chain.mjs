import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const smoke = fs.readFileSync('tests/smoke.spec.js', 'utf8');
const runValidations = fs.readFileSync('tools/run-validations.mjs', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

function fail(message, context = '') {
  throw new assert.AssertionError({
    message: context ? `${message}\n\nContext:\n${context.slice(0, 1200)}` : message
  });
}

function findFunctionBody(source, name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const match = pattern.exec(source);
  if (!match) fail(`Expected function ${name} to exist.`);
  let index = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = index; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(index, i + 1);
    }
  }
  fail(`Could not parse body for ${name}.`);
}

function assertMatches(text, regex, message) {
  if (!regex.test(text)) fail(message, text);
}

const chainSources = [
  {
    source: 'booking-save',
    functionName: 'saveBookingToNormalizedTablesFirst',
    userStep: 'make booking, then make another booking without refresh',
    start: /setSyncStatus\("Saving",\s*\{\s*source:\s*"booking-save"\s*\}\)/,
    finish: /finally\s*\{[\s\S]*finishForegroundOperationsBySource\("booking-save",[\s\S]*clearVisibleSavingFailsafe\(\);[\s\S]*\}/,
    healthy: /setSyncStatus\("Tables"\);[\s\S]*return true;/
  },
  {
    source: 'trip-save',
    functionName: 'saveTripToNormalizedTablesFirst',
    userStep: 'save trip after another user action without refresh',
    start: /setSyncStatus\("Saving",\s*\{\s*source:\s*"trip-save"\s*\}\)/,
    finish: /finally\s*\{[\s\S]*finishForegroundOperationsBySource\("trip-save",[\s\S]*clearVisibleSavingFailsafe\(\);[\s\S]*\}/,
    healthy: /setSyncStatus\("Tables"\);[\s\S]*return true;/
  },
  {
    source: 'fuel-save',
    functionName: 'saveFuelToNormalizedTablesFirst',
    userStep: 'save fuel after another user action without refresh',
    start: /setSyncStatus\("Saving",\s*\{\s*source:\s*"fuel-save"\s*\}\)/,
    finish: /finally\s*\{[\s\S]*finishForegroundOperationsBySource\("fuel-save",[\s\S]*clearVisibleSavingFailsafe\(\);[\s\S]*\}/,
    healthy: /setSyncStatus\("Tables"\);[\s\S]*return true;/
  },
  {
    source: 'period-close',
    functionName: 'closeNormalizedPeriodFirst',
    userStep: 'close period without blocking later actions',
    start: /setSyncStatus\("Saving",\s*\{\s*source:\s*"period-close"\s*\}\)/,
    finish: /finally\s*\{[\s\S]*finishForegroundOperationsBySource\("period-close",[\s\S]*clearVisibleSavingFailsafe\(\);[\s\S]*\}/,
    healthy: /setSyncStatus\(\"Tables\"\);[\s\S]*return true;/
  }
];

for (const check of chainSources) {
  const body = findFunctionBody(app, check.functionName);
  assertMatches(body, check.start, `${check.source}: ${check.userStep} must start with a named foreground operation so stale latches are attributable.`);
  assertMatches(body, check.finish, `${check.source}: ${check.userStep} must always clear its foreground operation in finally, including errors/timeouts.`);
  assertMatches(body, check.healthy, `${check.source}: ${check.userStep} must leave the visible sync state healthy on success.`);
}

const vehicleClick = findFunctionBody(app, 'handleVehicleLookupButtonClick');
assertMatches(vehicleClick, /const plate = normalizeVehiclePlateInput\(dom\.plateInput\?\.value \|\| state\.vehiclePlate \|\| ""\);[\s\S]*if \(plate\) state\.vehiclePlate = plate;/,
  'vehicle lookup: clicking lookup must lock the newly typed plate before async checks can render stale saved plate text.');
assertMatches(vehicleClick, /setVehicleLookupSummary\(plate \? `Preparing lookup for \$\{plate\}…`/,
  'vehicle lookup: preparing text must use the requested plate, not a previous saved plate.');

const vehicleLookup = findFunctionBody(app, 'lookupVehicleByPlateFromUi');
assertMatches(vehicleLookup, /const plate = normalizeVehiclePlateInput\(options\.requestedPlate \|\| dom\.plateInput\?\.value \|\| els\.vehiclePlate\?\.value \|\| state\.vehiclePlate \|\| ""\);/,
  'vehicle lookup: async lookup must prefer the request-scoped plate passed from the click handler.');
assertMatches(vehicleLookup, /finally\s*\{[\s\S]*if \(dom\.button\) dom\.button\.disabled = !canManageSettings\(\) \|\| !currentSession;[\s\S]*\}/,
  'vehicle lookup: the lookup button must be re-enabled in finally after success, error, timeout, or stale response.');

const debugExport = /window\.FuelLedgerApp\.getNoRefreshActionDebugState\s*=\s*\(\)\s*=>\s*\{[\s\S]*okToClickNextAction:[\s\S]*foregroundOperationCount:[\s\S]*activeDataIoOperationCount:[\s\S]*selectedWorkspaceId:[\s\S]*loadedWorkspaceId:[\s\S]*vehicleLookup:/;
assertMatches(app, debugExport, 'runtime must expose getNoRefreshActionDebugState() so E2E failures can say exactly which latch/workspace/lookup state is stuck.');

assertMatches(smoke, /test\("no-refresh action chain keeps buttons usable and exposes stale latch diagnostics"/, 'Playwright smoke suite must include the named no-refresh action-chain scenario.');
assertMatches(smoke, /getNoRefreshActionDebugState\(\)/, 'No-refresh smoke scenario must read runtime debug state after each action.');
assertMatches(smoke, /make booking #1[\s\S]*make another booking/i, 'No-refresh smoke scenario must create two bookings back-to-back without refresh.');
assertMatches(smoke, /data-view-tab="admin"[\s\S]*vehicleLookupButton[\s\S]*vehicleLookupStatus/i, 'No-refresh smoke scenario must open Admin and click vehicle lookup without refresh.');

assert.ok(packageJson.scripts['test:e2e'], 'package.json must keep a Playwright E2E command for grounded browser action-chain tests.');
assert.ok(runValidations.includes('node tools/test-no-refresh-action-chain.mjs'), 'npm run validate must include the no-refresh action-chain guardrail.');
assert.ok(runValidations.includes('node --check tools/test-no-refresh-action-chain.mjs'), 'npm run validate must syntax-check the no-refresh action-chain guardrail.');

console.log('No-refresh action-chain guardrails passed: booking/trip/fuel/period latches clear in finally, vehicle lookup is request-scoped, and browser diagnostics are exposed.');
