import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const validations = fs.readFileSync('tools/run-validations.mjs', 'utf8');

assert.match(app, /function clearStaleWorkspaceInviteLoading\(/, 'workspace refresh loading must have a stale-state cleanup helper');
assert.match(app, /WORKSPACE_REFRESH_STALE_CLEARED/, 'stale workspace refresh loading must be recorded and cleared');
assert.match(app, /const linkedOptionCount = safeOptions\.filter\(\(ledger\) => !ledger\.unconfirmed\)\.length;/, 'selector must count cached linked workspace options separately from loading placeholders');
assert.match(app, /const loadingWithoutUsableAlternatives = loading && linkedOptionCount <= 1;/, 'selector must stay usable when cached linked alternatives exist');
assert.match(app, /targetLinkedFromCachedList = isLedgerLinkedToCurrentUser\(targetLedgerId\)/, 'workspace switch must trust an already-loaded linked workspace list while refresh finishes');
assert.match(app, /WORKSPACE_SWITCH_USED_CACHED_LIST/, 'workspace switch must record when it uses cached membership during a refresh');
assert.match(app, /Refreshing workspace list… cached workspaces remain selectable\./, 'Account workspace list must keep cached workspace rows visible while refreshing');
assert.match(validations, /test-workspace-switch-loading-unfreeze\.mjs/, 'validation suite must run the workspace loading unfreeze guardrail');

console.log('Workspace switch loading unfreeze guardrail passed.');
