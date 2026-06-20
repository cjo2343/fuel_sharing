import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync("server.py", "utf8");
const app = readFileSync("app.js", "utf8");
const migration = readFileSync("supabase/migrations/041_owner_activity_log.sql", "utf8");
const schema = readFileSync("supabase-schema.sql", "utf8");

assert.match(migration, /create table if not exists public\.owner_activity_log/, "migration should create owner_activity_log");
assert.match(migration, /alter table public\.owner_activity_log enable row level security/, "owner activity table should have RLS enabled");
assert.match(migration, /revoke all on public\.owner_activity_log from authenticated/, "browser users should not get direct table access");
assert.match(migration, /041_owner_activity_log/, "migration should record itself");
assert.match(schema, /create table if not exists public\.owner_activity_log/, "consolidated schema should include owner activity table");

assert.match(server, /def record_owner_activity_as_service\(/, "server should have a service-owned activity writer");
assert.match(server, /def owner_activity_backend\(self\):/, "server should expose owner activity endpoint");
assert.match(server, /if self\.path == "\/api\/owner\/activity":\n\s+self\.owner_activity_backend\(\)/, "server should mount /api/owner/activity");
assert.match(server, /is_configured_app_owner\(user\)/, "owner activity endpoint should be app-owner only");
assert.match(server, /record_owner_activity_as_service\(ledger\.get\("id"\), user, action="settings-save"/, "settings save should record server-owned activity");
assert.match(server, /record_owner_activity_as_service\(rpc_payload\.get\("target_ledger_id"\), user, action="trip-upsert"/, "trip saves should record server-owned activity");
assert.match(server, /record_owner_activity_as_service\(rpc_payload\.get\("target_ledger_id"\), user, action="fuel-upsert"/, "fuel saves should record server-owned activity");
assert.match(server, /record_owner_activity_as_service\(ledger_id, user, action="vehicle-lookup"/, "vehicle lookups should record server-owned activity");
assert.match(server, /safe_owner_activity_metadata/, "owner activity should use redacted metadata");

assert.match(app, /const renderOwnerActivityUrl = "\/api\/owner\/activity"/, "frontend should know the owner activity endpoint");
assert.match(app, /async function refreshOwnerActivity/, "frontend should load owner activity");
assert.match(app, /function renderOwnerActivityCard/, "frontend should render owner activity in Admin diagnostics");
assert.match(app, /Server-side · all workspaces/, "owner activity should be labeled as server-side and cross-workspace");
assert.match(app, /canUseGlobalAdminTools\(\) \? renderOwnerActivityCard\(\)/, "owner activity UI should be owner-only");

console.log("ok - server-owned owner activity log is wired for backend actions and owner UI");
