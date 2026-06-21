import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');

assert(app.includes('const vehicleLookupMaxAttempts = 2'), 'vehicle lookup should try more than once before reporting a timeout');
assert(app.includes('callRenderJsonWithUserActionRecovery'), 'app should have a reusable user-action Render recovery helper');
assert(app.includes('isRecoverableRenderActionError'), 'app should classify timeout/network/5xx lookup failures as recoverable');
assert(app.includes('VEHICLE_LOOKUP_AUTO_RETRY'), 'vehicle lookup should record a stable auto-retry Data I/O breadcrumb');
assert(app.includes('Vehicle lookup is retrying automatically after reconnecting'), 'vehicle lookup UI should tell the user when the automatic retry is running');
assert(app.includes('attempts: vehicleLookupMaxAttempts'), 'vehicle lookup should call Render through the retry helper');
assert(app.includes('recoveryReason: "vehicle-lookup"'), 'vehicle lookup recovery should be labeled for diagnostics');
assert(app.includes('scheduleRenderBackendWake(`${reason}-recover`)'), 'recoverable user action failures should wake the backend before retrying');
assert(!app.includes('try the lookup again in a moment if it does not start.";\n    scheduleRenderBackendWake("vehicle-lookup-retry");\n    return false;'), 'vehicle lookup should not ask for a manual retry when it can recover automatically');

console.log('vehicle lookup automatic retry/recovery guardrails passed.');
