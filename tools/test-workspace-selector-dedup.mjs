import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/039_list_my_ledgers_dedup.sql', 'utf8');

function mustInclude(source, text, label = text) {
  assert.ok(source.includes(text), `${label} missing`);
}

mustInclude(app, 'function normalizeWorkspaceLedgerList', 'workspace ledger list normalizer');
mustInclude(app, 'workspaceRoleRank(ledger.role) > workspaceRoleRank(existing.role)', 'duplicate workspace rows prefer admin role');
mustInclude(app, 'return normalized === getConfiguredLedgerId();', 'default ledger is only implicitly linked outside signed-in workspace mode');
mustInclude(app, 'if (supabaseClient && currentSession && (!workspaceInviteStatus.loaded || workspaceInviteStatus.loading))', 'workspace switch waits for authoritative workspace list');
mustInclude(app, 'workspaceInviteStatus.loaded = Boolean(getWorkspaceLedgerOptions().length);', 'workspace refresh timeout preserves loaded=false when no authoritative list exists');
mustInclude(app, 'els.activeWorkspace.disabled = !supabaseClient || !currentSession || loading || options.length <= 1;', 'workspace selector disabled while membership list is loading');

mustInclude(migration, 'with ranked_members as', 'list_my_ledgers ranked duplicate cleanup');
mustInclude(migration, "bool_or(lm.role = 'admin')", 'list_my_ledgers chooses admin if duplicate rows exist');
mustInclude(migration, 'group by l.id', 'list_my_ledgers returns one row per ledger');

console.log('Workspace selector dedup guardrail passed.');
