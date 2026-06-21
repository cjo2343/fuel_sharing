import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const validations = fs.readFileSync('tools/run-validations.mjs', 'utf8');

assert.match(app, /workspaceSwitchAutoRetryTimer/, 'workspace switch must have a retry timer instead of requiring a page refresh');
assert.match(app, /function scheduleWorkspaceSwitchAutoRetry\(/, 'workspace switch must schedule automatic retry loads after a delayed switch');
assert.match(app, /WORKSPACE_SWITCH_AUTO_RETRY_SCHEDULED/, 'automatic workspace switch retries must be visible in Data I/O');
assert.match(app, /WORKSPACE_SWITCH_AUTO_RETRY_EXHAUSTED/, 'automatic workspace switch retry exhaustion must be diagnosed');
assert.match(app, /scheduleWorkspaceSwitchAutoRetry\(targetLedgerId, source\)/, 'switch failure path must retry the selected workspace automatically');
assert.match(app, /markActiveWorkspaceConfirmed\(reason\);[\s\S]{0,320}render\(\);[\s\S]{0,40}return true;/, 'successful cloud loads must re-render after marking the selected workspace confirmed');
assert.match(app, /ledger-event-self-sync/, 'ledger event channel should also sync same-user updates across tabs/devices');
assert.match(validations, /test-live-workspace-sync-after-switch\.mjs/, 'validation suite must run the live workspace sync guardrail');

console.log('Live workspace sync after switch guardrail passed.');
