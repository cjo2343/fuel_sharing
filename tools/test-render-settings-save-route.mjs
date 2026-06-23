import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");
const migrations = readFileSync("supabase/migrations/038_vehicle_settings_columns.sql", "utf8");

assert.match(app, /const\s+renderSettingsSaveUrl\s*=\s*renderApiEndpoints\.settingsSave\s*\|\|\s*"\/api\/settings\/save"/, "frontend should define the dedicated settings-save route");
assert.match(app, /async function saveSettingsViaRender/, "frontend should save settings through Render");
assert.match(app, /settingsSaveResult = await saveSettingsViaRender\(\{ traceMeta: settingsTraceMeta \}\)/, "settings form should call the backend settings save route and keep the result");
assert.doesNotMatch(app, /await saveSupabaseState\(\{ reason: "group-settings" \}\)/, "settings save must not use broad full-state Supabase save");
assert.doesNotMatch(app, /markNormalizedReconciliationDirty\("group settings changed"\)/, "settings save must not trigger broad JSON-to-table reconciliation");
assert.match(app, /assertSettingsSaveVerified\(result, payload\)/, "frontend should require backend verification before accepting a settings save");
assert.match(app, /formatSettingsPersistedSummary\(settingsSaveResult\.persisted\)/, "settings save diagnostics should summarize which settings were persisted");
assert.match(app, /formatSettingsSavedConfirmation\(settingsSaveResult\)/, "settings save should show a user-facing confirmation after verified backend save");
assert.match(app, /Vehicle info for \$\{plate\}/, "settings save confirmation should mention saved vehicle info when available");
assert.match(app, /vehiclePlate: normalizeVehiclePlateInput\(ledger\.vehicle_plate/, "normalized table load should hydrate saved vehicle plate from ledgers");
assert.match(app, /vehicleInfo: normalizeVehicleInfo\(ledger\.vehicle_info/, "normalized table load should hydrate saved vehicle info from ledgers");

assert.match(server, /if self\.path == "\/api\/settings\/save":\n\s+self\.save_settings_backend\(\)/, "server should mount /api/settings/save");
assert.match(server, /def save_settings_backend\(self\):/, "server should implement the settings save handler");
assert.match(server, /assert_user_can_admin_ledger\(ledger\["id"\], user, token\)/, "settings save should require workspace admin permission");
assert.match(server, /upsert_settings_as_service\(ledger, members\)/, "settings save should use backend-owned service role persistence after admin verification");
assert.match(server, /select_ledger_settings_as_service\(ledger_id, require_vehicle_columns=True\)/, "settings save should read back saved vehicle fields for verification");
assert.match(server, /SETTINGS_SCHEMA_MISSING/, "settings save should fail clearly when vehicle settings columns are missing");

assert.match(app, /callRenderJson\(renderSettingsSaveUrl,[\s\S]*timeoutMs: 12000/, "frontend settings save should use shared Render JSON helper with a bounded timeout");
assert.match(app, /response\.text\(\)/, "frontend settings save should parse the response body inside the timeout window");
assert.match(app, /SETTINGS_SAVE_TIMEOUT/, "frontend settings save should record timeout failures explicitly");
assert.match(app, /normalizedDiagnosticPhase === "success"/, "Data I/O labels should only use :ok for successful finishes, not start rows");
assert.match(server, /SETTINGS_SAVE_SUPABASE_TIMEOUT = 5/, "backend settings save should bound Supabase ledger calls");
assert.match(server, /SETTINGS_MEMBER_SYNC_TIMEOUT = 4/, "backend settings save should not let member directory sync hang car settings saves");
assert.match(server, /memberWarning/, "settings route should return member sync warnings without blocking saved car settings");
assert.match(server, /SETTINGS_SAVE_TIMEOUT/, "backend settings save should return explicit timeout JSON");
assert.doesNotMatch(server, /fallback_ledger = dict\(ledger\)/, "settings save must not silently drop vehicle fields when schema is missing");
assert.match(server, /"settings-save": \{"limit": 30, "window": 300\}/, "settings save should have a dedicated rate limit bucket");
assert.match(server, /"\/api\/settings\/save", "Workspace settings save"/, "Render admin health critical routes should list the settings-save route");

assert.match(migrations, /vehicle_plate text not null default ''/, "migration should add vehicle plate storage");
assert.match(migrations, /vehicle_info jsonb not null default '\{\}'::jsonb/, "migration should add sanitized vehicle info storage");
assert.match(migrations, /038_vehicle_settings_columns/, "migration should track itself");

console.log("Render settings-save route guardrails passed.");
