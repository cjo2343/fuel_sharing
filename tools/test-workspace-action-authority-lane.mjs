import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const buildInfo = readFileSync(new URL('../build-info.js', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

const chooseStart = app.indexOf('function chooseWorkspaceFromMembership');
const chooseEnd = app.indexOf('function applyWorkspacePreferenceForCurrentUser', chooseStart);
assert.ok(chooseStart >= 0 && chooseEnd > chooseStart, 'workspace membership resolver should exist');
const chooseBlock = app.slice(chooseStart, chooseEnd);
const activeLinkedIndex = chooseBlock.indexOf('const activeBeforeWorkspace = activeBefore ? linkedIdentityLookup.get(activeBefore) : null;');
const urlLinkedIndex = chooseBlock.indexOf('const urlWorkspace = urlWorkspaceId ? linkedIdentityLookup.get(urlWorkspaceId) : null;');
assert.ok(activeLinkedIndex >= 0, 'workspace resolver should explicitly check the current in-app workspace');
assert.ok(urlLinkedIndex >= 0, 'workspace resolver should still understand URL workspace links');
assert.ok(activeLinkedIndex < urlLinkedIndex, 'routine membership reconciliation should keep the linked in-app workspace before honoring a stale URL workspace');
assert.match(chooseBlock, /ignoring stale URL workspace/, 'stale URL workspace should be diagnosed instead of silently winning');

assert.match(app, /const requestedWorkspaceId = String\(getActiveLedgerId\(\) \|\| urlWorkspaceId \|\| getConfiguredLedgerId\(\)\)\.trim\(\);/, 'vehicle lookup should use the selected in-app workspace before URL state');
assert.match(app, /getRenderAppContext\(\{ ledgerId: requestedWorkspaceId, preferredWorkspaceId: requestedWorkspaceId, reason: "vehicle-lookup"/, 'vehicle lookup should request backend context for the selected workspace explicitly');

assert.match(app, /const backendActiveConflictsWithExpectedWorkspace = Boolean\(/, 'backend app context should detect explicit expected-workspace conflicts');
assert.match(app, /lateResponseForPreviousSelection \|\| backendDefaultConflictsWithSelectedWorkspace \|\| backendActiveConflictsWithExpectedWorkspace/, 'explicit backend mismatches should be treated as stale instead of snapping active workspace back');
assert.match(app, /const staleContextIgnored = appBackendContextStatus\?\.decision === "stale-backend-context-ignored";[\s\S]*return staleContextIgnored \? null : result\.context;/, 'stale backend context should not be returned to action guards as if it were current');

assert.match(buildInfo, /version: "2026\.06\.18\.278"/);
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v419"/);
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v419"/);
assert.match(buildInfo, /Workspace actions now trust the selected in-app workspace over stale URL state/);

console.log('workspace action authority guardrails passed.');
