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
  assert.match(schema, /pg_try_advisory_xact_lock\(hashtext\(target_ledger_id\)\)/);
  assert.match(schema, /Only ledger admins can close settlement periods/);
  assert.match(schema, /Reject those\s+-- immediately so they cannot queue behind the lock and burn database CPU/);
  assert.match(schema, /This settlement period snapshot has already been closed/);
  assert.match(schema, /insert into public\.settlement_periods \(ledger_id, status, label, opened_at\)/);
  assert.match(schema, /jsonb_build_object\(\s*'closed_period_id'/m);
  console.log("ok - testPeriodCloseRpcExists");
}


function testTripTransactionRpcExists() {
  assert.match(schema, /create or replace function public\.upsert_trip_with_participants\(/);
  assert.match(schema, /perform pg_advisory_xact_lock\(hashtext\(target_ledger_id \|\| ':trip:' \|\| legacy_trip_id\)\)/);
  assert.match(schema, /Trip must include at least one active ledger participant/);
  assert.match(schema, /Only the trip creator, driver, or a ledger admin can update this trip/);
  assert.match(schema, /delete from public\.trip_participants\s+where trip_id = saved_trip_id/);
  assert.match(schema, /grant execute on function public\.upsert_trip_with_participants\(text, uuid, text, uuid, date, numeric, numeric, text, uuid\[\]\) to authenticated/);
  console.log("ok - testTripTransactionRpcExists");
}


function testBookingTransactionRpcsExist() {
  assert.match(schema, /create or replace function public\.upsert_car_booking\(/);
  assert.match(schema, /perform pg_advisory_xact_lock\(hashtext\(target_ledger_id \|\| ':booking:' \|\| legacy_booking_id\)\)/);
  assert.match(schema, /Only the booking creator, booked member, or a ledger admin can update this booking/);
  assert.match(schema, /create or replace function public\.soft_delete_car_booking\(/);
  assert.match(schema, /Only the booking creator, booked member, or a ledger admin can delete this booking/);
  assert.match(schema, /grant execute on function public\.upsert_car_booking\(text, text, uuid, timestamptz, timestamptz, text\) to authenticated/);
  assert.match(schema, /grant execute on function public\.soft_delete_car_booking\(text, text\) to authenticated/);
  console.log("ok - testBookingTransactionRpcsExist");
}



function testFuelPaymentRpcExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(schema, /create or replace function public\.upsert_fuel_payment\(/);
  assert.match(schema, /perform pg_advisory_xact_lock\(hashtext\(target_ledger_id \|\| ':fuel:' \|\| legacy_fuel_id\)\)/);
  assert.match(schema, /Only the fuel creator, payer, or a ledger admin can update this fuel payment/);
  assert.match(schema, /Only the fuel payer or a ledger admin can create this fuel payment/);
  assert.match(schema, /grant execute on function public\.upsert_fuel_payment\(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean\) to authenticated/);
  assert.match(app, /saveFuelPaymentRpc/);
  assert.match(app, /isMissingFuelPaymentRpcError/);
  assert.match(app, /saveFuelWithGuardedTableUpdate/);
  console.log("ok - testFuelPaymentRpcExists");
}

function testAdminReconciliationSafetyGateExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /const reconciliationFreshLoadMaxAgeMs = 5 \* 60 \* 1000/);
  assert.match(app, /function hasFreshNormalizedTableLoadForReconciliation\(\)/);
  assert.match(app, /async function ensureReconciliationSoftDeleteSafety\(summary = \{\}\)/);
  assert.match(app, /reconciliation-soft-delete-blocked/);
  assert.match(app, /await saveJsonMirrorBackup\(\{ force: true \}\)/);
  assert.match(app, /lastNormalizedTableLoadAt = Date\.now\(\)/);
  console.log("ok - testAdminReconciliationSafetyGateExists");
}

function testAdminToolsGuardrailRpcsExist() {
  const app = readFileSync("app.js", "utf8");
  const adminTools = readFileSync("admin-tools.js", "utf8");
  assert.match(schema, /create or replace function public\.upsert_ledger_member_admin\(/);
  assert.match(schema, /Admins cannot demote or deactivate themselves/);
  assert.match(schema, /At least one active admin is required/);
  assert.match(schema, /create or replace function public\.set_ledger_member_active_admin\(/);
  assert.match(schema, /create or replace function public\.purge_generated_test_rows\(/);
  assert.match(schema, /Only ledger admins can purge generated test rows/);
  assert.match(schema, /grant execute on function public\.upsert_ledger_member_admin\(text, uuid, text, text, text, text, boolean\) to authenticated/);
  assert.match(schema, /push_subscription_scope/);
  assert.match(app, /upsertManagedMemberRpc/);
  assert.match(app, /setManagedMemberActiveRpc/);
  assert.match(app, /RESET CURRENT PERIOD/);
  assert.match(app, /RESET ALL LOCAL DATA/);
  assert.match(app, /IMPORT BACKUP/);
  assert.match(app, /redactTestLabReportForCloud/);
  assert.match(adminTools, /purge_generated_test_rows/);
  console.log("ok - testAdminToolsGuardrailRpcsExist");
}

function testDiagnosticPrivacyRedactionExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /function redactSensitiveDiagnostics\(value\)/);
  assert.match(app, /function redactDiagnosticString\(value\)/);
  assert.match(app, /function isSensitiveDiagnosticKey\(key\)/);
  assert.match(app, /redactSensitiveDiagnostics\(buildSupabaseLoadReport\(\)\)/);
  assert.match(app, /const exportedReport = redactSensitiveDiagnostics\(report\)/);
  assert.match(app, /const reportToStore = sync \? redactSensitiveDiagnostics\(report\) : report/);
  assert.match(app, /privacy redaction applied/);
  console.log("ok - testDiagnosticPrivacyRedactionExists");
}

function testJsonWriteReductionGuardrailsExist() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /const auditJsonMirrorBackupIntervalMs = 5 \* 60 \* 1000/);
  assert.match(app, /let normalizedReconciliationDirty = false/);
  assert.match(app, /function markNormalizedReconciliationDirty\(reason = "state-change"\)/);
  assert.match(app, /function shouldRunNormalizedReconciliation\(reason = "saveSupabaseState"\)/);
  assert.match(app, /normalized-reconciliation-skip/);
  assert.match(app, /json-mirror-skip/);
  assert.match(app, /scheduleJsonMirrorBackup/);
  assert.match(app, /maybeSaveJsonMirrorBackup\(\{\s*minIntervalMs: auditJsonMirrorBackupIntervalMs,/m);
  console.log("ok - testJsonWriteReductionGuardrailsExist");
}

function testRealtimePerformanceGuardrailsExist() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /const hiddenRealtimePauseDelayMs = 60 \* 1000/);
  assert.match(app, /function pauseRealtimeForHiddenPage\(\)/);
  assert.match(app, /function resumeRealtimeForVisiblePage\(\)/);
  assert.match(app, /function handleRealtimeVisibilityChange\(\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", \(\) => \{/);
  assert.match(app, /ledger-event-auto-sync-skip", "page hidden; sync on next focus"/);
  assert.match(app, /realtime-paused-hidden/);
  assert.match(app, /realtime-resumed-visible/);
  console.log("ok - testRealtimePerformanceGuardrailsExist");
}

function testDestructiveActionBackupsExist() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /await exportAdminSafetyBackup\("production activity reset"\)/);
  assert.match(app, /await exportAdminSafetyBackup\("purge soft-deleted generated test rows"\)/);
  assert.match(app, /await exportAdminSafetyBackup\("remove generated test data"\)/);
  assert.match(app, /await exportAdminSafetyBackup\("cleanup generated test data"\)/);
  assert.match(app, /await exportAdminSafetyBackup\("remove unused test users"\)/);
  assert.match(app, /async function removeGeneratedTestData\(\)/);
  assert.match(app, /async function removeUnusedTestUsers\(\)/);
  console.log("ok - testDestructiveActionBackupsExist");
}


function testAdminDiagnosticsUxExists() {
  const app = readFileSync("app.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  const css = readFileSync("styles.css", "utf8");
  assert.match(html, /id="adminGuardrailOverview"/);
  assert.match(app, /function renderAdminGuardrailOverview\(\)/);
  assert.match(app, /data-admin-diagnostics-overview="true"/);
  assert.match(app, /adminGuardrailStatusCard/);
  assert.match(app, /Safety backups run before destructive admin actions/);
  assert.match(app, /Broad Live Sync is off by default/);
  assert.match(app, /function getRpcAvailabilityDiagnostics\(\)/);
  assert.match(app, /function getRealtimePublicationDiagnostics\(\)/);
  assert.match(app, /title: "RPC availability"/);
  assert.match(app, /title: "Realtime publication"/);
  assert.match(app, /Run Security Health to see whether only lightweight ledger_events is published for Realtime/);
  assert.match(app, /Keep public\.ledger_events published/);
  assert.match(app, /Run Security Health to verify trip, fuel, booking, member, purge, reset, and retention RPC availability/);
  assert.match(app, /normalizedProbe\.rpcHealth = probe\.data \|\| null/);
  assert.match(css, /\.admin-guardrail-grid/);
  console.log("ok - testAdminDiagnosticsUxExists");
}

function testReleaseAboutPanelExists() {
  const app = readFileSync("app.js", "utf8");
  const buildInfo = readFileSync("build-info.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  const css = readFileSync("styles.css", "utf8");
  assert.match(html, /id="aboutBuildInfoPanel"/);
  assert.match(html, /id="buildInfoPanel"/);
  assert.match(app, /refreshBuildInfo: document\.querySelector\("#refreshBuildInfo"\)/);
  assert.match(app, /els\.refreshBuildInfo\?\.addEventListener\("click"/);
  assert.match(buildInfo, /window\.FUEL_LEDGER_BUILD = BUILD_INFO/);
  assert.match(buildInfo, /releaseNotes: Object\.freeze\(\[/);
  assert.match(buildInfo, /Latest notes/);
  assert.match(css, /\.release-note-card/);
  console.log("ok - testReleaseAboutPanelExists");
}

function testSyncHealthBannerExists() {
  const app = readFileSync("app.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  const css = readFileSync("styles.css", "utf8");
  assert.match(html, /id="syncHealthBanner"/);
  assert.match(app, /function buildSyncHealthBannerState\(\)/);
  assert.match(app, /function renderSyncHealthBanner\(\)/);
  assert.match(app, /data-sync-health-action/);
  assert.match(app, /Sync delayed/);
  assert.match(app, /Unsynced local changes/);
  assert.match(css, /\.sync-health-banner/);
  console.log("ok - testSyncHealthBannerExists");
}

function testTestLabReportStoreExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(schema, /create table if not exists public\.test_lab_reports/);
  assert.match(schema, /unique \(ledger_id, report_id\)/);
  assert.match(schema, /create policy "Ledger members can read test lab reports"/);
  assert.match(schema, /create or replace function public\.upsert_test_lab_report\(/);
  assert.match(schema, /Only ledger admins can save Test Lab reports/);
  assert.match(schema, /grant execute on function public\.upsert_test_lab_report\(text, text, jsonb\) to authenticated/);
  assert.match(schema, /to_regprocedure\('public\.upsert_test_lab_report\(text, text, jsonb\)'\)/);
  assert.match(app, /function saveTestLabReportToCloudStore\(report\)/);
  assert.match(app, /upsert_test_lab_report/);
  assert.match(app, /Ledger JSON was not rewritten/);
  assert.match(app, /function loadCloudTestLabReports\(\{ force = false, reason = "load normalized Test Lab report history" \} = \{\}\)/);
  assert.match(app, /testLabReportLoadCooldownMs: 10 \* 1000/);
  assert.match(app, /test-lab-report-local-merge/);
  assert.match(app, /function isHistoricalTestLabReport\(report\)/);
  assert.match(app, /markHistoricalTestLabReport/);
  assert.match(app, /mergeTestLabReportsIntoState\(reports, \{ promote: !lastTestLabReport \}\)/);
  assert.match(app, /Historical saved report/);
  assert.match(app, /Historical saved report was not re-saved/);
  assert.match(app, /from\("test_lab_reports"\)/);
  console.log("ok - testTestLabReportStoreExists");
}

function testFuelLedgerHealthcheckExists() {
  assert.match(schema, /create or replace function public\.fuel_ledger_healthcheck\(target_ledger_id text default 'main-car'\)/);
  assert.match(schema, /to_regprocedure\('public\.close_settlement_period\(text, uuid, jsonb\)'\) is not null/);
  assert.match(schema, /'critical_rpcs', jsonb_build_object/);
  assert.match(schema, /'realtime_publication', jsonb_build_object/);
  assert.match(schema, /'recommended_tables', jsonb_build_array\('public\.ledger_events'\)/);
  assert.match(schema, /'extra_tables', coalesce/);
  assert.match(schema, /'ledger_events_enabled', exists/);
  assert.match(schema, /to_regprocedure\('public\.upsert_trip_with_participants/);
  assert.match(schema, /to_regprocedure\('public\.upsert_fuel_payment/);
  assert.match(schema, /to_regprocedure\('public\.upsert_car_booking/);
  assert.match(schema, /to_regprocedure\('public\.soft_delete_car_booking/);
  assert.match(schema, /to_regprocedure\('public\.upsert_ledger_member_admin/);
  assert.match(schema, /to_regprocedure\('public\.set_ledger_member_active_admin/);
  assert.match(schema, /to_regprocedure\('public\.purge_generated_test_rows/);
  assert.match(schema, /to_regprocedure\('public\.upsert_test_lab_report/);

  assert.match(schema, /critical_rpc_names\(rpc_name\) as/);
  assert.match(schema, /from pg_proc p\s+join pg_namespace n on n\.oid = p\.pronamespace/);
  assert.match(schema, /p\.proname = rpc_name/);
  assert.match(schema, /alter publication supabase_realtime drop table public\.car_share_ledgers/);
  assert.match(schema, /alter publication supabase_realtime add table public\.ledger_events/);
  assert.match(schema, /grant execute on function public\.fuel_ledger_healthcheck\(text\) to authenticated/);
  console.log("ok - testFuelLedgerHealthcheckExists");
}

testSettlementRequestTransitionGuardExists();
testSettlementRequestPartyGuardsExist();
testSettlementRequestSameLedgerGuardExists();
testSettlementRequestTriggerIsInstalled();
testPeriodCloseRpcExists();
testTripTransactionRpcExists();
testBookingTransactionRpcsExist();
testFuelPaymentRpcExists();
testAdminReconciliationSafetyGateExists();
testAdminToolsGuardrailRpcsExist();
testDiagnosticPrivacyRedactionExists();
testJsonWriteReductionGuardrailsExist();
testRealtimePerformanceGuardrailsExist();
testDestructiveActionBackupsExist();
testAdminDiagnosticsUxExists();
testReleaseAboutPanelExists();
testSyncHealthBannerExists();
testTestLabReportStoreExists();
testFuelLedgerHealthcheckExists();
