import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');

assert.match(app, /let appStartupGateState = \{/, 'startup wake gate state should be tracked explicitly');
assert.match(app, /async function ensureAppStartupWakeGate\(reason = "startup"/, 'startup should have one ordered wake/context/state gate');
assert.match(app, /setAppStartupGatePhase\("waking-backend"/, 'startup gate should wake Render before context/state work');
assert.match(app, /ensureRenderBackendReadyForUserAction\(\{ reason: `startup-gate:\$\{normalizedReason\}`/, 'startup gate should use the Render wake helper');
assert.match(app, /setAppStartupGatePhase\("hydrating-context"/, 'startup gate should hydrate backend app context after wake');
assert.match(app, /hydrateAppSessionContext\(\{ reason: normalizedReason, source: "startup-wake-gate"/, 'startup gate should own backend context hydration');
assert.match(app, /setAppStartupGatePhase\("loading-state"/, 'startup gate should load workspace state after context');
assert.match(app, /reason: `startup-wake-gate:\$\{normalizedReason\}`/, 'startup state load should be labeled as the wake-gate lane');
assert.match(app, /subscribeToLedgerEvents\(\);\n\s*subscribeToSupabaseState\(\);\n\s*setAppStartupGatePhase\("ready"/, 'realtime subscriptions should start only after workspace state is ready');
assert.match(app, /function shouldDelayOptionalStartupLane/, 'optional startup lanes should have a shared gate predicate');
assert.match(app, /Skipped focus sync until startup wake gate is ready/, 'focus sync should be delayed until startup gate is ready');
assert.match(app, /Skipped realtime resume until startup wake gate is ready/, 'realtime resume should be delayed until startup gate is ready');
assert.match(app, /WORKSPACE_REFRESH_STARTUP_GATED/, 'workspace tools refresh should be delayed until startup gate is ready');
assert.match(app, /Retry loading workspace/, 'startup failure should offer in-app retry instead of requiring browser refresh');
assert.match(app, /ensureAppStartupWakeGate\("manual-retry", \{ force: true \}\)/, 'sync-health action should retry the startup gate in-app');
assert.match(app, /appStartupGate: appStartupGateState/, 'load reports should export the startup gate state');

console.log('Startup wake gate lane guard passed.');
