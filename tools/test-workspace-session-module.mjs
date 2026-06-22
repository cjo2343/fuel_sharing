import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workspaceSessionSource = readFileSync('workspace-session.js', 'utf8');
const appSource = readFileSync('app.js', 'utf8');
const indexSource = readFileSync('index.html', 'utf8');
const serviceWorkerSource = readFileSync('service-worker.js', 'utf8');
const validationsSource = readFileSync('tools/run-validations.mjs', 'utf8');

assert.match(indexSource, /<script src="workspace-session\.js"><\/script>[\s\S]*<script src="build-info\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/, 'workspace-session.js should load before app.js.');
assert.match(serviceWorkerSource, /"\/workspace-session\.js"/, 'service worker should cache workspace-session.js.');
assert.match(validationsSource, /node --check workspace-session\.js/, 'validation should syntax-check workspace-session.js.');
assert.match(appSource, /const workspaceSession = window\.FuelWorkspaceSession \|\| \{\};/, 'app.js should consume the focused workspace-session runtime module.');
assert.match(appSource, /workspaceSession\.normalizeWorkspaceLedgerList/, 'app.js should delegate member/workspace list normalization to workspace-session.js.');
assert.match(appSource, /workspaceSession\.buildWorkspaceIdentityLookup/, 'app.js should delegate alias lookup construction to workspace-session.js.');
assert.match(appSource, /workspaceSession\.createWorkspaceSessionSnapshot/, 'app.js should delegate selected-vs-loaded snapshots to workspace-session.js.');

const sandbox = { window: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(workspaceSessionSource, sandbox, { filename: 'workspace-session.js' });
const api = sandbox.window.FuelWorkspaceSession;

assert.equal(typeof api.normalizeWorkspaceUrlId, 'function', 'workspace-session should export normalizeWorkspaceUrlId.');
assert.equal(api.normalizeWorkspaceUrlId(' Fuel Ledger TEST 1 '), 'Fuel-Ledger-TEST-1');
assert.equal(api.normalizeWorkspaceIdentifier('TeSt1'), 'test1');
assert.deepEqual(Array.from(api.getWorkspaceIdentityLookupKeys('Fuel Ledger (Test1)')), [
  'Fuel Ledger (Test1)',
  'fuel ledger (test1)',
  'Fuel-Ledger-Test1',
  'fuel-ledger-test1'
]);

const ledgers = api.normalizeWorkspaceLedgerList([
  { ledger_id: 'main-car', slug: 'main-car', name: 'Fuel Ledger', role: 'member' },
  { ledgerId: 'test1', slug: 'Test One', name: 'Fuel Ledger', role: 'member' },
  { ledger_id: 'test1', slug: 'test-one', name: 'Fuel Ledger', role: 'admin', member_id: 'm2' }
], { configuredLedgerId: 'main-car' });

assert.equal(ledgers.length, 2, 'duplicate workspace rows should collapse.');
assert.equal(ledgers[0].ledger_id, 'main-car', 'configured/default workspace should stay first.');
const testWorkspace = ledgers.find((ledger) => ledger.ledger_id === 'test1');
assert.ok(testWorkspace, 'test1 workspace should remain present.');
assert.equal(testWorkspace.role, 'admin', 'higher workspace role should win during duplicate collapse.');
assert.equal(api.resolveWorkspaceIdentityToLedgerId('TEST ONE', ledgers), 'test1', 'alias lookup should resolve case-insensitive slugs.');
assert.equal(api.resolveWorkspaceIdentityToLedgerId('Test One', ledgers), 'test1', 'alias lookup should resolve raw slug aliases.');

assert.deepEqual(JSON.parse(JSON.stringify(api.createWorkspaceSessionSnapshot({
  selectedWorkspaceId: 'test1',
  selectedWorkspaceLabel: 'Fuel Ledger (test1)',
  loadedWorkspaceId: 'main-car',
  loadedWorkspaceLabel: 'Fuel Ledger (main-car)',
  activeWorkspaceLoadInProgress: false
}))), {
  selectedWorkspaceId: 'test1',
  selectedWorkspaceLabel: 'Fuel Ledger (test1)',
  loadedWorkspaceId: 'main-car',
  loadedWorkspaceLabel: 'Fuel Ledger (main-car)',
  workspaceMismatch: true,
  loadStatus: 'not_loaded',
  loadStartedAt: 0,
  loadingLedgerId: ''
});

console.log('Workspace session module guardrail passed.');
