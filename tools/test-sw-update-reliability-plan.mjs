import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");

// 1. Module flags for the new reliability paths exist
assert.match(app, /let appUpdateDeployMismatch = false;/, "app.js must declare appUpdateDeployMismatch flag");
assert.match(app, /let appUpdateAutoActivatedThisLoad = false;/, "app.js must declare appUpdateAutoActivatedThisLoad one-shot flag");
assert.match(app, /let appUpdateActivationInFlight = false;/, "app.js must declare appUpdateActivationInFlight one-shot guard");

// 2. renderAppUpdateToast shows on deploy mismatch, not just waiting worker
assert.match(app, /Boolean\(\(appUpdateReady && appUpdateWaitingWorker\) \|\| appUpdateDeployMismatch\)/, "renderAppUpdateToast must show on deploy mismatch as well as waiting worker");

// 3. fuel-ledger-build-update-available handler sets the mismatch flag
assert.match(
  app,
  /window\.addEventListener\("fuel-ledger-build-update-available"[\s\S]{0,300}appUpdateDeployMismatch = true/,
  "build-update-available handler must set appUpdateDeployMismatch"
);

// 4. Auto-activation one-shot guard in the event handler
assert.match(
  app,
  /appUpdateAutoActivatedThisLoad[\s\S]{0,400}auto-stale-controller/,
  "build-update-available handler must auto-activate once with auto-stale-controller reason"
);

// 5. activateReadyAppUpdate has the in-flight guard
assert.match(
  app,
  /appUpdateActivationInFlight[\s\S]{0,120}Activation already in progress/,
  "activateReadyAppUpdate must bail early when activation is already in flight"
);

// 6. activateReadyAppUpdate: tier 1 — waiting worker path (existing behaviour preserved)
assert.match(app, /appUpdateWaitingWorker\.postMessage\(\{ type: "SKIP_WAITING" \}\)/, "tier-1 path must postMessage SKIP_WAITING to waiting worker");

// 7. activateReadyAppUpdate: tier 2 — registration.update() then waiting
assert.match(
  app,
  /await registration\.update\(\)[\s\S]{0,200}registration\.waiting/,
  "tier-2 path must call registration.update() then check registration.waiting"
);

// 8. activateReadyAppUpdate: tier 3 — unregister + reload (Safari fallback)
assert.match(app, /await registration\.unregister\(\)/, "tier-3 Safari escape hatch must call registration.unregister()");
assert.match(
  app,
  /await registration\.unregister\(\)[\s\S]{0,100}window\.location\.reload\(\)/,
  "tier-3 unregister must be followed by location.reload()"
);

// 9. Auto-activation is pending-write-safe
assert.match(
  app,
  /appUpdateAutoActivatedThisLoad[\s\S]{0,600}hasForegroundWriteInFlight[\s\S]{0,500}activateReadyAppUpdate/,
  "auto-activation must check hasForegroundWriteInFlight before calling activateReadyAppUpdate"
);

// 10. controllerchange reload is still one-shot guarded (existing behaviour)
assert.match(app, /serviceWorkerControllerChanged = true/, "controllerchange must remain guarded by a one-shot flag");

// 11. Service worker still handles SKIP_WAITING message
assert.match(serviceWorker, /event\.data\?\.type === "SKIP_WAITING"[\s\S]{0,60}self\.skipWaiting\(\)/, "service-worker must still call self.skipWaiting() on SKIP_WAITING message");

// 12. appUpdateDeployMismatch reset on activation and dismiss
assert.match(
  app,
  /appUpdateDeployMismatch = false[\s\S]{0,200}recordSyncDiagnostic\("service-worker-update-accepted"/,
  "activation path must reset appUpdateDeployMismatch before recording acceptance"
);
assert.match(
  app,
  /appUpdateDismiss[\s\S]{0,200}appUpdateDeployMismatch = false/,
  "dismiss handler must reset appUpdateDeployMismatch"
);

console.log("SW update reliability plan guardrails passed.");
