import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v[34][0-9][0-9]"/, 'service worker cache should be v303');

assert.match(server, /"\/api\/admin\/health"/, 'server should mount /api/admin/health');
assert.match(server, /def admin_health_backend\(self\):/, 'server should implement admin health handler');
assert.match(server, /build_render_admin_health\(ledger_id, user, token\)/, 'handler should build Render admin health');
assert.match(server, /assert_user_can_admin_ledger\(ledger_id, user, user_token\)/, 'admin health should verify workspace admin rights');
assert.match(server, /"\/api\/backups\/json-mirror"/, 'health payload should include JSON mirror backup route');
assert.match(server, /"\/api\/admin\/retention\/preview"/, 'health payload should include retention preview route');
assert.match(server, /"\/api\/admin\/test-data\/cleanup"/, 'health payload should include test-data cleanup route');
assert.match(server, /"\/api\/context\/write"/, 'health payload should include write-context route');

assert.match(app, /const\s+renderAdminHealthUrl\s*=\s*renderApiEndpoints\.adminHealth\s*\|\|\s*"\/api\/admin\/health"/, 'app should know Render admin health URL');
assert.match(app, /renderAdminHealthStatus/, 'app should track Render admin health status');
assert.match(app, /async function checkRenderAdminHealth/, 'app should call Render admin health');
assert.match(app, /source: "admin-render-health"/, 'app should record admin-render-health Data I/O');
assert.match(app, /callRenderJson\(renderAdminHealthUrl,[\s\S]*timeoutLabel: "Render admin health API"[\s\S]*allowResultOkFalse: true/, 'admin health should use the shared full-timeout Render API helper while preserving needs-review health payloads');
assert.match(app, /RENDER_AUTH_NOT_READY/, 'admin health should treat backend auth rejection as a session-not-ready state');
assert.match(app, /skipped: true/, 'admin health session-not-ready results should not make the outer admin-tool row failed');
assert.match(server, /verify_supabase_user_via_jwks/, 'server auth should verify Supabase asymmetric JWTs through JWKS/public keys');
assert.match(server, /SUPABASE_AUTH_NETWORK_FALLBACK/, 'network auth fallback should be an explicit emergency escape hatch, not the normal path');
assert.match(app, /Render did not accept the current sign-in yet/, 'admin health should show a clear session-not-ready message instead of a raw 401');
assert.match(app, /renderAdminHealthStatus\s*\}/, 'load report should export Render admin health status');
assert.match(app, /function renderRenderAdminHealthCard\(\)/, 'load monitor should render a health card');
assert.match(html, /id="checkRenderAdminHealth"/, 'Admin UI should expose a Render health button');

// #16 — the health report must actually report health, not 20 always-green rows.
assert.doesNotMatch(server, /Route is mounted in this Render service\./, 'admin health should no longer emit hardcoded always-green route rows');
assert.doesNotMatch(server, /def build_render_admin_route_health/, 'the static route-health helper should be removed in favour of real probes');
assert.match(server, /def probe_supabase_reachability\(ledger_id, user_token\)/, 'admin health should run a real, timeout-bounded Supabase reachability probe');
assert.match(server, /timeout=6/, 'the Supabase probe should be short-timeout bounded');
assert.match(server, /"latencyMs": latency_ms/, 'the Supabase probe should report latency');
assert.match(server, /def classify_probe_error\(error\)/, 'probe failures should be reduced to a safe error class, not raw messages');
assert.match(server, /def build_vehicle_provider_health\(\)/, 'admin health should report vehicle provider health from cache');
assert.match(server, /provider not called on health checks/, 'vehicle provider must not be called on every health check');
assert.match(server, /LAST_VEHICLE_LOOKUP/, 'vehicle provider health should read the cached last-known outcome');
assert.match(server, /record_vehicle_lookup_outcome\(result\)/, 'vehicle lookup route should cache its outcome for the health report');
assert.match(server, /CRITICAL_RENDER_ROUTES/, 'critical Render routes should be a named dependency-gated set');
assert.match(server, /def build_render_runtime_signals/, 'admin health should surface Render runtime signals (uptime/version/latency)');
assert.match(server, /"uptimeSeconds":/, 'runtime signals should include process uptime');
assert.match(server, /"runtime": build_render_runtime_signals/, 'admin health response should include the runtime signal block');
assert.match(app, /status\.runtime/, 'health card should surface the server runtime signals');
assert.match(app, /check\.ok === false/, 'health card should split issues from passing rows (observability: anomalies first)');
assert.match(app, /function formatAdminHealthUptime/, 'health card should format uptime compactly');

console.log('Render admin health endpoint guard check passed.');
