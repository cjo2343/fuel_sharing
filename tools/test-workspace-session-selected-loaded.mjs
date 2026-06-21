import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const buildInfo = readFileSync(new URL('../build-info.js', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

assert.match(app, /function getWorkspaceSessionSnapshot\(meta = \{\}\)/, 'workspace session snapshot helper should exist.');
assert.match(app, /selectedWorkspaceId[\s\S]*loadedWorkspaceId[\s\S]*workspaceMismatch[\s\S]*loadStatus/, 'workspace session must track selected, loaded, mismatch, and load status.');
assert.match(app, /function getLoadedWorkspaceId\(\)[\s\S]*lastConfirmedWorkspaceLedgerId/, 'loaded workspace should come from the last confirmed workspace, not blindly from the selector.');
assert.match(app, /function buildDataIoWorkspaceContext\(meta = \{\}\)[\s\S]*getWorkspaceSessionSnapshot/, 'Data I/O workspace context should use canonical workspace session state.');
assert.match(app, /WORKSPACE_NOT_LOADED/, 'blocked workspace actions should record a stable WORKSPACE_NOT_LOADED code.');
assert.match(app, /recordWorkspaceActionBlocked\(source, action\)/, 'asserting workspace confirmation should record blocked actions.');
assert.match(app, /requestActiveWorkspaceReload\(source\)/, 'blocked actions should kick a bounded retry load for the selected workspace.');
assert.match(app, /assertActiveWorkspaceDataConfirmed\("lookup vehicle information", "vehicle-lookup"\)/, 'vehicle lookup should record workspace-not-loaded breadcrumbs before blocking.');
assert.match(app, /alreadySelected && isActiveWorkspaceDataConfirmed\(\)/, 'workspace switching should only ignore an already-selected workspace when it is confirmed.');
assert.match(app, /WORKSPACE_LOAD_RETRY_STARTED/, 're-selecting an unconfirmed workspace should record a retry instead of doing nothing.');
assert.match(app, /selectedWorkspaceLabel[\s\S]*loadedWorkspaceLabel[\s\S]*editing stays locked/, 'delayed workspace switch diagnostics should explain selected-vs-loaded state.');

assert.match(app, /function maybeRecordSettingsWorkspaceLocked\(\)[\s\S]*source: "settings-edit"[\s\S]*source: "vehicle-lookup"/, 'rendered settings lock should record both settings and vehicle lookup blocked breadcrumbs.');
assert.match(app, /function getSelectedWorkspaceIdFromUi\(\)[\s\S]*stale DOM values[\s\S]*getActiveLedgerId\(\)/, 'Data I/O selected workspace should prefer canonical active ledger over stale selector DOM.');
assert.match(app, /WORKSPACE_SESSION_RETRY_AFTER_STALE_LOADING/, 'stale workspace loading locks should be diagnosed and retried.');
assert.match(app, /maybeRecordSettingsWorkspaceLocked\(\);[\s\S]*Loading \$\{session\.selectedWorkspaceLabel\} before settings can be edited/, 'Settings lock render path should invoke workspace-session diagnostics before showing the loading message.');
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v(?:394|395|396|397|398)"/, 'build-info should point to v381 cache.');
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v(?:394|395|396|397|398)"/, 'service worker cache should be bumped to v371.');
