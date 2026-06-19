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
assert.match(app, /Authorization": `Bearer \$\{currentSession\.access_token\}`/, 'vehicle lookup must use signed-in Supabase bearer token');
assert.match(app, /applyVehicleLookupToSettings/, 'vehicle lookup must apply suggested fuel settings only through app logic');
assert.match(app, /state\.vehiclePlate/, 'vehicle plate must be persisted in state');
assert.match(app, /state\.vehicleInfo/, 'vehicle info must be persisted in state');

assert.match(index, /id="vehiclePlate"/, 'settings UI must include vehicle plate input');
assert.match(index, /id="vehicleLookupButton"/, 'settings UI must include vehicle lookup button');
assert.match(index, /id="vehicleLookupSummary"/, 'settings UI must include vehicle lookup summary');

assert.match(server, /if self\.path == "\/api\/vehicle\/lookup"/, 'server must mount /api/vehicle/lookup');
assert.match(server, /def lookup_vehicle_backend\(self\):/, 'server must implement vehicle lookup handler');
assert.match(server, /current_supabase_user\(self\)/, 'server lookup must verify Supabase auth');
assert.match(server, /get_state_load_context_as_service\(ledger_id, user\)/, 'server lookup must verify active workspace membership');
assert.match(server, /VEHICLE_LOOKUP_API_KEY/, 'server must keep vehicle API key in environment');
assert.match(server, /sanitize_vehicle_lookup_response/, 'server must sanitize provider response');
assert.doesNotMatch(app, /VEHICLE_LOOKUP_API_KEY/, 'browser app must not reference vehicle API keys');
assert.match(env, /VEHICLE_LOOKUP_API_URL=/, 'env example must document vehicle lookup URL');
assert.match(env, /VEHICLE_LOOKUP_API_KEY=/, 'env example must document vehicle lookup key without value');

console.log('Vehicle lookup foundation guard passed.');
