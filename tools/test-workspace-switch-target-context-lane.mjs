import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const validations = fs.readFileSync('tools/run-validations.mjs', 'utf8');

assert.match(app, /let backendAppContextSyncTargetWorkspaceId = "";/, 'app context hydration should remember the in-flight target workspace');
assert.match(app, /let backendAppContextSyncReasonLabel = "";/, 'app context hydration should remember why the in-flight context exists');
assert.match(app, /const inFlightTarget = String\(backendAppContextSyncTargetWorkspaceId \|\| ""\)\.trim\(\);/, 'hydrate lane should inspect the target of an existing app-context request');
assert.match(app, /const sameTarget = !inFlightTarget \|\| !targetWorkspaceId \|\| inFlightTarget === targetWorkspaceId;/, 'only same-target app context hydrations may join each other');
assert.match(app, /APP_SESSION_CONTEXT_WAITED_FOR_DIFFERENT_TARGET/, 'different-target workspace switches should wait and then hydrate their own target context');
assert.match(app, /backendAppContextSyncTargetWorkspaceId = targetWorkspaceId;/, 'new app-context hydrations should publish their target workspace while in flight');
assert.match(app, /backendAppContextSyncTargetWorkspaceId = "";/, 'app-context target marker should clear when hydration finishes');
assert.match(app, /hydrateAppSessionContext\(\{[\s\S]*reason: `workspace-switch:\$\{source\}`,[\s\S]*preferredWorkspaceId: targetLedgerId,[\s\S]*force: true,/, 'workspace switching must force-hydrate the requested target workspace');
assert.match(validations, /test-workspace-switch-target-context-lane\.mjs/, 'validation suite must include the target-context guardrail');

console.log('Workspace switch target context guardrail passed.');
