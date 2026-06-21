import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const pkg = readFileSync("package.json", "utf8");

assert.match(app, /const renderAdminSecurityHealthUrl = "\/api\/admin\/security-health";/, "app must define the Render security-health route");
assert.match(app, /async function fetchRenderSecurityHealthChecks\(\{ ledgerId, probeTimeoutMs = 10000 \} = \{\}\)/, "app must prefer a Render-owned Security Health helper");
assert.match(app, /fetch\(renderAdminSecurityHealthUrl,[\s\S]*buildRenderRequestHeaders\(\{ "Content-Type": "application\/json" \}\)/, "Render security health must use the shared fresh-token Render request helper");
assert.match(app, /mode: "render"[\s\S]*Supabase security health checks passed through Render/, "successful Render security health should become the Security Health status");
assert.match(app, /Render security health route was unavailable; browser Supabase probes will run as fallback/, "app must keep browser probes as fallback if Render route is unavailable");

const renderFirst = app.indexOf("const renderSecurityStatus = await fetchRenderSecurityHealthChecks");
const browserRefresh = app.indexOf("withSecurityHealthProbeTimeout(\"Supabase session refresh\"", renderFirst);
assert.ok(renderFirst > 0, "Render security health call must exist");
assert.ok(browserRefresh > renderFirst, "browser Supabase session refresh must only run after Render fallback");

assert.match(server, /def build_render_security_health\(ledger_id, user, user_token\):/, "server must build Render-owned Security Health checks");
assert.match(server, /"\/api\/admin\/security-health"/, "server must mount the admin security-health route");
assert.match(server, /def security_health_backend\(self\):/, "server must expose the security health handler");
assert.match(server, /assert_user_can_admin_ledger\(ledger_id, user, user_token\)/, "Render security health must verify workspace admin permission");
assert.match(server, /call_supabase_rpc_as_user\("fuel_ledger_healthcheck"/, "Render security health must call the healthcheck RPC as the signed-in user");
assert.match(server, /request_json\(url, method="GET", body=None, token=None, prefer=None, api_key=None, timeout=20\)/, "request_json must support shorter route-specific probe timeouts");

assert.match(buildInfo, /version: "2026\.06\.18\.(?:213|214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251|252|253|254|255|256|257)"/, "build-info version must be bumped");
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v(?:31[456789]|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368|369|370|371|372|373|374|375|376|377|378|379|380|381|382|384|385|386|387|388|389|390|391|392)"/, "build-info cache must be bumped");
assert.match(buildInfo, /Security Health deep Supabase probes now prefer a Render-owned admin route/, "release note must mention Render-owned security health probes");
assert.match(serviceWorker, /fuel-ledger-v(?:31[456789]|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368|369|370|371|372|373|374|375|376|377|378|379|380|381|382|384|385|386|387|388|389|390|391|392)/, "service worker cache must be bumped");
assert.match(pkg, /test-render-security-health-route\.mjs/, "validate script must run the Render security health route regression test");

console.log("Render security health route test passed.");
