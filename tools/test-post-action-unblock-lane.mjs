import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(buildInfo, /buildLabel:\s*"post-action-unblock-lane"/, 'build-info should use post-action unblock label');
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"post-action-unblock-lane"/, 'service worker should use post-action unblock label');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v402"/, 'service worker cache should be v402');

assert.match(app, /async function saveBookingToNormalizedTablesFirst\(booking\)[\s\S]*let savedThroughNormalizedTables = false;[\s\S]*finally \{[\s\S]*finishForegroundOperationsBySource\("booking-save", savedThroughNormalizedTables \? "booking-save-normalized-write-saved" : "booking-save-normalized-write-ended"\);[\s\S]*clearVisibleSavingFailsafe\(\);[\s\S]*\}/, 'booking saves must always clear the foreground booking-save latch');
assert.match(app, /if \(rpcResult\.ok\) \{[\s\S]*savedThroughNormalizedTables = true;[\s\S]*setSyncStatus\("Tables"\);[\s\S]*return true;[\s\S]*\}/, 'successful booking save should leave visible sync status healthy before the local audit backup queues');
assert.match(app, /function clearVehicleLookupForPlateChange\(\) \{[\s\S]*const plate = getVehicleLookupInputPlate\(\);[\s\S]*if \(plate\) state\.vehiclePlate = plate;/, 'typing a new plate should preserve the draft across renders before lookup');
assert.match(app, /function handleVehicleLookupButtonClick\(event = null\)[\s\S]*const plate = normalizeVehiclePlateInput\(dom\.plateInput\?\.value \|\| state\.vehiclePlate \|\| ""\);[\s\S]*if \(plate\) state\.vehiclePlate = plate;/, 'vehicle lookup click should lock the requested plate before async workspace/backend checks');
assert.match(app, /async function closeNormalizedPeriodFirst\(periodSnapshot\)[\s\S]*finally \{[\s\S]*finishForegroundOperationsBySource\("period-close", "period-close-normalized-write-ended"\);[\s\S]*clearVisibleSavingFailsafe\(\);[\s\S]*\}/, 'period close should not leave a foreground saving latch behind');

console.log('Post-action unblock lane guardrails passed.');
