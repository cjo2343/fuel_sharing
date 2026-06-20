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


function testSettlementRequestTransactionRpcExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(schema, /create or replace function public\.upsert_settlement_request_status\(/);
  assert.match(schema, /create or replace function public\.apply_payment_status_action\(/);
  assert.match(schema, /perform pg_advisory_xact_lock\(hashtext\(target_ledger_id \|\| ':settlement:' \|\| target_open_period_id::text\)\)/);
  assert.match(schema, /Only ledger members can save settlement requests/);
  assert.match(schema, /Settlement request status and stale-row cleanup should be transactional|cancelled_stale_count/);
  assert.match(schema, /grant execute on function public\.upsert_settlement_request_status\(text, uuid, uuid, uuid, numeric, text, text, text\[\]\) to authenticated/);
  assert.match(schema, /grant execute on function public\.apply_payment_status_action\(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text\[\]\) to authenticated/);
  assert.match(schema, /'upsert_settlement_request_status'/);
  assert.match(schema, /'apply_payment_status_action'/);
  assert.match(app, /saveSettlementRequestStatusRpc/);
  assert.match(app, /isMissingSettlementRequestStatusRpcError/);
  assert.match(app, /currentSettlementPairKeys/);
  assert.match(app, /renderPaymentStatusActionUrl = "\/api\/payments\/status-action"/);
  assert.match(app, /async function applyPaymentStatusActionViaRender/);
  assert.match(app, /buildRenderRequestHeaders\(/);
  assert.doesNotMatch(app, /Authorization": `Bearer \${currentSession\.access_token}`/);
  assert.match(app, /stale-row cleanup through the database transaction RPC|Render backend API.*ledger event/);
  console.log("ok - testSettlementRequestTransactionRpcExists");
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
  assert.match(app, /saveJsonMirrorBackup\(\{ force: true, reason: "admin reconciliation safety backup" \}\)/);
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
  assert.match(schema, /create or replace function public\.update_own_ledger_member_profile\(/);
  assert.match(schema, /Another active member in this workspace already uses that display name/);
  assert.match(schema, /grant execute on function public\.update_own_ledger_member_profile\(text, text, text\) to authenticated/);
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

function testAdminTestLabProtectionsExist() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /function requireAdvancedAdminAction\(\{ phrase, title, detail, requireUnlock = true \} = \{\}\)/);
  assert.match(app, /if \(requireUnlock && !assertAdvancedAdminToolsUnlocked\(\)\) return false/);
  assert.match(app, /phrase: "ADD TEST TRIP"/);
  assert.match(app, /phrase: "ADD TEST FUEL"/);
  assert.match(app, /phrase: "REMOVE TEST DATA"/);
  assert.match(app, /Use Safe Test Lab for local-only checks/);
  assert.match(app, /function isStrictGeneratedTestEntry\(entry\)/);
  assert.match(app, /String\(entry\.id \|\| ""\)\.startsWith\(generatedTestPrefix\)/);
  assert.match(app, /function isStrictGeneratedTestStatusKey\(key\)/);
  assert.match(app, /const isTest = isStrictGeneratedTestEntry/);
  assert.doesNotMatch(app, /state\.trips = \(state\.trips \|\| \[\]\)\.filter\(\(trip\) => !testLab\?\.isTestLabEntry/, "destructive generated cleanup must not use broad marker-only detection");
  console.log("ok - testAdminTestLabProtectionsExist");
}


function testDiagnosticPrivacyRedactionExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /function redactSensitiveDiagnostics\(value\)/);
  assert.match(app, /function redactDiagnosticString\(value\)/);
  assert.match(app, /function redactDiagnosticUrlSecrets\(value\)/);
  assert.match(app, /function isSensitiveDiagnosticKey\(key\)/);
  assert.match(app, /\[redacted-email\]/);
  assert.match(app, /\[redacted-phone\]/);
  assert.match(app, /\[redacted-coordinates\]/);
  assert.match(app, /\[redacted-jwt\]/);
  assert.match(app, /\[redacted-token\]/);
  assert.match(app, /access_token\|refresh_token\|accessToken\|refreshToken\|auth\|authorization\|jwt\|token\|apikey\|api_key\|apiKey\|anon_key\|anonKey/);
  assert.match(app, /api\[_-\]\?key\|apiKey\|apikey\|anon\[_-\]\?key\|anonKey\|supabase\[_-\]\?key\|supabaseKey\|service\[_-\]\?role\|serviceRole/);
  assert.match(app, /redactSensitiveDiagnostics\(buildSupabaseLoadReport\(\)\)/);
  assert.match(app, /const exportedReport = redactSensitiveDiagnostics\(report\)/);
  assert.match(app, /const reportToStore = sanitizeStoredDiagnosticReport\(report\)/);
  assert.match(app, /privacy redaction applied/);
  assert.doesNotMatch(app, /\+\?\d\[0-9 \(\)\.\-\]\{7,\}\d/, "phone redaction must not treat build versions or ISO dates as phone numbers");
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
  assert.match(app, /json-mirror-manual-only/);
  assert.match(app, /scheduleJsonMirrorBackup/);
  assert.match(app, /maybeSaveJsonMirrorBackup\(\{\s*minIntervalMs: auditJsonMirrorBackupIntervalMs,/m);
  assert.doesNotMatch(app, /else \{\s*await maybeSaveJsonMirrorBackup\(\);\s*\}/m, "routine table-primary saves must not upsert the full JSON mirror when no audit backup is dirty");
  assert.match(app, /updated local payment status without full-state remote save/);
  assert.match(app, /function applyPaymentActionLocally\(key, nextStatus, auditEntry, reason = "payment-action-local-apply"\)/, "payment actions should centralize local status/audit application");
  assert.match(app, /applyPaymentActionLocally\(key, nextStatus, auditEntry\);[\s\S]*render\(\);[\s\S]*if \(supabaseClient\)/, "payment actions should render the local status/audit breadcrumb before backend merge or JSON backup scheduling");
  assert.match(app, /if \(supabaseClient\) \{[\s\S]*writeLocalState\(\);[\s\S]*scheduleJsonMirrorBackup\(\);[\s\S]*\} else \{[\s\S]*applyBackendPaymentAction/, "Supabase payment actions should update local UI state without queuing the generic full-state remote save stack");
  assert.doesNotMatch(app, /if \(supabaseClient\) \{[\s\S]{0,600}saveState\(\);[\s\S]{0,300}\} else \{[\s\S]*applyBackendPaymentAction/, "Supabase payment actions must not call saveState(), which would fan out into full-state remote saves");
  assert.match(app, /els\.saveJsonBackupNow\?\.addEventListener\("click", async \(\) => \{/);
  console.log("ok - testJsonWriteReductionGuardrailsExist");
}


function testLocalTripSubmitFlushesServerState() {
  const app = readFileSync("app.js", "utf8");
  const marker = `  saveState();
  if (!supabaseClient) {
    if (typeof queueRemoteSave.cancel === "function") queueRemoteSave.cancel();
    await saveRemoteState();
  }
  if (!wasEditingTrip && tripPayload.sourceBookingId)`;
  assert.ok(app.includes(marker), "local/server-backed trip submits must flush the exact current state before tests or payment actions read /api/state");
  console.log("ok - testLocalTripSubmitFlushesServerState");
}



function testBookingPlannedParticipantsSurviveTripSubmit() {
  const app = readFileSync("app.js", "utf8");
  const bridge = readFileSync("planner-booking-bridge.js", "utf8");
  assert.match(bridge, /plannedParticipants: plannedTripParticipantsFromBooking\(booking\)/);
  assert.match(app, /function getSelectedTripParticipantsForSubmit\(context = null\)/);
  assert.match(app, /parseTripFormBookingParticipantsDataset\(\)/);
  assert.match(app, /sourceBookingParticipants/);
  assert.match(app, /selectedAllMembers && plannedDiffersFromAllMembers/);
  assert.match(app, /TripActions\.setCheckboxSelection\(els\.tripParticipants, tripParticipants\)/);
  assert.match(app, /const participants = getSelectedTripParticipantsForSubmit\(activeTripBookingContext\)/);
  console.log("ok - testBookingPlannedParticipantsSurviveTripSubmit");
}

function testSupabaseLoadTimeoutGuardExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /let supabaseLoadStartedAt = 0/);
  assert.match(app, /let supabaseLoadToken = 0/);
  assert.match(app, /const supabaseStaleLoadMs = 45000/);
  assert.match(app, /function markSupabaseLoadTimedOut\(reason = "load-timeout"\)/);
  assert.match(app, /supabase-load-timeout/);
  assert.match(app, /function isCurrentSupabaseLoad\(loadToken\)/);
  assert.match(app, /let timeoutId = null/);
  assert.match(app, /window\.clearTimeout\(timeoutId\)/);
  assert.match(app, /markSupabaseLoadTimedOut\(`\$\{reason\}-timeout`\)/);
  assert.match(app, /cloud-sync-delayed-fallback/);
  assert.match(app, /stale load replaced \(\$\{reason\}\)/);
  assert.match(app, /supabase-load-stale-result/);
  assert.match(app, /loadSupabaseStateWithTimeout\(\s*\{ force: true, reason, manual: true \}/m);
  assert.match(app, /const supabaseAuthRefreshSyncCooldownMs = 5 \* 60 \* 1000/);
  assert.match(app, /let lastAuthCloudSyncUserKey = ""/);
  assert.match(app, /let lastAuthCloudSyncEventAt = 0/);
  assert.match(app, /auth-sync-skip/);
  assert.match(app, /token_refreshed\|user_updated\|session_updated\|initial_session/);
  assert.match(app, /isDuplicateAuthEvent/);
  assert.match(app, /background: Boolean\(lastCloudSyncAt\)/);
  assert.match(app, /cloud-sync-delayed-background/);
  assert.match(app, /shouldShowDelayedStatus/);
  assert.match(app, /reason: `auth-\$\{authEvent\}`/);
  assert.match(app, /loadSupabaseStateWithTimeout\(\s*\{ reason: "window-focus", background: true \}/m);
  assert.match(app, /loadSupabaseStateWithTimeout\(\s*\{ force: true, reason: "login" \}/m);
  assert.match(app, /loadSupabaseStateWithTimeout\(\s*\{ force: true, reason: "ledger-event-auto-sync" \}/m);
  assert.ok(app.includes(`if (isCurrentSupabaseLoad(loadToken)) {
      supabaseLoadInFlight = false;`));
  console.log("ok - testSupabaseLoadTimeoutGuardExists");
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
  const requiredBackupReasons = [
    "reset current period",
    "reset all local data",
    "import backup",
    "close current period",
    "production activity reset",
    "purge soft-deleted generated test rows",
    "remove generated test data",
    "cleanup generated test data",
    "retention cleanup",
    "remove unused test users"
  ];
  assert.match(app, /const requiredAdminSafetyBackupReasons = Object\.freeze\(\[/);
  assert.match(app, /const adminSafetyBackupFreshMs = 60 \* 1000/);
  assert.match(app, /let lastAdminSafetyBackup = null/);
  assert.match(app, /function assertKnownAdminSafetyBackupReason\(reason = "admin action"\)/);
  assert.match(app, /function markAdminSafetyBackupSuccess\(reason, details = \{\}\)/);
  assert.match(app, /function assertFreshAdminSafetyBackup\(reason = "admin action"\)/);
  assert.match(app, /Fresh safety backup is required before \${normalizedReason}/);
  assert.match(app, /recordSupabaseLoadEvent\("admin-safety-backup-success", normalizedReason, \{ diagnostic: true \}\)/);
  for (const reason of requiredBackupReasons) {
    assert.match(app, new RegExp(`"${reason}"`));
    assert.match(app, new RegExp(`await exportAdminSafetyBackup\\("${reason}"\\)`));
    assert.match(app, new RegExp(`assertFreshAdminSafetyBackup\\("${reason}"\\)`));
  }
  assert.match(app, /async function removeGeneratedTestData\(\)/);
  assert.match(app, /async function removeUnusedTestUsers\(\)/);
  assert.match(app, /Cloud backup failed before \${normalizedReason}/);
  assert.match(app, /await exportAdminSafetyBackup\("retention cleanup"\)/);
  assert.match(app, /assertFreshAdminSafetyBackup\("retention cleanup"\)/);
  assert.match(app, /showUserError\(error\.message \|\| String\(error\)\);\n      return;\n    }\n\n  const period =/);
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
  assert.match(app, /Fresh backup required immediately before destructive actions/);
  assert.match(app, /Broad Live Sync is off by default/);
  assert.match(app, /function getRpcAvailabilityDiagnostics\(\)/);
  assert.match(app, /function getRealtimePublicationDiagnostics\(\)/);
  assert.match(app, /function getSchemaMigrationDiagnostics\(\)/);
  assert.match(app, /function getSchemaDriftDiagnostics\(\)/);
  assert.match(app, /function getAdminHealthSummary\(/);
  assert.match(app, /function getPublicLaunchReadinessDiagnostics\(\)/);
  assert.match(app, /title: "Overall health"/);
  assert.match(app, /All core checks look healthy/);
  assert.match(app, /title: "Public launch readiness"/);
  assert.match(app, /Private beta only/);
  assert.match(app, /Do not advertise broadly yet/);
  assert.match(app, /workspace\/invite onboarding, rate-limit monitoring, and abuse review/);
  assert.match(app, /public launch readiness/);
  assert.match(app, /title: "RPC availability"/);
  assert.match(app, /title: "Migrations"/);
  assert.match(app, /title: "Schema shape"/);
  assert.match(app, /title: "Realtime publication"/);
  assert.match(app, /Run Security Health to see whether only lightweight ledger_events is published for Realtime/);
  assert.match(app, /Keep public\.ledger_events published/);
  assert.match(app, /Run Security Health to verify trip, fuel, booking, member, purge, reset, and retention RPC availability/);
  assert.match(app, /let latestHealthcheckRpcPayload = null/);
  assert.match(app, /function rememberHealthcheckRpcPayload/);
  assert.match(app, /normalizedProbe\.rpcHealth = rememberHealthcheckRpcPayload\(probe\.data, checkedAt\)/);
  assert.match(app, /renderAdminGuardrailOverview\(\);\n  setDataToolsMessage\(`Security health complete:/);
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
  assert.doesNotMatch(schema, /unique \(ledger_id, report_id\)/);
  assert.match(schema, /test_lab_reports_ledger_report_id_idx/);
  assert.match(schema, /create policy "Ledger members can read test lab reports"/);
  assert.match(schema, /create or replace function public\.upsert_test_lab_report\(/);
  assert.match(schema, /Only ledger admins can save Test Lab reports/);
  assert.match(schema, /grant execute on function public\.upsert_test_lab_report\(text, text, jsonb\) to authenticated/);
  assert.match(schema, /to_regprocedure\('public\.upsert_test_lab_report\(text, text, jsonb\)'\)/);
  assert.match(app, /function saveTestLabReportToCloudStore\(report\)/);
  assert.match(app, /upsert_test_lab_report/);
  assert.match(app, /createImmutableTestLabReportId/);
  assert.match(schema, /immutable_history/);
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

function testRetentionPrivacyCleanupCoversCloudReports() {
  const app = readFileSync("app.js", "utf8");
  assert.match(schema, /create or replace function public\.preview_retention_cleanup\(\s*target_ledger_id text default 'main-car',\s*event_retention_days integer default 30,\s*stale_push_days integer default 180,\s*test_lab_report_days integer default 30,\s*keep_latest_test_lab_reports integer default 10/s);
  assert.match(schema, /create or replace function public\.run_retention_cleanup\(\s*target_ledger_id text default 'main-car',\s*event_retention_days integer default 30,\s*stale_push_days integer default 180,\s*test_lab_report_days integer default 30,\s*keep_latest_test_lab_reports integer default 10/s);
  assert.match(schema, /from public\.test_lab_reports/);
  assert.match(schema, /row_number\(\) over \(order by synced_at desc, created_at desc, id desc\)/);
  assert.match(schema, /delete from public\.test_lab_reports reports/);
  assert.match(schema, /grant execute on function public\.preview_retention_cleanup\(text, integer, integer, integer, integer\) to authenticated/);
  assert.match(schema, /grant execute on function public\.run_retention_cleanup\(text, integer, integer, integer, integer\) to authenticated/);
  assert.match(schema, /to_regprocedure\('public\.preview_retention_cleanup\(text, integer, integer, integer, integer\)'\)/);
  assert.match(schema, /to_regprocedure\('public\.run_retention_cleanup\(text, integer, integer, integer, integer\)'\)/);
  assert.match(app, /cloudTestLabReportDays: 30/);
  assert.match(app, /keepLatestCloudTestLabReports: 10/);
  assert.match(app, /testLabReportDays: retentionPolicy\.cloudTestLabReportDays/);
  assert.match(app, /keepLatestTestLabReports: retentionPolicy\.keepLatestCloudTestLabReports/);
  assert.match(app, /Old cloud Test Lab reports/);
  assert.match(app, /cloud Test Lab report\(s\)/);
  console.log("ok - testRetentionPrivacyCleanupCoversCloudReports");
}

function testBootstrapLockExists() {
  assert.match(schema, /bootstrap_locked_at timestamptz/);
  assert.match(schema, /create or replace function public\.is_ledger_bootstrap_open\(p_ledger_id text\)/);
  assert.match(schema, /l\.bootstrap_locked_at is not null/);
  assert.match(schema, /create or replace function public\.lock_ledger_bootstrap_when_admin_email_attached\(\)/);
  assert.match(schema, /new\.role = 'admin'/);
  assert.match(schema, /btrim\(new\.email\) <> ''/);
  assert.match(schema, /create trigger lock_ledger_bootstrap_on_admin_email/);
  console.log("ok - testBootstrapLockExists");
}

function testSchemaMigrationTrackingExists() {
  const healthHelpers = readFileSync("security-health-helpers.js", "utf8");
  assert.match(schema, /create table if not exists public\.fuel_ledger_schema_migrations/);
  assert.match(schema, /migration_id text primary key/);
  assert.match(schema, /'023_schema_migration_tracking'/);
  assert.match(schema, /'024_schema_drift_healthcheck'/);
  assert.match(schema, /'025_workspace_foundation'/);
  assert.match(schema, /'026_invite_onboarding_foundation'/);
  assert.match(schema, /'027_invite_code_generation_pgcrypto_fix'/);
  assert.match(schema, /'028_invite_code_hash_pgcrypto_fix'/);
  assert.match(schema, /'029_invite_redeem_return_ambiguity_fix'/);
  assert.match(schema, /'030_onboarding_abuse_rate_limits'/);
  assert.match(schema, /'031_payment_status_action_rpc'/);
  assert.match(schema, /'033_onboarding_rate_limit_scope_key_alignment'/);
  assert.match(schema, /'034_invite_rate_limit_actor_email_ambiguity_fix'/);
  assert.match(schema, /'035_sql_ambiguity_guardrail'/);
  assert.match(schema, /'apply_payment_status_action'/);
  assert.match(schema, /'schema_migrations', jsonb_build_object/);
  assert.match(schema, /'latest_expected'/);
  assert.match(schema, /'missing_migrations'/);
  assert.match(schema, /grant select on public\.fuel_ledger_schema_migrations to authenticated/);
  assert.doesNotMatch(schema, /auth_user_id/, "schema migration tracking must use email-based member auth, not a non-existent auth_user_id column");
  assert.match(schema, /lower\(lm\.email\) = public\.current_user_email\(\)/);
  assert.match(healthHelpers, /missingSchemaMigrations/);
  assert.match(healthHelpers, /Fuel Ledger schema migrations are applied/);
  console.log("ok - testSchemaMigrationTrackingExists");
}

function testSchemaDriftHealthcheckExists() {
  const healthHelpers = readFileSync("security-health-helpers.js", "utf8");
  assert.match(schema, /'schema_drift', jsonb_build_object/);
  assert.match(schema, /expected_tables\(table_name\) as/);
  assert.match(schema, /expected_columns\(table_name, column_name\) as/);
  assert.match(schema, /expected_policies\(table_name, policy_name\) as/);
  assert.match(schema, /information_schema\.tables/);
  assert.match(schema, /information_schema\.columns/);
  assert.match(schema, /from pg_policies pp/);
  assert.match(schema, /'missing_tables'/);
  assert.match(schema, /'missing_columns'/);
  assert.match(schema, /'missing_policies'/);
  assert.match(schema, /'fuel_ledger_schema_migrations_admin_select'/);
  assert.match(schema, /\('ledgers', 'slug'\)/);
  assert.match(schema, /\('ledgers', 'is_public_signup_enabled'\)/);
  assert.match(schema, /\('ledgers', 'invite_required'\)/);
  assert.match(healthHelpers, /schemaDrift/);
  assert.match(healthHelpers, /Fuel Ledger schema shape matches the app/);
  assert.match(healthHelpers, /schema drift OK/);
  console.log("ok - testSchemaDriftHealthcheckExists");
}

function testWorkspaceFoundationExists() {
  assert.match(schema, /add column if not exists slug text/);
  assert.match(schema, /add column if not exists created_by_member_id uuid/);
  assert.match(schema, /add column if not exists is_public_signup_enabled boolean not null default false/);
  assert.match(schema, /add column if not exists invite_required boolean not null default true/);
  assert.match(schema, /create unique index if not exists ledgers_slug_unique_idx/);
  assert.match(schema, /create index if not exists ledger_members_email_ledger_active_idx/);
  assert.match(schema, /create or replace function public\.normalize_ledger_slug\(raw_slug text\)/);
  assert.match(schema, /create or replace function public\.list_my_ledgers\(\)/);
  assert.match(schema, /create or replace function public\.create_private_ledger_workspace/);
  assert.match(schema, /normalized_slug = 'main-car'/);
  assert.match(schema, /is_public_signup_enabled,\n    invite_required,\n    bootstrap_locked_at/);
  assert.match(schema, /false,\n    true,\n    now\(\)/);
  assert.match(schema, /'workspace_readiness', workspace_status\.payload/);
  assert.match(schema, /'list_my_ledgers'/);
  assert.match(schema, /'create_private_ledger_workspace'/);
  assert.match(schema, /'025_workspace_foundation'/);
  assert.match(schema, /'026_invite_onboarding_foundation'/);
  assert.match(schema, /'027_invite_code_generation_pgcrypto_fix'/);
  assert.match(schema, /'028_invite_code_hash_pgcrypto_fix'/);
  assert.match(schema, /'029_invite_redeem_return_ambiguity_fix'/);
  assert.match(schema, /'030_onboarding_abuse_rate_limits'/);
  assert.match(schema, /'031_payment_status_action_rpc'/);
  assert.match(schema, /'033_onboarding_rate_limit_scope_key_alignment'/);
  assert.match(schema, /'034_invite_rate_limit_actor_email_ambiguity_fix'/);
  assert.match(schema, /'035_sql_ambiguity_guardrail'/);
  console.log("ok - testWorkspaceFoundationExists");
}

function testInviteOnboardingFoundationExists() {
  const app = readFileSync("app.js", "utf8");
  const index = readFileSync("index.html", "utf8");
  assert.match(schema, /create table if not exists public\.ledger_invites/);
  assert.match(schema, /invite_code_hash text not null/);
  assert.match(schema, /create index if not exists ledger_invites_ledger_active_idx/);
  assert.match(schema, /alter table public\.ledger_invites enable row level security/);
  assert.match(schema, /create policy "Ledger admins can read invites"/);
  assert.match(schema, /create policy "Ledger admins can update invites"/);
  assert.match(schema, /create or replace function public\.hash_ledger_invite_code/);
  assert.match(schema, /create or replace function public\.create_ledger_invite/);
  assert.match(schema, /safe_actor_email text := public\.current_user_email\(\)/);
  assert.match(schema, /safe_actor_email text := lower\(coalesce\(auth\.jwt\(\) ->> 'email', ''\)\)/);
  assert.doesNotMatch(schema, /declare\n  actor_email text := public\.current_user_email\(\)/);
  assert.doesNotMatch(schema, /declare[\s\S]*?\n\s*actor_email text := lower\(coalesce\(auth\.jwt\(\) ->> 'email', ''\)\)/);
  assert.match(schema, /create or replace function public\.redeem_ledger_invite/);
  assert.match(schema, /create or replace function public\.revoke_ledger_invite/);
  assert.match(schema, /create extension if not exists pgcrypto with schema extensions/);
  assert.match(schema, /generated_code := 'fl-'/);
  assert.match(schema, /extensions\.gen_random_bytes\(16\)/);
  assert.doesNotMatch(schema, /[^.]\bgen_random_bytes\(16\)/, "invite generation should schema-qualify pgcrypto random bytes");
  assert.match(schema, /extensions\.digest\(coalesce\(invite_code, ''\), 'sha256'\)/);
  assert.doesNotMatch(schema, /[^.]\bdigest\(coalesce\(invite_code, ''\), 'sha256'\)/, "invite hashing should schema-qualify pgcrypto digest");
  assert.match(schema, /Only ledger admins can create invites/);
  assert.match(schema, /A signed-in user email is required to redeem an invite/);
  assert.match(schema, /This invite is for a different email address/);
  assert.match(schema, /redeemed_ledger_id text/);
  assert.match(schema, /returning public\.ledger_members\.id, public\.ledger_members\.ledger_id, public\.ledger_members\.role/);
  assert.match(schema, /redeem_ledger_invite\.ledger_id := redeemed_ledger_id/);
  assert.match(schema, /redeem_ledger_invite\.member_id := saved_member_id/);
  assert.match(schema, /redeem_ledger_invite\.role := redeemed_role/);
  assert.doesNotMatch(schema, /returning id, ledger_id, role into saved_member_id, ledger_id, role/, "invite redemption should not return into ambiguous output column names");
  assert.match(schema, /'029_invite_redeem_return_ambiguity_fix'/);
  assert.doesNotMatch(schema, /fuel_ledger_schema_migrations \(migration_id, notes\)/, "schema migration tracking should use description, not a non-existent notes column");
  assert.doesNotMatch(schema, /notes = excluded\.notes/, "schema migration tracking should not update a non-existent notes column");
  assert.match(schema, /'ledger_invites'/);
  assert.match(schema, /'create_ledger_invite'/);
  assert.match(schema, /'redeem_ledger_invite'/);
  assert.match(schema, /'revoke_ledger_invite'/);
  assert.match(schema, /'invite_onboarding_ready'/);
  assert.match(schema, /'026_invite_onboarding_foundation'/);
  assert.match(index, /id="workspaceInvitesHeading">Workspaces &amp; invites/);
  assert.match(index, /id="createInviteForm"/);
  assert.match(index, /id="inviteList"/);
  assert.match(index, /id="inviteRedemptionPanel"/);
  assert.match(index, /id="redeemInviteForm"/);
  assert.match(index, /id="redeemInviteCode"/);
  assert.match(index, /id="loginInviteCode"/);
  assert.match(index, /Invite link\/code = permission to join a workspace/);
  assert.match(app, /pendingWorkspaceInviteCodeKey/);
  assert.match(app, /redeemPendingLoginInviteAfterSignIn/);
  assert.match(app, /rememberLoginInviteCode/);
  assert.match(app, /redeemWorkspaceInvite\(pendingInviteCode\)/);
  assert.match(app, /If the invite was restricted to one email, it will only redeem for this exact email/);
  assert.match(app, /describeWorkspaceInviteError/);
  assert.match(app, /Supabase invite code generator is not installed/);
  assert.match(app, /027_invite_code_generation_pgcrypto_fix/);
  assert.match(app, /028_invite_code_hash_pgcrypto_fix/);
  assert.match(app, /supabaseClient\.rpc\("create_ledger_invite"/);
  assert.match(app, /supabaseClient\.rpc\("revoke_ledger_invite"/);
  assert.match(app, /supabaseClient\.rpc\("redeem_ledger_invite"/);
  assert.match(app, /describeInviteRedeemError/);
  assert.match(app, /switchActiveWorkspace\(targetLedger, "invite-redemption"\)/);
  assert.match(app, /supabaseClient\.rpc\("list_my_ledgers"/);
  assert.match(index, /Codes are shown once, stored hashed in Supabase, and are not emailed automatically/);
  console.log("ok - testInviteOnboardingFoundationExists");
}



function testWorkspaceInviteUxLayoutExists() {
  const index = readFileSync("index.html", "utf8");
  const css = readFileSync("styles.css", "utf8");
  assert.match(index, /class="workspace-invites-intro"/);
  assert.match(index, /<div class="workspace-invites-grid">/);
  assert.match(index, /Use the top workspace selector or the buttons below to switch the current app scope/);
  assert.match(index, /Join another workspace with invite code/);
  assert.match(index, /not emailed automatically/);
  assert.match(index, /send it to the person out-of-band/);
  assert.match(index, /Already signed in and received another workspace invite/);
  assert.doesNotMatch(index, /data-tools-grid workspace-invites-grid/);
  assert.match(css, /\.workspace-invites-grid \{[\s\S]*grid-template-columns: minmax\(280px, 0\.9fr\) minmax\(260px, 0\.8fr\) minmax\(300px, 1fr\)/);
  assert.match(css, /\.workspace-invites-grid \.compact-admin-form \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.workspace-invites-grid \.compact-list \.member-management-row \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.invite-redemption-panel \.invite-redemption-form/);
  assert.match(css, /\.auth-form \.compact-note \{[\s\S]*grid-column: 1 \/ -1/);
  console.log("ok - testWorkspaceInviteUxLayoutExists");
}

function testCurrentWorkspaceUxScopeExists() {
  const app = readFileSync("app.js", "utf8");
  const index = readFileSync("index.html", "utf8");
  const css = readFileSync("styles.css", "utf8");
  assert.match(index, /id="topbarWorkspaceScope"/);
  assert.match(index, /id="workspaceScopeHeading">Current workspace insights/);
  assert.match(index, /id="workspaceScopeSummary"/);
  assert.match(index, /Fuel intelligence for this workspace/);
  assert.match(index, /Station insights for this workspace/);
  assert.match(index, /Smart predictions for this workspace/);
  assert.match(index, /Monthly member summaries for this workspace/);
  assert.match(index, /Other workspaces stay separate/);
  assert.match(index, /id="activeWorkspace"/);
  assert.match(index, /Workspace/);
  assert.match(app, /function getActiveLedgerId\(\)/);
  assert.match(app, /function setActiveLedgerId\(ledgerId/);
  assert.match(app, /function switchActiveWorkspace\(ledgerId/);
  assert.match(app, /supabaseConfig\.activeLedgerId/);
  assert.match(app, /You can only switch to workspaces linked to your signed-in email/);
  assert.match(app, /Workspace switch sync is delayed/);
  assert.match(app, /function getCurrentWorkspaceContext\(\)/);
  assert.match(app, /function getCurrentWorkspaceLabel\(\)/);
  assert.match(app, /function renderWorkspaceScopeSummary\(ledger = calculateLedger\(\)\)/);
  assert.match(app, /Insights are per workspace/);
  assert.match(app, /Use the workspace selector to reload this app around another linked workspace/);
  assert.match(app, /renderActiveWorkspaceSelector\(\);/);
  assert.match(app, /renderWorkspaceScopeSummary\(ledger\);/);
  assert.match(css, /\.workspace-scope-grid/);
  console.log("ok - testCurrentWorkspaceUxScopeExists");
}

function testAuthBoundWorkspaceIdentityExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /let authBoundMemberProfile = null/);
  assert.match(app, /const pendingWorkspaceInviteCodeKey = "fuel-ledger-pending-workspace-invite-code"/);
  assert.match(app, /async function refreshAuthBoundMemberProfile\(\)/);
  assert.match(app, /getAuthBoundMemberProfileFallback\(\)/);
  assert.match(app, /profile && !profile\.pendingInvite && profile\.role === "admin"/);
  assert.doesNotMatch(app, /profile\?\.role === "admin" \|\| noMemberEmailsConfigured\(\)/);
  assert.match(app, /function getSignedInDisplayProfile\(\)/);
  assert.match(app, /local JSON member profiles are display\/cache data only/);
  assert.match(app, /if \(supabaseClient\) return false/);
  assert.match(app, /auth-bound member is not confirmed admin; skipping ledgers\/table reconciliation/);
  assert.match(app, /currentUser = displayName/);
  assert.match(app, /const displayName = displayProfile\?\.name \|\| ""/);
  assert.match(app, /knownLoggedInMember = Boolean\(profile && !profile\.pendingInvite\)/);
  assert.match(app, /refreshLinkedWorkspacesAfterInvite\(\)\.catch/);
  assert.doesNotMatch(app, /supabaseClient\.from\("ledgers"\)\.select\("\*"\)\.eq\("id", ledgerId\)\.maybeSingle\(\)/);
  assert.match(app, /Paste an invite code to join another workspace/);
  assert.match(app, /Share the invite link below/);
  assert.match(app, /data-copy=\"\$\{escapeHtml\(inviteLink\)\}\"/);
  assert.match(app, /const linkedWorkspace = getLinkedWorkspaceForActiveLedger\(\)/);
  console.log("ok - testAuthBoundWorkspaceIdentityExists");
}


function testWorkspaceSyncCompletionGuardExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /function markCloudSyncDidNotComplete\(message = "Cloud sync did not complete\."\)/);
  assert.match(app, /result === false && !timedOut/);
  assert.match(app, /String\(els\.syncStatus\.dataset\.status \|\| ""\) !== "syncing"/);
  assert.match(app, /lastSyncError = message/);
  assert.match(app, /setSyncStatus\("Delayed"\)/);
  assert.match(app, /setSyncStatus\(normalizedReadModeActive \? "Tables" : "Cloud"\)/);
  console.log("ok - testWorkspaceSyncCompletionGuardExists");
}

function testWorkspaceInviteRefreshFailSafeExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /const workspaceInviteRequestTimeoutMs = 15000/);
  assert.match(app, /function describeWorkspaceRefreshError\(error\)/);
  assert.match(app, /Workspace invite refresh timed out/);
  assert.match(app, /async function withWorkspaceInviteRequestTimeout\(requestPromise, label/);
  assert.match(app, /Promise\.race\(\[/);
  assert.match(app, /withWorkspaceInviteRequestTimeout\(\s*supabaseClient\.rpc\("list_my_ledgers"\)/);
  assert.match(app, /withWorkspaceInviteRequestTimeout\(\s*supabaseClient\s*\.from\("ledger_invites"\)/);
  assert.match(app, /workspaceInviteStatus\.loaded = Boolean\(getWorkspaceLedgerOptions\(\)\.length\);\s*workspaceInviteStatus\.invites = \[\];/);
  assert.match(app, /els\.refreshWorkspaceInvites\.disabled = false/);
  console.log("ok - testWorkspaceInviteRefreshFailSafeExists");
}

function testWorkspaceInviteAutoRefreshExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /let workspaceInviteRefreshPromise = null/);
  assert.match(app, /function scheduleWorkspaceInviteRefresh\(reason = "workspace-invite-refresh"\)/);
  assert.match(app, /function canRefreshWorkspaceInviteTools\(\)/);
  assert.match(app, /async function ensureWorkspaceInviteToolsReady\(reason = "workspace-invite-ready"\)/);
  assert.match(app, /if \(activeView === "admin"\) \{\s*scheduleWorkspaceInviteRefresh\("admin-tab-open"\);\s*refreshOwnerActivity\(\{ silent: true \}\);/);
  assert.match(app, /scheduleWorkspaceInviteRefresh\("startup-session"\)/);
  assert.match(app, /scheduleWorkspaceInviteRefresh\("auth-session"\)/);
  assert.match(app, /scheduleWorkspaceInviteRefresh\("account-panel-render"\)/);
  assert.match(app, /await ensureWorkspaceInviteToolsReady\("before-create-invite"\)/);
  assert.match(app, /withWorkspaceInviteRequestTimeout\(\s*supabaseClient\.rpc\("create_ledger_invite"/);
  assert.match(app, /scheduleWorkspaceInviteRefresh\("after-create-invite"\)/);
  console.log("ok - testWorkspaceInviteAutoRefreshExists");
}

function testPrivateWorkspaceCreationUiExists() {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("app.js", "utf8");
  assert.match(html, /id="createWorkspaceForm"/);
  assert.match(html, /id="newWorkspaceName"/);
  assert.match(html, /Create new workspace/);
  assert.match(html, /Public signup stays off/);
  assert.match(app, /async function createPrivateWorkspaceFromUi\(\)/);
  assert.match(app, /supabaseClient\.rpc\("create_private_ledger_workspace"/);
  assert.match(app, /switchActiveWorkspace\(newLedgerId, "create-workspace"\)/);
  assert.match(app, /scheduleWorkspaceInviteRefresh\("after-create-workspace"\)/);
  assert.match(app, /workspace\/invite abuse rate-limit migration not confirmed/);
  assert.match(app, /abuse_rate_limit_ready/);
  console.log("ok - testPrivateWorkspaceCreationUiExists");
}

function testOnboardingAbuseRateLimitFoundationExists() {
  assert.match(schema, /create table if not exists public\.ledger_onboarding_rate_limits/);
  assert.match(schema, /create or replace function public\.enforce_onboarding_rate_limit/);
  assert.match(schema, /unique \(action, actor_email, scope_key, window_started_at\)/);
  assert.match(schema, /ledger_onboarding_rate_limits_scope_key_window_idx/);
  assert.match(schema, /perform public\.enforce_onboarding_rate_limit\('create_private_workspace', null, 3, 60\)/);
  assert.match(schema, /perform public\.enforce_onboarding_rate_limit\('create_ledger_invite', target_ledger_id, 20, 60\)/);
  assert.match(schema, /perform public\.enforce_onboarding_rate_limit\('redeem_ledger_invite', null, 8, 60\)/);
  assert.match(schema, /'030_onboarding_abuse_rate_limits'/);
  assert.match(schema, /'031_payment_status_action_rpc'/);
  assert.match(schema, /'abuse_rate_limit_ready'/);
  console.log("ok - testOnboardingAbuseRateLimitFoundationExists");
}


function testSettlementPaymentSaveSkipsLedgerUpsert() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /async function getNormalizedWriteContext\(options = \{\}\)/);
  assert.match(app, /const syncDirectory = options\.syncDirectory !== false/);
  assert.match(app, /if \(syncDirectory && canManageSettings\(\)\)/);
  assert.match(app, /getNormalizedWriteContext\(\{ syncDirectory: false, source: "payment-action-context" \}\)/);
  assert.match(app, /settlement-directory-sync-skip/);
  assert.match(app, /slug: String\(ledgerId \|\| getConfiguredLedgerId\(\)\)\.trim\(\) \|\| getConfiguredLedgerId\(\)/);
  assert.doesNotMatch(app, /async function saveSettlementRequestToNormalizedTableFirst[\s\S]*?\.from\("ledgers"\)\.upsert/, "settlement payment status saves must not directly upsert ledgers");
  assert.match(app, /const paymentStatusActionTimeoutMs = 15000/);
  assert.match(app, /async function withPaymentStatusActionTimeout/);
  assert.match(app, /finally \{[\s\S]*pendingSettlementRequestKeys\.delete\(key\)[\s\S]*clearPaymentActionSavingUi/);
  assert.match(app, /payment-action-backend-not-started|payment-action-timeout/);
  assert.match(app, /AbortController/);
  console.log("ok - testSettlementPaymentSaveSkipsLedgerUpsert");
}


function testDataIoFlightRecorderExists() {
  const app = readFileSync("app.js", "utf8");
  assert.match(app, /const dataIoDiagnostics = \[\]/);
  assert.match(app, /function recordDataIoDiagnostic\(phase, meta = \{\}\)/);
  assert.match(app, /let dataIoOperationCounter = 0/);
  assert.match(app, /function createDataIoOperationId\(source = "data-io"\)/);
  assert.match(app, /const dataIoOperationStaleMs = 15000/);
  assert.match(app, /function hasActiveDataIoOperation\(referenceTime = Date\.now\(\), maxAgeMs = dataIoOperationStaleMs\)/);
  assert.match(app, /operation\.status = "timeout";[\s\S]*operation\.durationMs = Math\.max/);
  assert.match(app, /if \(entry\.operationId\) return `op:\$\{entry\.operationId\}`/);
  assert.match(app, /operationId: meta\.operationId \|\| ""/);
  assert.match(app, /async function traceDataIo\(meta, operation\)/);
  assert.match(app, /const operationId = meta\.operationId \|\| createDataIoOperationId\(meta\.source\)/);
  assert.match(app, /data-io-failure/);
  assert.match(app, /Latest data I\/O/);
  assert.match(app, /latestDataIoDiagnostic/);
  assert.match(app, /function latestDataIoOperations\(limit = 6\)/);
  assert.match(app, /function formatDataIoOperationLine\(operation = \{\}\)/);
  assert.match(app, /Latest data I\/O operations/);
  assert.match(app, /dataIoDiagnostics: latestDataIoDiagnostics\(10\)/);
  assert.match(app, /dataIoOperations: latestDataIoOperations\(10\)/);
  assert.match(app, /source: "trip-save"/);
  assert.match(app, /source: "fuel-save"/);
  assert.match(app, /source: "booking-save"/);
  assert.match(app, /source: "settlement-request-save"/);
  assert.match(app, /route: "render-api"/);
  assert.match(app, /route: "supabase-rpc"/);
  assert.match(app, /route: "direct-table"/);
  assert.match(app, /const traceMeta = \{ source: "settlement-request-save", route: "render-api", endpoint: renderPaymentStatusActionUrl, operation: payload\.status, operationId \}/);
  assert.match(app, /Refusing to upsert ledgers without slug/);
  assert.match(app, /ledgers upsert blocked before Supabase because slug is required/);
  console.log("ok - testDataIoFlightRecorderExists");
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
testSettlementRequestTransactionRpcExists();
testPeriodCloseRpcExists();
testTripTransactionRpcExists();
testBookingTransactionRpcsExist();
testFuelPaymentRpcExists();
testAdminReconciliationSafetyGateExists();
testAdminToolsGuardrailRpcsExist();
testAdminTestLabProtectionsExist();
testDiagnosticPrivacyRedactionExists();
testJsonWriteReductionGuardrailsExist();
testLocalTripSubmitFlushesServerState();
testBookingPlannedParticipantsSurviveTripSubmit();
testSupabaseLoadTimeoutGuardExists();
testRealtimePerformanceGuardrailsExist();
testDestructiveActionBackupsExist();
testAdminDiagnosticsUxExists();
testReleaseAboutPanelExists();
testSyncHealthBannerExists();
testTestLabReportStoreExists();
testRetentionPrivacyCleanupCoversCloudReports();
testBootstrapLockExists();
testSchemaMigrationTrackingExists();
testSchemaDriftHealthcheckExists();
testWorkspaceFoundationExists();
testInviteOnboardingFoundationExists();
testWorkspaceInviteUxLayoutExists();
testCurrentWorkspaceUxScopeExists();
testAuthBoundWorkspaceIdentityExists();
testWorkspaceSyncCompletionGuardExists();
testWorkspaceInviteRefreshFailSafeExists();
testWorkspaceInviteAutoRefreshExists();
testPrivateWorkspaceCreationUiExists();
testOnboardingAbuseRateLimitFoundationExists();
testSettlementPaymentSaveSkipsLedgerUpsert();
testDataIoFlightRecorderExists();
testFuelLedgerHealthcheckExists();
