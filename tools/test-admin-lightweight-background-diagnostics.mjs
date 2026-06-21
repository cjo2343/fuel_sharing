import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');

assert.match(app, /Full \/api\/admin\/health is an explicit\s+\/\/ deep diagnostic only/, 'background Admin refresh should document that full admin health is explicit only');
assert.match(app, /const order = \["global", "owner-activity"\]/, 'Admin auto-refresh task rotation must not include the heavy health task');
assert.doesNotMatch(app, /tasks\.push\("health"\)/, 'Admin auto-refresh must not enqueue /api/admin/health');
assert.doesNotMatch(app, /lastAdminAutoHealthAt\s*=/, 'Admin auto-refresh should not track automatic health polling timestamps');
assert.doesNotMatch(app, /adminAutoHealthFreshMs/, 'Admin auto-refresh should not keep a health polling freshness window');
assert.doesNotMatch(app, /task === "health"/, 'Admin auto-refresh tick must not run the full Render admin health check');
assert.match(app, /checkRenderAdminHealth\(\)/, 'Manual/deep diagnostics should still expose the full Render admin health check');
assert.match(app, /ensureRenderBackendReadyForUserAction/, 'Member actions should use lightweight backend readiness instead of full admin health');
assert.match(app, /renderBackendPingUrl = "\/api\/ping"/, 'Lightweight ping should remain the automatic backend readiness route');

console.log('Admin lightweight background diagnostics guardrail passed.');
