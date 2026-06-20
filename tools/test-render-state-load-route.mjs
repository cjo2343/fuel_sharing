import fs from "node:fs";

const app = fs.readFileSync("app.js", "utf8");
const server = fs.readFileSync("server.py", "utf8");
const pkg = fs.readFileSync("package.json", "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(`Render state load route guard failed: ${message}`);
    process.exit(1);
  }
}

assert(app.includes('const renderStateLoadUrl = "/api/state/load";'), "app should define the Render state-load URL");
assert(app.includes("async function getRenderNormalizedStateRows"), "app should have a Render state-load helper");
assert(app.includes("async function getFreshRenderAccessToken"), "app should refresh the Supabase session before Render calls");
assert(app.includes("isRenderAuthRejected(response, result, text)"), "Render state load should detect auth-not-ready responses");
assert(app.includes("RENDER_AUTH_NOT_READY"), "Render auth rejection should be recorded as a quiet fallback skip");
assert(app.includes('source: "state-load", route: "render-api", endpoint: renderStateLoadUrl'), "Render state-load helper should emit Data I/O diagnostics");
assert(app.includes('recordSupabaseLoadEvent("render-state-load"'), "Render state-load success should be visible in the load monitor");
assert(app.includes("const renderStateRows = await getRenderNormalizedStateRows(ledgerId);"), "normalized table load should try Render before browser table reads");
assert(app.includes("if (renderStateRows)"), "normalized table load should use Render rows when available");
assert(app.includes("} else {\n    [membersResult, periodsResult, tripsResult, fuelResult, bookingsResult, requestsResult] = await Promise.all"), "browser Supabase table load should remain as fallback only");
assert(app.includes("participantResult = { data: renderStateRows.tripParticipants || [], error: null };"), "Render state load should include trip participants to avoid a follow-up browser read");

assert(server.includes('if self.path == "/api/state/load":'), "server should route /api/state/load");
assert(server.includes("def load_state_backend"), "server should implement load_state_backend");
assert(server.includes("def verify_supabase_user_via_jwks"), "server auth should verify Supabase asymmetric JWTs through JWKS/public keys");
assert(server.includes("def supabase_jwks_url"), "server auth should know the Supabase JWKS URL");
assert(server.includes("SUPABASE_JWKS_CACHE"), "server auth should cache Supabase public keys for stable Render auth");
assert(server.includes("def get_normalized_state_rows_as_user"), "server should fetch normalized state rows as the signed-in user");
assert(server.includes("get_write_context_as_user(ledger_id, user, user_token)"), "server state load should verify active ledger membership through write context");
assert(server.includes('"tripParticipants": trip_participants'), "server state load should return trip participants");
assert(server.includes('self.send_json({"ok": True, "stateRows": state_rows, "backend": "render"'), "server state load should return a stable Render envelope");

assert(pkg.includes("node tools/test-render-state-load-route.mjs"), "validate should run the Render state-load guard");
assert(pkg.includes("node --check tools/test-render-state-load-route.mjs"), "validate should syntax-check the Render state-load guard");

console.log("Render state load route guard check passed.");
