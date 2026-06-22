import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(buildInfo, /buildLabel:\s*"(?:workspace-action-authority-lane|owner-passive-background-sync-calm-lane|render-api-client-extraction-lane|update-prompt-bridge-workspace-retention-lane|update-prompt-workspace-visibility-lane|general-action-route-timing-lane|action-session-cache-shell-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|post-action-unblock-lane|no-refresh-action-chain-lane)"/, 'build-info should use post-action unblock label');
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:workspace-action-authority-lane|owner-passive-background-sync-calm-lane|render-api-client-extraction-lane|update-prompt-bridge-workspace-retention-lane|update-prompt-workspace-visibility-lane|general-action-route-timing-lane|action-session-cache-shell-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|post-action-unblock-lane|no-refresh-action-chain-lane)"/, 'service worker should use post-action unblock label');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"(?:fuel-ledger-v(?:409|410|411|412|413|414|415|416|417|418)|fuel-ledger-v408|fuel-ledger-v407|fuel-ledger-v406|fuel-ledger-v405|fuel-ledger-v404|fuel-ledger-v403|fuel-ledger-v402)"/, 'service worker cache should be v402');

assert.match(app, /async function saveBookingToNormalizedTablesFirst\(booking\)[\s\S]*let savedThroughNormalizedTables = false;[\s\S]*finally \{[\s\S]*finishForegroundOperationsBySource\("booking-save", savedThroughNormalizedTables \? "booking-save-normalized-write-saved" : "booking-save-normalized-write-ended"\);[\s\S]*clearVisibleSavingFailsafe\(\);[\s\S]*\}/, 'booking saves must always clear the foreground booking-save latch');
assert.match(app, /if \(rpcResult\.ok\) \{[\s\S]*savedThroughNormalizedTables = true;[\s\S]*setSyncStatus\("Tables"\);[\s\S]*return true;[\s\S]*\}/, 'successful booking save should leave visible sync status healthy before the local audit backup queues');
assert.match(app, /function clearVehicleLookupForPlateChange\(\) \{[\s\S]*const plate = getVehicleLookupInputPlate\(\);[\s\S]*if \(plate\) state\.vehiclePlate = plate;/, 'typing a new plate should preserve the draft across renders before lookup');
assert.match(app, /function handleVehicleLookupButtonClick\(event = null\)[\s\S]*const plate = normalizeVehiclePlateInput\(dom\.plateInput\?\.value \|\| state\.vehiclePlate \|\| ""\);[\s\S]*if \(plate\) state\.vehiclePlate = plate;/, 'vehicle lookup click should lock the requested plate before async workspace/backend checks');
assert.match(app, /async function closeNormalizedPeriodFirst\(periodSnapshot\)[\s\S]*finally \{[\s\S]*finishForegroundOperationsBySource\("period-close", "period-close-normalized-write-ended"\);[\s\S]*clearVisibleSavingFailsafe\(\);[\s\S]*\}/, 'period close should not leave a foreground saving latch behind');

console.log('Post-action unblock lane guardrails passed.');
