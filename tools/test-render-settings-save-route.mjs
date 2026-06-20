import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");
const migrations = readFileSync("supabase/migrations/038_vehicle_settings_columns.sql", "utf8");

assert.match(app, /const renderSettingsSaveUrl = "\/api\/settings\/save"/, "frontend should define the dedicated settings-save route");
assert.match(app, /async function saveSettingsViaRender/, "frontend should save settings through Render");
assert.match(app, /await saveSettingsViaRender\(\{ traceMeta: settingsTraceMeta \}\)/, "settings form should call the backend settings save route");
assert.doesNotMatch(app, /await saveSupabaseState\(\{ reason: "group-settings" \}\)/, "settings save must not use broad full-state Supabase save");
assert.doesNotMatch(app, /markNormalizedReconciliationDirty\("group settings changed"\)/, "settings save must not trigger broad JSON-to-table reconciliation");
assert.match(app, /vehiclePlate: normalizeVehiclePlateInput\(ledger\.vehicle_plate/, "normalized table load should hydrate saved vehicle plate from ledgers");
assert.match(app, /vehicleInfo: normalizeVehicleInfo\(ledger\.vehicle_info/, "normalized table load should hydrate saved vehicle info from ledgers");

assert.match(server, /if self\.path == "\/api\/settings\/save":\n\s+self\.save_settings_backend\(\)/, "server should mount /api/settings/save");
assert.match(server, /def save_settings_backend\(self\):/, "server should implement the settings save handler");
assert.match(server, /assert_user_can_admin_ledger\(ledger\["id"\], user, token\)/, "settings save should require workspace admin permission");
assert.match(server, /upsert_settings_as_service\(ledger, members\)/, "settings save should use backend-owned service role persistence after admin verification");
assert.match(server, /"settings-save": \{"limit": 30, "window": 300\}/, "settings save should have a dedicated rate limit bucket");
assert.match(server, /"settingsSave", "\/api\/settings\/save"/, "Render admin health should list the settings-save route");

assert.match(migrations, /vehicle_plate text not null default ''/, "migration should add vehicle plate storage");
assert.match(migrations, /vehicle_info jsonb not null default '\{\}'::jsonb/, "migration should add sanitized vehicle info storage");
assert.match(migrations, /038_vehicle_settings_columns/, "migration should track itself");

console.log("Render settings-save route guardrails passed.");
