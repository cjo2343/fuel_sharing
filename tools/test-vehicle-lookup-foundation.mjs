import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const env = fs.readFileSync('.env.example', 'utf8');

assert.match(app, /const renderVehicleLookupUrl = "\/api\/vehicle\/lookup";/, 'app must call the Render vehicle lookup route');
assert.match(app, /source: "vehicle-lookup"/, 'vehicle lookup must be recorded in Data I/O');
assert.match(app, /VEHICLE_LOOKUP_STARTED/, 'vehicle lookup start code must be present');
assert.match(app, /VEHICLE_LOOKUP_OK/, 'vehicle lookup success code must be present');
assert.match(app, /VEHICLE_LOOKUP_NOT_CONFIGURED/, 'not-configured code must be present');
assert.match(app, /VEHICLE_LOOKUP_PROVIDER_UNAVAILABLE/, 'provider unavailable code must be present');
assert.match(app, /callRenderJson\(renderVehicleLookupUrl/, 'vehicle lookup must use the shared full-request Render JSON helper');
assert.match(app, /applyVehicleLookupToSettings/, 'vehicle lookup must apply suggested fuel settings only through app logic');
assert.match(app, /state\.vehiclePlate/, 'vehicle plate must be persisted in state');
assert.match(app, /state\.vehicleInfo/, 'vehicle info must be persisted in state');

assert.match(index, /id="vehiclePlate"/, 'settings UI must include vehicle plate input');
assert.match(index, /id="vehicleLookupButton"/, 'settings UI must include vehicle lookup button');
assert.match(index, /id="vehicleLookupSummary"/, 'settings UI must include vehicle lookup summary');
assert.match(index, /href="https:\/\/nummerplade-tjek\.dk"/, 'vehicle lookup UI must include the visible Nummerplade Tjek backlink');
assert.match(index, /class="section-note wide vehicle-lookup-credit"/, 'vehicle lookup backlink must sit next to the lookup controls');
assert.doesNotMatch(index, /nummerplade-tjek\.dk[\s\S]{0,160}nofollow/, 'vehicle lookup backlink must not use nofollow');

assert.match(server, /if self\.path == "\/api\/vehicle\/lookup"/, 'server must mount /api/vehicle/lookup');
assert.match(server, /def lookup_vehicle_backend\(self\):/, 'server must implement vehicle lookup handler');
assert.match(server, /current_supabase_user\(self\)/, 'server lookup must verify Supabase auth');
assert.match(server, /get_member_context_as_service_fast\(ledger_id, user, timeout=3\)/, 'server lookup must verify active workspace membership through the fast lookup context');
assert.match(server, /VEHICLE_LOOKUP_API_KEY/, 'server must keep vehicle API key in environment');
assert.match(server, /VEHICLE_LOOKUP_PROVIDER_UNAVAILABLE/, 'server must convert provider network failures to a safe lookup result code');
assert.match(server, /classify_vehicle_provider_http_error/, 'provider HTTP errors must be safely classified.');
assert.match(server, /self\.send_json\(\{"ok": False, "code": code[\s\S]*status=200/, 'provider HTTP errors must not return browser-visible 5xx statuses');
assert.match(server, /sanitize_vehicle_lookup_response/, 'server must sanitize provider response');
assert.doesNotMatch(app, /VEHICLE_LOOKUP_API_KEY/, 'browser app must not reference vehicle API keys');
assert.match(env, /VEHICLE_LOOKUP_API_URL=/, 'env example must document vehicle lookup URL');
assert.match(env, /VEHICLE_LOOKUP_API_KEY=/, 'env example must document vehicle lookup key without value');
assert.match(server, /environment\.fuel_usage/, 'server must map Nummerplade Tjek km/l fuel usage');
assert.match(server, /environment\.co2_emission/, 'server must map Nummerplade Tjek CO2 emissions');
assert.match(server, /vehicle\.first_reg_date/, 'server must map Nummerplade Tjek first registration date');
assert.match(server, /vehicle\.engine_volume/, 'server must map Nummerplade Tjek engine volume');
assert.match(server, /vehicle\.engine_power/, 'server must map Nummerplade Tjek engine power');
assert.match(server, /environment\.euro_norm/, 'server must map Nummerplade Tjek euro norm');
assert.match(server, /vehicle\.mot_info\.next_inspection_date/, 'server must map Nummerplade Tjek MOT next inspection date');
assert.match(app, /firstRegDate/, 'browser app must preserve sanitized first registration date');
assert.match(app, /engineVolumeCc/, 'browser app must preserve sanitized engine volume');
assert.match(app, /nextInspectionDate/, 'browser app must preserve sanitized inspection date');
assert.match(server, /Keep VIN\/raw equipment out of the browser payload/, 'server must avoid sending VIN/raw equipment by default');
assert.match(env, /VEHICLE_LOOKUP_API_URL=https:\/\/nummerplade-tjek\.dk\/api\/v1\/vehicles\/\{plate\}/, 'env example must default to Nummerplade Tjek endpoint');
assert.match(env, /VEHICLE_LOOKUP_API_KEY_HEADER=X-API-Key/, 'env example must use Nummerplade Tjek API-key header');
assert.match(env, /VEHICLE_LOOKUP_API_KEY_PREFIX=\n/, 'env example must not prefix Nummerplade Tjek API keys');

assert.match(server, /"ledger": ledger/, 'Render state-load must return the active ledger row so workspace settings do not inherit another workspace');
assert.match(app, /const renderLedger = renderStateRows && renderStateRows\.ledger/, 'normalized load must prefer the active Render ledger row for workspace settings');
assert.match(app, /const minimumSettingsMembers = currentSession \? 1 : 2;/, 'signed-in normalized workspaces must allow settings save with one active member');
assert.doesNotMatch(app, /fuelType: ledger\.fuel_type \|\| jsonFallbackState\.fuelType/, 'workspace fuel type must not fall back to another workspace JSON value when a ledger row is loaded');

console.log('Vehicle lookup foundation guard passed.');
