import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const workspaceSession = fs.readFileSync('workspace-session.js', 'utf8');
const appAndWorkspaceSession = `${app}\n${workspaceSession}`;
const migration = fs.readFileSync('supabase/migrations/039_list_my_ledgers_dedup.sql', 'utf8');

function mustInclude(source, text, label = text) {
  assert.ok(source.includes(text), `${label} missing`);
}

mustInclude(app, 'function normalizeWorkspaceLedgerList', 'workspace ledger list normalizer');
mustInclude(app, 'function mergeWorkspaceLedgerRows', 'duplicate workspace rows are merged through strongest-role helper');

mustInclude(appAndWorkspaceSession, 'const identityParts = [ledger.ledger_id, ledger.slug]', 'workspace ledger dedup must use ledger id/slug, not the display name');
assert.ok(!appAndWorkspaceSession.includes('[ledger.ledger_id, ledger.slug, ledger.name].map(normalizeWorkspaceIdentifier)'), 'workspaces with the same display name must not be merged together');
mustInclude(app, 'getWorkspaceOptionLabel(ledger)', 'workspace overview should show slug/id-disambiguated labels');
mustInclude(app, 'return normalized === getConfiguredLedgerId();', 'default ledger is only implicitly linked outside signed-in workspace mode');
mustInclude(app, 'if (workspaceListStillLoading && !targetLinkedFromCachedList)', 'workspace switch waits only when the target is not in the cached authoritative workspace list');
mustInclude(app, 'workspaceInviteStatus.loaded = Boolean(getWorkspaceLedgerOptions().length);', 'workspace refresh timeout preserves loaded=false when no authoritative list exists');
mustInclude(app, 'const loadingWithoutUsableAlternatives = loading && linkedOptionCount <= 1;', 'workspace selector stays usable while refreshing if cached linked alternatives exist');

mustInclude(migration, 'with ranked_members as', 'list_my_ledgers ranked duplicate cleanup');
mustInclude(migration, "bool_or(lm.role = 'admin')", 'list_my_ledgers chooses admin if duplicate rows exist');
mustInclude(migration, 'group by l.id', 'list_my_ledgers returns one row per ledger');

console.log('Workspace selector dedup guardrail passed.');
