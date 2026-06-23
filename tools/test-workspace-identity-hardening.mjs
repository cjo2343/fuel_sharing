import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/040_workspace_identity_hardening.sql', 'utf8');
const validations = fs.readFileSync('tools/run-validations.mjs', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');

function mustInclude(source, text, label = text) {
  assert.ok(source.includes(text), `${label} missing`);
}

mustInclude(app, 'function getWorkspaceLedgerIdentityKey', 'workspace selector must derive a stable workspace identity key');
mustInclude(app, 'function getWorkspaceIdentityLookupKeys', 'workspace identity lookups must include normalized aliases');
mustInclude(app, 'normalizeWorkspaceIdentifier(rawValue)', 'frontend workspace lookup must resolve case-insensitive aliases');
mustInclude(app, 'normalizeWorkspaceIdentifier(urlValue)', 'frontend workspace lookup must resolve URL-safe aliases');
mustInclude(server, 'def normalize_workspace_identity(value):', 'backend app context must normalize requested workspace aliases');
mustInclude(server, 'requested-linked-normalized', 'backend app context must preserve selected non-default workspaces across alias/case differences');
mustInclude(app, 'function mergeWorkspaceLedgerRows', 'workspace selector must merge duplicate rows client-side');
mustInclude(app, 'const seenOptionKeys = new Set();', 'workspace selector must prevent duplicate option rendering');
mustInclude(app, 'workspace-member-duplicate-collapsed', 'signed-in member profile must collapse duplicate active member rows safely');
mustInclude(app, '.limit(10), 8000)', 'signed-in member profile must not use maybeSingle when duplicates can exist, and the read must be time-bounded');
mustInclude(app, 'const role = confirmed ? normalizeWorkspaceRole', 'unconfirmed workspace must not pretend to grant member/admin role');
mustInclude(app, 'suffix = ledger.unconfirmed ? " · loading" : role', 'unconfirmed workspace selector option must be visibly loading');

mustInclude(migration, 'ledger_members_one_active_email_per_workspace_idx', 'database must enforce one active email membership per workspace');
mustInclude(migration, 'row_number() over', 'migration must rank duplicate active member rows');
mustInclude(migration, 'set is_active = false', 'migration must deactivate duplicate active member rows, not delete them');
mustInclude(migration, "case when lm.role = 'admin' then 0 else 1 end", 'migration must keep admin over member when duplicates exist');
mustInclude(migration, 'create or replace function public.list_my_ledgers()', 'migration must refresh authoritative workspace listing RPC');
mustInclude(validations, 'test-workspace-identity-hardening.mjs', 'validation suite must run workspace identity hardening guardrail');

console.log('Workspace identity hardening guardrail passed.');
