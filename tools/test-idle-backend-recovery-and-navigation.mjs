import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const sw = fs.readFileSync('service-worker.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');

assert(app.includes('const renderBackendPingUrl = "/api/ping"'), 'app should define a lightweight Render backend ping route');
assert(app.includes('ensureRenderBackendReadyForUserAction'), 'app should have a backend readiness helper for idle recovery');
assert(app.includes('pingRenderBackend'), 'app should ping Render before sensitive actions after idle');
assert(app.includes('Checking backend connection before vehicle lookup'), 'vehicle lookup should visibly wait for backend recovery before the provider call');
assert(app.includes('scheduleRenderBackendWake("visible-live-sync-keepalive")'), 'Live Sync should keep the backend gently warm while visible');
assert(app.includes('scheduleRenderBackendWake("visible-resume")'), 'visible resume should warm the backend after idle/background');
assert(app.includes('renderBackendWakeLastOkAt'), 'backend wake should cache recent success to avoid excessive pings');
assert(app.includes('VEHICLE_LOOKUP_BACKEND_NOT_READY') || app.includes('RENDER_BACKEND_WAKE_FAILED'), 'vehicle lookup should have a stable backend-not-ready result code path');

assert(sw.includes('request.mode === "navigate"'), 'service worker should treat navigations specially');
assert(sw.includes('matchNavigationShell'), 'service worker should have a reusable app-shell fallback');
assert(sw.includes('ignoreSearch: request.mode === "navigate"'), 'service worker should ignore query strings for navigation fallback');
assert(!sw.includes('if (request.mode === "navigate") return caches.match("/");'), 'service worker should not use the old query-sensitive navigation fallback');

assert(server.includes('parsed_path == "/api/ping"'), 'server should expose a lightweight /api/ping wake route');
assert(server.includes('"service": "fuel-ledger-render"'), 'ping response should identify the Render backend');

console.log('Idle backend recovery and navigation fallback guardrails passed.');
