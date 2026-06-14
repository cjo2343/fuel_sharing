import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = readFileSync("supabase-schema.sql", "utf8");

function testSettlementRequestTransitionGuardExists() {
  assert.match(schema, /create or replace function public\.is_valid_payment_status_transition\(/);
  assert.match(schema, /when 'open' then coalesce\(p_next_status, 'open'\) in \('open', 'requested'\)/);
  assert.match(schema, /when 'requested' then coalesce\(p_next_status, 'open'\) in \('requested', 'paid', 'open', 'cancelled'\)/);
  assert.match(schema, /when 'paid' then coalesce\(p_next_status, 'open'\) in \('paid', 'open'\)/);
  assert.match(schema, /Invalid settlement request status transition/);
  console.log("ok - testSettlementRequestTransitionGuardExists");
}

function testSettlementRequestPartyGuardsExist() {
  assert.match(schema, /Only the payment recipient can request this payment/);
  assert.match(schema, /actor_member_id is distinct from new\.to_member_id/);
  assert.match(schema, /Only the payer can mark this payment paid/);
  assert.match(schema, /actor_member_id is distinct from new\.from_member_id/);
  assert.match(schema, /public\.is_ledger_admin\(new\.ledger_id\)/);
  console.log("ok - testSettlementRequestPartyGuardsExist");
}

function testSettlementRequestSameLedgerGuardExists() {
  assert.match(schema, /create or replace function public\.member_belongs_to_ledger\(/);
  assert.match(schema, /Settlement request members must belong to the same ledger/);
  assert.match(schema, /Settlement request payer and recipient must be different members/);
  assert.match(schema, /Settlement request must include both payer and recipient members/);
  console.log("ok - testSettlementRequestSameLedgerGuardExists");
}

function testSettlementRequestTriggerIsInstalled() {
  assert.match(schema, /drop trigger if exists enforce_settlement_request_integrity_trigger on public\.settlement_requests/);
  assert.match(schema, /create trigger enforce_settlement_request_integrity_trigger\s+before insert or update/i);
  assert.match(schema, /for each row execute function public\.enforce_settlement_request_integrity\(\)/);
  console.log("ok - testSettlementRequestTriggerIsInstalled");
}


function testPeriodCloseRpcExists() {
  assert.match(schema, /create or replace function public\.close_settlement_period\(/);
  assert.match(schema, /perform pg_advisory_xact_lock\(hashtext\(target_ledger_id\)\)/);
  assert.match(schema, /Only ledger admins can close settlement periods/);
  assert.match(schema, /This settlement period snapshot has already been closed/);
  assert.match(schema, /insert into public\.settlement_periods \(ledger_id, status, label, opened_at\)/);
  assert.match(schema, /jsonb_build_object\(\s*'closed_period_id'/m);
  console.log("ok - testPeriodCloseRpcExists");
}

testSettlementRequestTransitionGuardExists();
testSettlementRequestPartyGuardsExist();
testSettlementRequestSameLedgerGuardExists();
testSettlementRequestTriggerIsInstalled();
testPeriodCloseRpcExists();
