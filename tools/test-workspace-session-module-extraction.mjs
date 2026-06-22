import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const moduleSource = readFileSync('workspace-session.js', 'utf8');
const appSource = readFileSync('app.js', 'utf8');
const indexSource = readFileSync('index.html', 'utf8');
const serviceWorkerSource = readFileSync('service-worker.js', 'utf8');
const validationsSource = readFileSync('tools/run-validations.mjs', 'utf8');

const sandbox = { window: {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(moduleSource, sandbox, { filename: 'workspace-session.js' });

const session = sandbox.window.FuelWorkspaceSession;
assert.equal(typeof session, 'object', 'workspace-session.js should expose FuelWorkspaceSession.');
for (const name of [
  'normalizeWorkspaceUrlId',
  'buildWorkspaceIdentityLookup',
  'resolveWorkspaceIdentityToLedgerId',
  'normalizeWorkspaceLedgerList',
  'createWorkspaceSnapshot',
  'isWorkspaceWriteScopeAllowed'
]) {
  assert.equal(typeof session[name], 'function', `FuelWorkspaceSession.${name} should exist.`);
}

const ledgers = session.normalizeWorkspaceLedgerList([
  { ledger_id: 'main-car', slug: 'Main Car', name: 'Fuel Ledger', role: 'member' },
  { ledger_id: 'test1', slug: 'Test Workspace', name: 'Fuel Ledger', role: 'member' },
  { ledgerId: 'test1', slug: 'test-workspace', name: 'Fuel Ledger', role: 'admin' }
], { configuredLedgerId: 'main-car' });
assert.equal(ledgers.length, 2, 'workspace module should collapse duplicate ledger rows.');
assert.equal(ledgers.find((ledger) => ledger.ledger_id === 'test1')?.role, 'admin', 'workspace module should keep the strongest role when merging duplicate rows.');
assert.equal(session.resolveWorkspaceIdentityToLedgerId('test-workspace', ledgers), 'test1', 'workspace module should resolve slug aliases.');
assert.equal(session.resolveWorkspaceIdentityToLedgerId('Test Workspace', ledgers), 'test1', 'workspace module should resolve URL-safe display aliases.');

const snapshot = session.createWorkspaceSnapshot({
  selectedWorkspaceId: 'test1',
  selectedWorkspaceLabel: 'Fuel Ledger (test1)',
  loadedWorkspaceId: 'main-car',
  loadedWorkspaceLabel: 'Fuel Ledger (main-car)'
});
assert.equal(snapshot.workspaceMismatch, true, 'workspace snapshot should flag selected/loaded mismatches.');
assert.equal(snapshot.loadStatus, 'not_loaded', 'workspace snapshot should keep editing locked while selected workspace is not loaded.');

assert.equal(session.isWorkspaceWriteScopeAllowed({ ledgerId: 'test1', selectedWorkspaceId: 'test1', loadedWorkspaceId: 'test1' }), true, 'write scope should allow fully aligned workspace writes.');
assert.equal(session.isWorkspaceWriteScopeAllowed({ ledgerId: 'test1', selectedWorkspaceId: 'main-car', loadedWorkspaceId: 'test1' }), false, 'write scope should block selected workspace mismatches.');
assert.equal(session.isWorkspaceWriteScopeAllowed({ ledgerId: 'test1', selectedWorkspaceId: 'test1', loadedWorkspaceId: 'main-car' }), false, 'write scope should block loaded workspace mismatches.');
assert.equal(session.isWorkspaceWriteScopeAllowed({ ledgerId: 'test1', selectedWorkspaceId: 'test1', loadedWorkspaceId: 'main-car' }, { reason: 'safety backup' }), true, 'backup lanes should be allowed to write safety copies across loaded workspace mismatches.');

assert.match(appSource, /const workspaceSession = window\.FuelWorkspaceSession \|\| \{\};/, 'app.js should load the extracted workspace session module.');
assert.match(appSource, /function normalizeWorkspaceLedgerList\(ledgers = \[\]\)[\s\S]*workspaceSession\.normalizeWorkspaceLedgerList/, 'app.js should delegate workspace list normalization to the module.');
assert.match(appSource, /function getWorkspaceSessionSnapshot\(meta = \{\}\)[\s\S]*workspaceSession\.createWorkspaceSnapshot/, 'app.js should delegate selected-vs-loaded snapshots to the module.');
assert.match(appSource, /function isWorkspaceWriteScopeAllowed\(scope = \{\}, reason = "save"\)[\s\S]*workspaceSession\.isWorkspaceWriteScopeAllowed/, 'app.js should delegate write-scope checks to the module.');
assert.match(indexSource, /workspace-session\.js[\s\S]*build-info\.js[\s\S]*app\.js/, 'index.html should load workspace-session.js before app.js.');
assert.match(serviceWorkerSource, /"\/workspace-session\.js"/, 'service worker should cache workspace-session.js as part of the app shell.');
assert.match(validationsSource, /test-workspace-session-module-extraction\.mjs/, 'validation suite should run the workspace-session module extraction guardrail.');

console.log('Workspace session module extraction guardrail passed.');
