import { readFileSync } from 'fs';

const app = readFileSync('app.js', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

assert(app.includes('function isOptionalWorkspaceToolsOperation'), 'workspace/invite refresh must be identifiable as an optional admin panel');
assert(app.includes('function isOptionalAdminPanelOperation'), 'optional admin panels must be grouped for latest Data I/O filtering');
assert(app.includes('operations.filter((operation) => !isOptionalAdminPanelOperation(operation))'), 'Latest Data I/O must ignore optional admin panel failures');
assert(app.includes('This card ignores optional Admin panels'), 'Latest Data I/O card must explain why optional admin panels are not global app failures');
assert(app.includes('markOptionalAdminPanelsReadyForManualRefresh("admin-tab-open")'), 'opening Admin should not auto-refresh optional panels');
assert(!app.includes('scheduleWorkspaceInviteRefresh("admin-tab-open")'), 'opening Admin must not auto-refresh workspace/invite tools');
assert(!app.includes('refreshOwnerActivity({ silent: true, reason: "admin-tab-open" }'), 'opening Admin must not auto-refresh owner activity');
assert(app.includes('Workspace/invite panel refresh timed out. Existing workspace data remains usable'), 'workspace refresh timeout must be framed as optional stale admin data');
assert(app.includes('skipped ? ` · ${skipped} skipped`'), 'Data I/O section summaries must count skipped rows separately from problems');

console.log('Optional admin panels latest Data I/O guardrail passed.');
