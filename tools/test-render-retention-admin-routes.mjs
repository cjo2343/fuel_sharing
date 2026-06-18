import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");

assert.match(buildInfo, /version: "2026\.06\.18\.(?:200|201|202|203|204|205|206|207|208)"/);
assert.match(buildInfo, /buildLabel: "(?:render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/);
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v(?:300|301|302|303|304|305|306|307|308|308)"/);
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v(?:300|301|302|303|304|305|306|307|308|308)"/);
assert.match(serviceWorker, /BUILD_LABEL = "(?:render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/);

assert.match(app, /const renderRetentionPreviewUrl = "\/api\/admin\/retention\/preview"/);
assert.match(app, /const renderRetentionCleanupUrl = "\/api\/admin\/retention\/cleanup"/);
assert.match(app, /async function callRetentionAdminRoute/);
assert.match(app, /previewRetentionCleanupViaRender/);
assert.match(app, /runRetentionCleanupViaRender/);
assert.match(app, /recordSupabaseLoadEvent\(`render-retention-\$\{action\}`/);
assert.match(app, /endpoint: renderRetentionPreviewUrl/);
assert.match(app, /endpoint: renderRetentionCleanupUrl/);
assert.doesNotMatch(app, /supabaseClient\.rpc\("preview_retention_cleanup"/);
assert.doesNotMatch(app, /supabaseClient\.rpc\("run_retention_cleanup"/);
assert.match(app, /Browser retention RPC fallback is disabled/);

assert.match(server, /if self\.path == "\/api\/admin\/retention\/preview"/);
assert.match(server, /if self\.path == "\/api\/admin\/retention\/cleanup"/);
assert.match(server, /def build_retention_admin_payload/);
assert.match(server, /def run_retention_admin_rpc_as_user/);
assert.match(server, /assert_user_can_admin_ledger\(ledger_id, user, user_token\)/);
assert.match(server, /rpc_name = "preview_retention_cleanup" if action == "preview" else "run_retention_cleanup"/);
assert.match(server, /def preview_retention_cleanup_backend/);
assert.match(server, /def run_retention_cleanup_backend/);
assert.match(server, /current_supabase_user\(self\)/);
assert.match(server, /call_supabase_rpc_as_user\(rpc_name, rpc_payload, user_token=user_token\)/);

console.log("Render retention admin routes guard check passed.");
