import { readFileSync } from 'fs';

const app = readFileSync('app.js', 'utf8');
const server = readFileSync('server.py', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

assert(app.includes('const workspaceInviteRefreshFreshMs = 5000'), 'workspace refresh freshness window must exist');
assert(app.includes('WORKSPACE_REFRESH_RECENT'), 'duplicate workspace refreshes must be skipped with a readable result code');
assert(app.includes('WORKSPACE_REFRESH_IN_FLIGHT'), 'in-flight workspace refreshes must be grouped/skipped instead of piling up');
assert(app.includes('reason: `workspace-switch:${source}:${targetLedgerId}`'), 'workspace switching must force-load the selected workspace with a target-specific reason');
assert(app.includes('scheduleWorkspaceInviteRefresh(`switch-confirmed:${source}`)'), 'workspace switching should refresh the workspace tools after confirmed load');
assert(app.includes('staleHealthy') && app.includes('Last OK'), 'admin health timeouts after a recent OK must not overwrite the healthy core status');
assert(app.includes('function renderDataIoGroupedSections()'), 'Data I/O must render through grouped sections');
assert(app.includes('Vehicle & settings') && app.includes('Core loading') && app.includes('Background noise'), 'Data I/O grouping must expose user-readable categories');
assert(app.includes('const vehicleLookupTimeoutMs = 20000'), 'vehicle lookup client timeout must be long enough for backend membership and provider checks');
assert(app.includes('allowResultOkFalse: true') && app.includes('VEHICLE_LOOKUP_FAILED'), 'vehicle lookup must record structured provider/config result codes even when ok=false');
assert(server.includes('VEHICLE_LOOKUP_TIMEOUT_SECONDS'), 'server vehicle provider timeout must be configurable');
assert(server.includes('get_member_context_as_service_fast(ledger_id, user, timeout=3)'), 'vehicle lookup membership check should stay fast');

console.log('Startup workspace diagnostics UX guardrail passed.');
