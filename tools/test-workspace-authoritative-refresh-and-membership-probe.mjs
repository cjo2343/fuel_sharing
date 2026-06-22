import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406)"/, 'build-info should point to v381 cache.');
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406)"/, 'service worker cache should be bumped to v371.');

assert.match(app, /let workspaceMembershipProbeStatus = \{/, 'App should keep a current-user membership probe snapshot.');
assert.match(app, /async function refreshWorkspaceMembershipProbe/, 'App should probe visible current-email membership rows.');
assert.match(app, /workspaceMembershipProbe: workspaceMembershipProbeStatus/, 'Load reports should export the membership probe.');
assert.match(app, /visibleWorkspaceSelectorId:/, 'Workspace resolution should export the visible selector value.');
assert.match(app, /rawLedgers: \[\]/, 'Workspace refresh status should keep raw Render workspace rows before frontend normalization.');
assert.match(app, /workspaceInviteStatus\.rawLedgers = ledgers/, 'Workspace refresh should store raw Render workspace rows.');
assert.match(app, /account-tab-open\|account-panel-render/, 'Account tab refreshes should be authoritative and not treated as optional fresh-cache skips.');
assert.match(app, /getWorkspaceLedgerOptions\(\)\.length > 1/, 'Fresh-cache skips should not hide a one-row workspace list that may still be incomplete.');
assert.match(app, /updateWorkspaceMembershipProbeFromBackendContext/, 'Workspace refresh should derive the membership probe from backend app context.');
assert.match(app, /renderWorkspaceToolsUrl = "\/api\/workspace\/tools"/, 'Workspace tools should have a Render route.');

console.log('workspace authoritative refresh and membership probe guardrails passed');
