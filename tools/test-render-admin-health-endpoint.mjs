import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:203|204|205|206|207|208|209|210|211|212|213|214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251)"/, 'build-info should publish v303');
assert.match(buildInfo, /buildLabel:\s*"(?:server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, 'build-info should use v303 label');
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v3[0-9][0-9]"/, 'build-info should expect v303 cache');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v3[0-9][0-9]"/, 'service worker cache should be v303');
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, 'service worker label should match v303');

assert.match(server, /"\/api\/admin\/health"/, 'server should mount /api/admin/health');
assert.match(server, /def admin_health_backend\(self\):/, 'server should implement admin health handler');
assert.match(server, /build_render_admin_health\(ledger_id, user, token\)/, 'handler should build Render admin health');
assert.match(server, /assert_user_can_admin_ledger\(ledger_id, user, user_token\)/, 'admin health should verify workspace admin rights');
assert.match(server, /"\/api\/backups\/json-mirror"/, 'health payload should include JSON mirror backup route');
assert.match(server, /"\/api\/admin\/retention\/preview"/, 'health payload should include retention preview route');
assert.match(server, /"\/api\/admin\/test-data\/cleanup"/, 'health payload should include test-data cleanup route');
assert.match(server, /"\/api\/context\/write"/, 'health payload should include write-context route');

assert.match(app, /const renderAdminHealthUrl = "\/api\/admin\/health";/, 'app should know Render admin health URL');
assert.match(app, /renderAdminHealthStatus/, 'app should track Render admin health status');
assert.match(app, /async function checkRenderAdminHealth/, 'app should call Render admin health');
assert.match(app, /source: "admin-render-health"/, 'app should record admin-render-health Data I/O');
assert.match(app, /getFreshRenderAccessToken\(\)/, 'admin health should refresh the Supabase access token before calling Render');
assert.match(app, /RENDER_AUTH_NOT_READY/, 'admin health should treat backend auth rejection as a session-not-ready state');
assert.match(app, /skipped: true/, 'admin health session-not-ready results should not make the outer admin-tool row failed');
assert.match(server, /verify_supabase_user_via_jwks/, 'server auth should verify Supabase asymmetric JWTs through JWKS/public keys');
assert.match(server, /SUPABASE_AUTH_NETWORK_FALLBACK/, 'network auth fallback should be an explicit emergency escape hatch, not the normal path');
assert.match(app, /Render did not accept the current sign-in yet/, 'admin health should show a clear session-not-ready message instead of a raw 401');
assert.match(app, /renderAdminHealthStatus\s*\}/, 'load report should export Render admin health status');
assert.match(app, /function renderRenderAdminHealthCard\(\)/, 'load monitor should render a health card');
assert.match(html, /id="checkRenderAdminHealth"/, 'Admin UI should expose a Render health button');

console.log('Render admin health endpoint guard check passed.');
