import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

// The contract-preserving timeout wrapper must exist and resolve to a { data, error } shape on
// timeout (not reject), so existing callers handle a timeout through their normal error path.
assert.match(
  app,
  /async function supabaseCallWithTimeout\(label, call, timeoutMs = \d+\)/,
  "supabaseCallWithTimeout helper must exist"
);
assert.match(
  app,
  /supabaseCallWithTimeout[\s\S]*?resolve\(\{\s*\n?\s*data: null,\s*\n?\s*error: \{/,
  "supabaseCallWithTimeout must resolve to { data: null, error } on timeout so callers stay unchanged"
);

// Every direct supabase-js RPC must be time-bounded. An unbounded supabaseClient.rpc(...) can hang
// a user action forever on a stale client after the tab sits idle (the recurring lookup/action
// freeze). Auth/login calls (.auth.signInWithOtp/verifyOtp/getSession) are handled by the login
// flow and getFreshSessionWithTimeout, so only .rpc( is enforced here.
const TIMEOUT_WRAPPERS = /supabaseCallWithTimeout\(|withWorkspaceInviteRequestTimeout\(|withSecurityHealthProbeTimeout\(/;
const rpcMatches = [...app.matchAll(/supabaseClient\.rpc\("([a-z_]+)"/g)];
assert.ok(rpcMatches.length > 0, "expected to find supabaseClient.rpc(...) calls to check");
for (const match of rpcMatches) {
  const preceding = app.slice(Math.max(0, match.index - 160), match.index);
  assert.ok(
    TIMEOUT_WRAPPERS.test(preceding),
    `supabaseClient.rpc("${match[1]}") must be wrapped in a timeout helper (unbounded RPCs can hang a user action after idle)`
  );
}

console.log("Bounded Supabase action call guardrails passed.");
