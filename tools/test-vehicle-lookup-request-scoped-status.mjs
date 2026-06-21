import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');

const required = [
  'function getVehicleLookupInputPlate()',
  'function setVehicleLookupStatus(message = "", options = {})',
  'function setVehicleLookupSummary(message = "", options = {})',
  'function getSavedVehicleInfoForCurrentInput()',
  'function clearVehicleLookupForPlateChange()',
  'VEHICLE_LOOKUP_STALE_RESULT_IGNORED',
  'requestedPlate: plate',
  'returnedPlate: lookedUpVehicleInfo?.plate || ""',
  'statusPlate: String(dom.status?.dataset?.lookupPlate || "")',
  'summaryPlate: String(dom.summary?.dataset?.lookupPlate || "")',
  'savedVehiclePlate: savedInfo?.plate || ""'
];

for (const needle of required) {
  if (!app.includes(needle)) {
    throw new Error(`Missing request-scoped vehicle lookup guardrail: ${needle}`);
  }
}

if (!/if \(expectedPlate && info\.plate && info\.plate !== expectedPlate\) \{[\s\S]*VEHICLE_LOOKUP_STALE_RESULT_IGNORED[\s\S]*return false;/.test(app)) {
  throw new Error('Vehicle lookup must ignore returned plates that do not match the requested plate.');
}

if (!/els\.vehiclePlate\.addEventListener\("input", clearVehicleLookupForPlateChange\)/.test(app)) {
  throw new Error('Changing the plate input must clear stale vehicle lookup status.');
}

if (/els\.vehicleLookupSummary\.textContent = `\$\{info\.plate \|\| state\.vehiclePlate/.test(app)) {
  throw new Error('Vehicle lookup summary must not fall back to stale state.vehiclePlate for display.');
}

console.log('vehicle lookup request-scoped status guardrail passed');
