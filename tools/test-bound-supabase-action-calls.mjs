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

// supabase-js runs the onAuthStateChange callback while holding its internal auth lock (e.g. during
// the post-idle _recoverAndRefresh). Making the callback async / awaiting Supabase work inline
// deadlocks those calls on the lock until they time out — the true root cause of the "stuck after
// idle" freezes. The callback must defer its work out of the lock via setTimeout instead.
assert.doesNotMatch(
  app,
  /onAuthStateChange\(\s*async\b/,
  "onAuthStateChange callback must not be async — awaiting Supabase work inside it deadlocks on the auth lock after idle; defer the work to a fresh task instead"
);
assert.match(
  app,
  /onAuthStateChange\(\(event, session\) => \{[\s\S]{0,800}?setTimeout\([\s\S]{0,120}?handleAuthStateChange\(event, session\)/,
  "onAuthStateChange must defer its work out of the auth-lock callback (setTimeout -> handleAuthStateChange)"
);

console.log("Bounded Supabase action call guardrails passed.");
