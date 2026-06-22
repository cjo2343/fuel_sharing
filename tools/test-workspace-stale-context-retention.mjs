import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const build = fs.readFileSync('build-info.js', 'utf8');
const sw = fs.readFileSync('service-worker.js', 'utf8');

assert(app.includes('const retainedContext = staleForCurrentSelection ? (appBackendContextStatus?.context || null) : context;'), 'stale backend app context responses must not replace the retained app-session context');
assert(app.includes('const retainedActiveWorkspaceId = staleForCurrentSelection'), 'stale backend app context responses must retain the selected/canonical workspace id');
assert(app.includes('ok: staleForCurrentSelection ? Boolean(retainedContext && retainedActiveWorkspaceId) : true'), 'ignored stale responses without a retained context must not be marked as a fresh usable app context');
assert(app.includes('const staleContextIgnored = appBackendContextStatus?.decision === "stale-backend-context-ignored";'), 'getRenderAppContext must identify ignored stale responses');
assert(app.includes('return staleContextIgnored ? null : result.context;'), 'getRenderAppContext must not return retained stale context to action guards');
assert(app.includes('APP_CONTEXT_STALE_IGNORED'), 'Data I/O must make ignored stale app-context responses visible');
assert(app.includes('getWorkspaceIdentityLookupKeys(selectedBeforeApply).some((key) => linkedIdentityLookup.has(key))'), 'linked workspace checks must use normalized/URL-safe aliases');
assert(/fuel-ledger-v(?:412|41[2-9]|4[2-9][0-9])/.test(build) && /fuel-ledger-v(?:412|41[2-9]|4[2-9][0-9])/.test(sw), 'runtime cache must be bumped for stale-context runtime changes');

console.log('workspace stale-context retention guardrail passed');
