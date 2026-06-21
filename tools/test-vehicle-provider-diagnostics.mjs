import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync('server.py', 'utf8');

assert.match(server, /def vehicle_provider_config_status\(\):/, 'server should expose safe vehicle provider config status.');
assert.match(server, /def classify_vehicle_provider_http_error\(status, body\):/, 'server should classify provider HTTP errors.');
assert.match(server, /VEHICLE_LOOKUP_PROVIDER_AUTH_FAILED/, 'vehicle lookup should distinguish provider auth failures.');
assert.match(server, /VEHICLE_LOOKUP_PROVIDER_RATE_LIMITED/, 'vehicle lookup should distinguish provider rate limits.');
assert.match(server, /VEHICLE_LOOKUP_NO_MATCH/, 'vehicle lookup should distinguish provider no-match responses.');
assert.match(server, /VEHICLE_LOOKUP_PROVIDER_BAD_RESPONSE/, 'vehicle lookup should distinguish malformed provider responses.');
assert.match(server, /providerBodySample/, 'vehicle lookup should record only a short provider body sample.');
assert.match(server, /k not in \("apiKey", "token", "authorization"\)/, 'vehicle lookup metadata should explicitly filter provider secrets.');
assert.match(server, /vehicle-provider-config/, 'Render admin health should include vehicle provider configuration status.');
assert.match(server, /activity_limit = safe_int\(payload\.get\("activityLimit"\), 24/, 'owner global diagnostics should use a bounded default activity limit.');
assert.match(server, /"invites": invite_summaries\[:25\]/, 'owner global diagnostics should trim invite rows.');
assert.match(server, /"recentActivity": recent_activity\[:activity_limit\]/, 'owner global diagnostics should trim recent activity rows.');
assert.match(server, /"truncated": \{/, 'owner global diagnostics should report truncation flags.');

console.log('vehicle provider diagnostics guardrail passed');
