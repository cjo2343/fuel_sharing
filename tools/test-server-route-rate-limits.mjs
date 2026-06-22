import fs from 'node:fs';
import assert from 'node:assert/strict';

const server = fs.readFileSync('server.py', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:203|204|205|206|207|208|209|210|211|212|213|214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251|252|253|254|255|256|257|258|259|260|261|262|263|264|265|266|267|268|269|270|271|272|273|274|275|276|277|277|277)"/, 'build-info should publish v303');
assert.match(buildInfo, /buildLabel:\s*"(?:workspace-action-authority-lane|owner-passive-background-sync-calm-lane|render-api-client-extraction-lane|update-prompt-bridge-workspace-retention-lane|update-prompt-workspace-visibility-lane|general-action-route-timing-lane|action-session-cache-shell-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|no-refresh-action-chain-lane|post-action-unblock-lane|multi-workspace-authority-lane|admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, 'build-info should use v303 label');
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v[34][0-9][0-9]"/, 'build-info should expect v303 cache');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v[34][0-9][0-9]"/, 'service worker cache should be v303');
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:workspace-action-authority-lane|owner-passive-background-sync-calm-lane|render-api-client-extraction-lane|update-prompt-bridge-workspace-retention-lane|update-prompt-workspace-visibility-lane|general-action-route-timing-lane|action-session-cache-shell-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|no-refresh-action-chain-lane|post-action-unblock-lane|multi-workspace-authority-lane|admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, 'service worker label should match v303');

assert.match(server, /RATE_LIMIT_POLICIES\s*=\s*\{/, 'server should define rate limit policies');
assert.match(server, /def check_backend_rate_limit\(/, 'server should centralize backend rate-limit checks');
assert.match(server, /send_response\(429,\s*"Too Many Requests"\)/, 'server should fail closed with HTTP 429 when rate limited');
assert.match(server, /Retry-After/, 'rate-limit response should include Retry-After');
assert.match(server, /FUEL_LEDGER_DISABLE_RATE_LIMITS/, 'server should allow explicit local/test disable flag');
assert.match(server, /FUEL_LEDGER_RATE_LIMIT_/, 'server should allow per-scope environment overrides');
assert.match(server, /"admin-heavy"/, 'server should define stricter heavy-admin limits');
assert.match(server, /"json-backup"/, 'server should rate-limit JSON mirror backups');
assert.match(server, /"write-context"/, 'server should rate-limit write-context setup');

const guardedRoutes = [
  ['/api/state/load', 'state-load'],
  ['/api/context/write', 'write-context'],
  ['/api/backups/json-mirror', 'json-backup'],
  ['/api/ledgers/sync', 'admin'],
  ['/api/admin/test-data/create', 'admin-heavy'],
  ['/api/admin/test-data/cleanup', 'admin-heavy'],
  ['/api/admin/health', 'admin-health'],
  ['/api/admin/retention/preview', 'admin'],
  ['/api/admin/retention/cleanup', 'admin-heavy'],
  ['/api/trips/upsert', 'write'],
  ['/api/fuel/upsert', 'write'],
  ['/api/bookings/upsert', 'write'],
  ['/api/bookings/delete', 'write'],
  ['/api/payments/status-action', 'write'],
];
for (const [route, scope] of guardedRoutes) {
  assert.match(server, new RegExp(route.replaceAll('/', '\\/')), `${route} should remain mounted`);
  assert.match(server, new RegExp(`check_backend_rate_limit\\(self, "${scope}"`), `${route} should use ${scope} rate limit`);
}

assert.match(server, /"server-rate-limits"/, 'admin health should surface the rate-limit guard');
assert.match(packageJson, /test-server-route-rate-limits\.mjs/, 'validate should run the v303 guard test');

console.log('Server route rate limits guard check passed.');
