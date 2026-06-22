import fs from 'node:fs';
import assert from 'node:assert/strict';

const server = fs.readFileSync('server.py', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');

assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v[34][0-9][0-9]"/, 'service worker cache should be v303');

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
