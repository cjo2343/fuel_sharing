import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const renderClient = readFileSync(new URL('../render-api-client.js', import.meta.url), 'utf8');
const buildInfo = readFileSync(new URL('../build-info.js', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

assert.match(buildInfo, /version: "2026\.06\.18\.278"/);
assert.match(buildInfo, /buildLabel: "interactive-action-timeout-lane"/);
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v419"/);
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v419"/);
assert.match(serviceWorker, /BUILD_LABEL = "interactive-action-timeout-lane"/);

assert.match(renderClient, /const runRequest = async \(\) => \{[\s\S]*?const response = await fetch\(url, fetchOptions\);[\s\S]*?return parseJsonResponse\(response\);[\s\S]*?return await Promise\.race\(\[runRequest\(\), timeoutPromise\]\);/, 'Render API client timeout should cover both fetch and response-body parsing.');
assert.match(app, /const runRequest = async \(\) => \{[\s\S]*?const response = await fetch\(endpoint, fetchOptions\);[\s\S]*?const text = await response\.text\(\);[\s\S]*?return await Promise\.race\(\[runRequest\(\), new Promise/, 'app.js fallback Render JSON wrapper should time-bound response-body reads.');

assert.match(app, /const authTimeoutMs = Math\.max\(1, Number\(options\.authTimeoutMs \|\| Math\.min\(timeoutMs, writeContextSessionTimeoutMs\)\)\);/, 'callRenderJson should have a bounded auth/session setup timeout.');
assert.match(app, /getFreshRenderAccessToken\(\{[\s\S]*?timeoutMs: authTimeoutMs,[\s\S]*?preferCached: options\.preferCachedSession !== false[\s\S]*?\}\)/, 'callRenderJson should use cached sessions and fail cleanly instead of blocking on fresh auth.');


assert.match(app, /function recoverStaleInteractiveActionState\(reason = "interactive-action-preflight"\)[\s\S]*?finishStaleForegroundBlockingDataIoOperations\(reason, now\)[\s\S]*?purgeStaleMemberActionOperations\(reason, now\)/, 'interactive action preflight should clear stale foreground, Data I/O, and member-action latches before user clicks.');
assert.match(app, /function isForegroundBlockingDataIoOperation\(operation = \{\}\)[\s\S]*?workspace-tools-refresh[\s\S]*?return false;[\s\S]*?vehicle-lookup\|settings-save\|booking\|trip\|fuel\|payment\|settlement/, 'passive admin/workspace diagnostics should not count as foreground writes while real app actions still do.');
assert.match(app, /document\.addEventListener\("click", handleInteractiveActionPreflightEvent, true\);[\s\S]*?document\.addEventListener\("submit", handleInteractiveActionPreflightEvent, true\);/, 'every click and submit should run the stale action preflight before specific handlers.');
assert.match(app, /const activeMemberActionOperationStartedAt = new Map\(\);[\s\S]*?const memberActionOperationStaleMs = 20000;/, 'member action latches should have timestamps so they cannot block retries forever.');

const mutationStart = app.indexOf('async function callRenderActionMutation');
const mutationEnd = app.indexOf('function normalizedWriteContextUnavailableError', mutationStart);
assert.ok(mutationStart >= 0 && mutationEnd > mutationStart, 'shared Render action mutation helper should exist.');
const mutationBlock = app.slice(mutationStart, mutationEnd);
assert.match(mutationBlock, /callRenderJsonWithUserActionRecovery\(endpoint, \{[\s\S]*?timeoutMs,[\s\S]*?timeoutLabel,[\s\S]*?authTimeoutMs: Math\.min\(timeoutMs \|\| writeContextSessionTimeoutMs, writeContextSessionTimeoutMs\),[\s\S]*?preferCachedSession: true,[\s\S]*?allowResultOkFalse: true,[\s\S]*?attempts: 2,[\s\S]*?recoveryReason: traceMeta\?\.source \|\| timeoutLabel \|\| "render-action"[\s\S]*?\}\)/, 'trip/fuel/booking/delete shared actions should use the bounded Render JSON helper.');
assert.doesNotMatch(mutationBlock, /headers: await buildRenderRequestHeaders/, 'shared action mutations should not block forever while building auth headers.');
assert.doesNotMatch(mutationBlock, /requestRenderJson\(endpoint/, 'shared action mutations should not bypass the bounded auth/session wrapper.');

const contextStart = app.indexOf('async function getRenderAppContext');
const contextEnd = app.indexOf('function getBackendAppContext', contextStart);
assert.ok(contextStart >= 0 && contextEnd > contextStart, 'getRenderAppContext should exist.');
const contextBlock = app.slice(contextStart, contextEnd);
assert.match(contextBlock, /callRenderJson\(renderAppContextUrl/, 'backend app context should use the shared bounded Render JSON helper.');
assert.match(contextBlock, /authTimeoutMs: Math\.min\(timeoutMs, writeContextSessionTimeoutMs\)/, 'backend app context should bound the session/header step.');
assert.doesNotMatch(contextBlock, /buildRenderRequestHeaders\(/, 'backend app context should not use the unbounded header builder.');
assert.doesNotMatch(contextBlock, /response\.text\(\)/, 'backend app context should not parse response bodies outside the bounded Render helper.');


const preflightStart = app.indexOf('function recoverStaleInteractiveActionState');
const preflightEnd = app.indexOf('function bindInteractiveActionControl', preflightStart);
assert.ok(preflightStart >= 0 && preflightEnd > preflightStart, 'global stale interactive-action preflight should exist.');
const preflightBlock = app.slice(preflightStart, preflightEnd);
assert.match(preflightBlock, /purgeStaleForegroundOperations\(`interactive-preflight:\$\{reason\}`/, 'preflight should clear stale foreground Saving latches before the next click.');
assert.match(preflightBlock, /finishStaleForegroundBlockingDataIoOperations\(reason, now\)/, 'preflight should clear stale foreground Data I/O latches before the next click.');
assert.match(preflightBlock, /purgeStaleMemberActionOperations\(reason, now\)/, 'preflight should clear stale member-action latches before the next click.');
assert.match(app, /document\.addEventListener\("click", handleInteractiveActionPreflightEvent, true\);/, 'preflight should run in capture phase before button click handlers.');
assert.match(app, /document\.addEventListener\("submit", handleInteractiveActionPreflightEvent, true\);/, 'preflight should also cover form submit actions.');
assert.match(app, /function isForegroundBlockingDataIoOperation/, 'foreground-blocking Data I/O classifier should exist.');
assert.match(app, /source: "settlement-request-save"[\s\S]*?callRenderJsonWithUserActionRecovery\(renderPaymentStatusActionUrl/, 'payment actions should use the bounded Render helper too.');
assert.match(app, /async function syncLedgerDirectoryViaRender[\s\S]*?callRenderJsonWithUserActionRecovery\(renderLedgerDirectorySyncUrl/, 'settings/member directory sync should use the bounded Render helper too.');

const recoveryStart = app.indexOf('function recoverInteractiveActionControls');
const recoveryEnd = app.indexOf('function recordBlockedVisibleSyncStatus', recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, 'interactive control recovery should exist.');
const recoveryBlock = app.slice(recoveryStart, recoveryEnd);
assert.doesNotMatch(recoveryBlock, /finishRetryableInteractiveDataIoOperations\(/, 'focus/render recovery should not clear fresh active button operations prematurely.');

const lookupStart = app.indexOf('async function ensureVehicleLookupWorkspaceContext');
const lookupEnd = app.indexOf('async function lookupVehicleByPlateFromUi', lookupStart);
assert.ok(lookupStart >= 0 && lookupEnd > lookupStart, 'vehicle lookup workspace context helper should exist.');
const lookupBlock = app.slice(lookupStart, lookupEnd);
assert.match(lookupBlock, /isBackendAppContextFreshForWorkspace\(requestedWorkspaceId\) \? getBackendAppContext\(\) : null/, 'vehicle lookup should reuse a fresh selected-workspace backend context after idle.');
assert.match(lookupBlock, /VEHICLE_LOOKUP_BACKEND_CONTEXT_REUSED/, 'vehicle lookup should diagnose reused backend context rather than starting a new blocking auth check.');
assert.match(lookupBlock, /VEHICLE_LOOKUP_BACKEND_CONTEXT_TIMEOUT/, 'vehicle lookup should record bounded backend-context timeouts.');
assert.match(lookupBlock, /Backend workspace check is delayed\. The app will retry this vehicle lookup automatically without a hard refresh\./, 'vehicle lookup should show a retry state instead of staying on Preparing lookup.');
assert.match(lookupBlock, /lookupVehicleByPlateFromUi\(\{ automaticRetry: true, requestedPlate: plate/, 'vehicle lookup should retry with the same requested plate.');

console.log('interactive action timeout guardrails passed.');
