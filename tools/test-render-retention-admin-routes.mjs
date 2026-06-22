import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");

assert.match(buildInfo, /version: "2026\.06\.18\.(?:200|201|202|203|204|205|206|207|208|209|210|211|212|213|214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251|252|253|254|255|256|257|258|259|260|261|262|263|264|265|266|267|268|269|270|271|272|273|274|275|276)"/);
assert.match(buildInfo, /buildLabel: "(?:owner-passive-background-sync-calm-lane|render-api-client-extraction-lane|update-prompt-bridge-workspace-retention-lane|update-prompt-workspace-visibility-lane|general-action-route-timing-lane|action-session-cache-shell-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|no-refresh-action-chain-lane|post-action-unblock-lane|multi-workspace-authority-lane|admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/);
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v(?:300|301|302|303|304|305|306|307|308|309|310|311|312|313|314|315|316|317|318|319|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368|369|370|371|372|373|374|375|376|377|378|379|380|381|382|384|385|386|387|388|389|390|391|392|393|394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417)"/);
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v(?:300|301|302|303|304|305|306|307|308|309|310|311|312|313|314|315|316|317|318|319|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368|369|370|371|372|373|374|375|376|377|378|379|380|381|382|384|385|386|387|388|389|390|391|392|393|394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417)"/);
assert.match(serviceWorker, /BUILD_LABEL = "(?:owner-passive-background-sync-calm-lane|render-api-client-extraction-lane|update-prompt-bridge-workspace-retention-lane|update-prompt-workspace-visibility-lane|general-action-route-timing-lane|action-session-cache-shell-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|no-refresh-action-chain-lane|post-action-unblock-lane|multi-workspace-authority-lane|admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/);

assert.match(app, /const\s+renderRetentionPreviewUrl\s*=\s*renderApiEndpoints\.retentionPreview\s*\|\|\s*"\/api\/admin\/retention\/preview"/);
assert.match(app, /const\s+renderRetentionCleanupUrl\s*=\s*renderApiEndpoints\.retentionCleanup\s*\|\|\s*"\/api\/admin\/retention\/cleanup"/);
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
