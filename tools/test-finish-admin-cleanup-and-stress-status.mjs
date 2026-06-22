import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(app, /async function persistGeneratedAdminStateWithRenderMirror\(reason, message, \{ checkTables = true \} = \{\}\)/, 'shared Render mirror persistence helper is missing');
assert.match(app, /async function cleanupGeneratedTestDataWithReport\(\) \{[\s\S]*persistGeneratedAdminStateWithRenderMirror\("cleanup-test-lab-data"/, 'cleanup Test Lab data must use the Render mirror helper so the admin-tool row can finish');
assert.doesNotMatch(app, /async function cleanupGeneratedTestDataWithReport\(\) \{[\s\S]*?await flushStressSave\(`/, 'cleanup Test Lab data must not use the old flushStressSave path that can leave admin-tool rows active');
assert.match(app, /async function flushStressSave\(label\) \{[\s\S]*persistGeneratedAdminStateWithRenderMirror\("advanced-stress", label\);[\s\S]*?\}/, 'advanced stress should use the Render mirror helper instead of saveSupabaseState');
assert.doesNotMatch(app, /async function flushStressSave\(label\) \{[\s\S]*?await saveSupabaseState\(\{ reason: "advanced-stress" \}\)/, 'advanced stress must not call the old full-state save directly');
assert.match(app, /finishForegroundOperationsBySource\("advanced-stress", "Render backup path completed"\)/, 'Render-backed stress path must clear any advanced-stress foreground operation');
assert.match(app, /browser-full-state-save-skip/, 'Render-backed admin generated-data paths should record browser full-state save skip breadcrumbs');
assert.match(buildInfo, /interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|post-action-unblock-lane|multi-workspace-authority-lane|admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|finish-admin-cleanup-and-stress-status|normalized-test-data-cleanup|render-admin-test-data-routes|render-normalized-test-data-cleanup-route|render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route/, 'build label should preserve or build on the admin cleanup/stress finish patch');
assert.match(serviceWorker, /fuel-ledger-v(?:29[2-9]|[34][0-9][0-9])/, 'service worker cache must stay bumped for runtime app.js changes');
assert.match(pkg, /test-finish-admin-cleanup-and-stress-status\.mjs/, 'validate script must include the cleanup/stress status guard');

console.log('Admin cleanup/stress finish status guard check passed.');
