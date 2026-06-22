import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");


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
