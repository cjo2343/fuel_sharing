import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');

assert(app.includes('async function ensureVehicleLookupWorkspaceContext'), 'vehicle lookup should verify workspace context before Render lookup');
assert(app.includes('getActiveLedgerId() || urlWorkspaceId'), 'vehicle lookup should prefer the selected in-app workspace before URL state when checking context');
assert(app.includes('VEHICLE_LOOKUP_WORKSPACE_CONTEXT_RELOAD'), 'vehicle lookup should record workspace context reloads before lookup');
assert(app.includes('VEHICLE_LOOKUP_WORKSPACE_CONTEXT_READY'), 'vehicle lookup should record when the requested workspace is confirmed before lookup');
assert(app.includes('VEHICLE_LOOKUP_WORKSPACE_CONTEXT_TIMEOUT'), 'vehicle lookup should fail closed when the requested workspace cannot be confirmed');
assert(app.includes('refreshAuthBoundMemberProfile()'), 'vehicle lookup should refresh the auth-bound member/admin profile after loading workspace context');
assert(app.includes('selectedWorkspaceId: workspaceContext.selectedWorkspaceId'), 'vehicle lookup diagnostics should include selected workspace id');
assert(app.includes('loadedWorkspaceId: workspaceContext.loadedWorkspaceId'), 'vehicle lookup diagnostics should include loaded workspace id');
assert(app.includes('requestedWorkspaceId: workspaceReady.requestedWorkspaceId || ledgerId'), 'vehicle lookup diagnostics should include requested workspace id');
assert(app.includes('body: {\n        ledgerId,\n        plate,\n        selectedWorkspaceId: workspaceContext.selectedWorkspaceId'), 'vehicle lookup request should carry explicit workspace context');
assert(app.indexOf('const workspaceReady = await ensureVehicleLookupWorkspaceContext') < app.indexOf('callRenderJsonWithUserActionRecovery(renderVehicleLookupUrl'), 'workspace context must be confirmed before the Render lookup call');

assert(app.includes('preferredWorkspaceId: requestedWorkspaceId'), 'vehicle lookup backend context should receive the selected workspace as explicit preferred workspace');

console.log('vehicle lookup workspace-context guardrails passed.');
