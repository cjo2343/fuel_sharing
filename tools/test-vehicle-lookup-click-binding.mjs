import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');

const required = [
  'function getVehicleLookupDomSnapshot()',
  'function handleVehicleLookupButtonClick(event = null)',
  'document.addEventListener("click", (event) => {',
  'event.target?.closest?.("#vehicleLookupButton")',
  'VEHICLE_LOOKUP_CLICKED',
  'VEHICLE_LOOKUP_PLATE_MISSING',
  'buttonBound: Boolean(dom.button?.dataset?.vehicleLookupBound === "true")',
  'clickShouldStartRecovery: currentSessionActive && canManage && Boolean(plate)',
  'els.vehicleLookupButton.disabled = !canManage || !currentSession'
];

for (const needle of required) {
  if (!app.includes(needle)) {
    throw new Error(`Missing vehicle lookup click-binding guardrail: ${needle}`);
  }
}

if (!/recordDataIoDiagnostic\("start", \{\s*source: "vehicle-lookup-click"[\s\S]*resultCode: "VEHICLE_LOOKUP_CLICKED"/.test(app)) {
  throw new Error('Vehicle lookup clicks must record a breadcrumb before workspace/backend guards run.');
}

if (!/document\.addEventListener\("click"[\s\S]*#vehicleLookupButton[\s\S]*handleVehicleLookupButtonClick\(event\)/.test(app)) {
  throw new Error('Vehicle lookup needs delegated click handling so re-rendered buttons cannot go dead.');
}

if (/els\.vehicleLookupButton\.disabled = !canEditSettings \|\| !currentSession/.test(app)) {
  throw new Error('Vehicle lookup button must stay clickable during workspace settling so the handler can recover context.');
}

console.log('vehicle lookup click binding guardrail passed');
