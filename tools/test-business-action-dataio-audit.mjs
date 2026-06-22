import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const auditLog = fs.readFileSync('audit-log.js', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');

assert.match(app, /source: "vehicle-lookup"/, 'vehicle lookup should have its own Data I/O source');
assert.match(app, /saveState\(\{ queueRemote: false, reason: "vehicle lookup local audit breadcrumb" \}\)/, 'vehicle lookup should not leave a queued full-state save behind');
assert.match(app, /resultCode: "VEHICLE_LOOKUP_STARTED"/, 'vehicle lookup should record a started result code');
assert.match(app, /resultCode: "VEHICLE_LOOKUP_OK"/, 'vehicle lookup should record a success result code');
assert.match(app, /type: "vehicle_lookup_completed"/, 'vehicle lookup should add a safe persistent audit breadcrumb');
assert.doesNotMatch(app, /rawProvider|vin\s*:/i, 'vehicle lookup audit should not persist raw provider payloads or VIN details');

assert.match(app, /source: "settings-save"/, 'group settings save should have its own Data I/O source');
assert.match(app, /saveState\(\{ queueRemote: false, reason: "group settings explicit save" \}\)/, 'settings save should stage locally without a stale queued browser full-state save');
assert.match(app, /renderSupabaseLoadMonitor\(\);[\s\S]*render\(\);/, 'settings save should refresh Data I/O monitor after a successful explicit save');
assert.match(app, /resultCode: "SETTINGS_SAVE_STARTED"/, 'group settings save should record a started result code');
assert.match(app, /resultCode: "SETTINGS_SAVED"/, 'group settings save should record a success result code');
assert.match(app, /type: "settings_saved"/, 'group settings save should add a persistent audit breadcrumb');

assert.match(app, /(?:resultCode|startResultCode): "TRIP_SAVE_STARTED"/, 'trip save should expose a started Data I/O result code');
assert.match(app, /(?:resultCode|successResultCode): "TRIP_SAVED"/, 'trip save should expose a success Data I/O result code');
assert.match(app, /type: wasEditingTrip \? "trip_updated" : "trip_created"/, 'trip create/update should remain persistently audited');

assert.match(app, /(?:resultCode|startResultCode): "FUEL_SAVE_STARTED"/, 'fuel save should expose a started Data I/O result code');
assert.match(app, /(?:resultCode|successResultCode): "FUEL_SAVED"/, 'fuel save should expose a success Data I/O result code');
assert.match(app, /type: wasEditingFuel \? "fuel_updated" : "fuel_created"/, 'fuel create/update should remain persistently audited');

assert.match(app, /resultCode: "ENTRY_DELETE_STARTED"/, 'entry soft-delete should expose a started Data I/O result code');
assert.match(app, /resultCode: "ENTRY_DELETED"/, 'entry soft-delete should expose a success Data I/O result code');
assert.match(app, /trip_deleted/, 'trip deletes should remain persistently audited');
assert.match(app, /fuel_deleted/, 'fuel deletes should remain persistently audited');

assert.match(app, /vehicle-lookup\|settings-save\|trip-save\|fuel-save\|trips-delete\|fuel-delete\|bookings-delete[\s\S]*return "Member actions"/, 'business actions should group under visible Member actions');
assert.match(app, /state-load\|write-context[\s\S]*return "Sync\/load\/write actions"/, 'infrastructure load/context activity should stay under sync/load/write diagnostics');
assert.match(auditLog, /vehicle_lookup_completed: "Vehicle lookup completed"/, 'audit labels should include vehicle lookup');
assert.match(auditLog, /settings_saved: "Settings saved"/, 'audit labels should include settings saves');
assert.match(buildInfo, /Member-facing vehicle lookup, settings, trip, fuel, booking, payment, and settlement actions now group under Member actions/, 'release notes should mention visible member Data I/O follow-up');
assert.match(app, /function normalizeVehicleText/, 'vehicle lookup summary should have a helper for hiding provider placeholders');
assert.match(app, /unknown\|ukendt\|ingen\|ingen norm/, 'vehicle lookup summary should hide unknown/Ingen placeholder values');
assert.match(pkg, /test-business-action-dataio-audit\.mjs/, 'validate script should run the business-action Data I/O/audit guard');

console.log('Business action Data I/O and audit guardrails passed.');
