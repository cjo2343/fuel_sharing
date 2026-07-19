import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/137_settlement_event_history.sql", "utf8");
const schema = readFileSync("supabase-schema.sql", "utf8");

for (const sql of [migration, schema]) {
  assert.match(sql, /create table if not exists public\.settlement_request_events/);
  assert.match(sql, /after insert or update on public\.settlement_requests/);
  assert.match(sql, /using \(public\.is_ledger_member\(ledger_id\)\)/);
  assert.match(sql, /revoke all on table public\.settlement_request_events from authenticated/);
  assert.match(sql, /grant select on table public\.settlement_request_events to authenticated/);
  assert.doesNotMatch(sql, /settlement_request_events \([\s\S]{0,900}\b(?:paid_note|dispute_note|actor_email|target_email|push_token|metadata)\b/);
}

assert.match(migration, /event_source in \('live', 'legacy_backfill'\)/);
assert.match(migration, /not invent a dispute time from updated_at/i);
assert.doesNotMatch(migration, /delete from public\.settlement_request_events/i);
assert.doesNotMatch(migration, /update public\.settlement_request_events/i);

console.log("ok - settlement event history is durable, trigger-captured, RLS-scoped, and privacy-minimised");
