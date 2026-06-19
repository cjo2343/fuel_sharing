#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync("server.py", "utf8");

assert(server.includes("def get_state_load_context_as_service"), "server should authorize state loads with a service-side member context");
assert(server.includes("Regular invited members must be able to load their workspace"), "server should document why state load uses service-side reads after membership verification");
assert(server.includes("Signed-in user is not an active member of this workspace"), "state load must still reject non-members before service-side reads");
assert(server.includes("def get_normalized_state_rows_as_user"), "state load row loader should exist");
assert(server.includes("context = get_state_load_context_as_service(ledger_id, user)"), "state load must verify active membership before loading rows");
assert(server.includes('api_key=supabase_key()'), "state load should use server-side Supabase access after active-member verification");
assert(!server.includes("context = get_write_context_as_user(ledger_id, user, user_token)\n    ledger_q = quote_postgrest_value(ledger_id)"), "state load should not depend on regular-member table RLS for the full workspace state view");

console.log("member state-load service-scope guard passed");
