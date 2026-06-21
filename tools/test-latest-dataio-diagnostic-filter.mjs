import { readFileSync } from 'fs';

const app = readFileSync('app.js', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

assert(app.includes('function latestDataIoDiagnostic({ includeOptionalAdminAudit = false } = {})'), 'latest Data I/O diagnostic must support optional admin filtering');
assert(app.includes('diagnostics.filter((entry) => !isOptionalAdminPanelDiagnostic(entry))'), 'latest Data I/O diagnostic must ignore optional owner/workspace admin panels by default');
assert(app.includes('latestDataIoDiagnostic: latestDataIoDiagnostic()'), 'load reports must export the filtered latest Data I/O diagnostic');
assert(app.includes('latestOptionalAdminDataIoDiagnostic: latestDataIoDiagnostic({ includeOptionalAdminAudit: true })'), 'load reports must keep the unfiltered optional-admin diagnostic for debugging');
assert(app.includes('ownerActivityFetchInFlight || status.loading ? "disabled aria-disabled'), 'Owner Activity refresh button must be disabled while a request is running');
assert(!app.includes('OWNER_ACTIVITY_REFRESH_IN_FLIGHT'), 'duplicate owner-activity clicks should not create normal Data I/O skip noise');

console.log('Latest Data I/O diagnostic filtering guardrail passed.');
