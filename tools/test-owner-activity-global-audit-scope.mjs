import { readFileSync } from 'fs';

const app = readFileSync('app.js', 'utf8');
const styles = readFileSync('styles.css', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

assert(app.includes('ownerActivityScope'), 'owner activity must have an explicit current/all workspace scope');
assert(app.includes('data-owner-activity-scope="current"'), 'owner activity UI must expose a current-workspace filter');
assert(app.includes('data-owner-activity-scope="all"'), 'owner activity UI must expose an all-workspaces audit filter');
assert(app.includes('Global app-owner audit across users and workspaces'), 'owner activity copy must explain that other users/workspaces are normal audit data');
assert(app.includes('ownerActivityVisibleRows'), 'owner activity must filter visible rows by current workspace by default');
assert(app.includes('ledgerId: ownerActivityLoadedWorkspaceId()'), 'owner activity backend request must filter current-workspace loads by ledgerId');
assert(app.includes('maybeLoadOwnerActivityOnAdminOpen'), 'admin open should use a one-time owner activity load helper');
assert(!app.includes('ownerActivityBackgroundIntervalMs = 60000'), 'owner activity must not run a hidden recurring background interval');
assert(!app.includes('reason: "admin-background"'), 'owner activity must not auto-refresh from a background admin interval');
assert(app.includes('isOptionalOwnerActivityOperation'), 'latest global Data I/O must be able to exclude optional owner-activity audit failures');
assert(styles.includes('.owner-activity-scope'), 'owner activity scope controls must have dedicated styling');
assert(styles.includes('.owner-activity-workspace-grid'), 'owner activity workspace summary must have dedicated styling');

console.log('Owner activity global audit scope guardrail passed.');
