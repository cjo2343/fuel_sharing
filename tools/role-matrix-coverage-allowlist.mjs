// Reviewed exceptions for the role-matrix coverage check (GV-379).
//
// EVERY ENTRY HERE IS A FUNCTION THIS REPO'S OWN GUARD CERTIFIES BUT NO CLIENT CALLS —
// NOT A SILENCED WARNING.
//
// tools/test-rls-role-matrix.mjs fails when it exercises a function that `authenticated`
// may execute but that neither govehlo-mobile nor govehlo-web calls. Listing one here
// does NOT make it disappear: the guard still prints a warning naming the function, the
// reason and the review-by date on every single run, so the exception stays in front of
// whoever reads the output. This mirrors the reviewed-exceptions pattern GV-371
// established in tools/token-markup-allowlist.mjs.
//
// ── Why an allow-list at all, and why it must expire ──────────────────────────
//
// GV-277 put the whole recurring-suspension feature on set_ledger_member_active_admin,
// a function no client calls. It was dark from migration 114 until migration 145 fixed
// it, and GVM-330's entire reading half sat built and unreachable that whole time. CI
// stayed green throughout for one reason: the role-matrix guard is the only caller of
// that function anywhere, so it certified a code path production never takes.
//
// The guard cannot know which of those overlaps are intended — a service-role helper
// and a forgotten RPC look identical from here. So it does not guess: it makes the
// overlap a written, dated, expiring judgement instead of a silent one. The failure
// mode being designed against is a large rubber-stamp allow-list (rejected twice
// already — GV-375's admin amber guard and GV-374's scanner-widening decision), which
// is why entries rot on purpose.
//
// The guard fails when an entry is:
//   - STALE      — the function is no longer exercised by the guard, or a client now
//                  calls it. The reason no longer holds; delete the entry.
//   - EXPIRED    — `reviewBy` is in the past. Make the judgement again: either retire
//                  the function / revoke its grant / give it a real caller, or write
//                  down afresh why it still stands and push `reviewBy` out.
//   - MALFORMED  — missing fn/reason/reviewBy, or a duplicate.
//
// So the only way an exception survives is that a human re-reads it every few months
// and consciously renews it.
//
// Entry shape (all fields required):
//   fn       — the function name, unqualified (no `public.` prefix)
//   reason   — why the guard should keep exercising something no client calls; write it
//              for a reviewer with no context, and say what would change the answer
//   reviewBy — YYYY-MM-DD; the date this judgement must be re-made by

export const coverageExceptions = [
  {
    fn: 'calculate_period_entry_fingerprint',
    reason:
      'Not dead — reachable, just not directly from a client. It is called in-SQL by ' +
      'close_settlement_period (migrations 104/087/101/141) and by ' +
      'owner_settlement_integrity_batch (127), both SECURITY DEFINER, so migration 114\'s ' +
      'change to it (repairs keyed by id+amount pairs) does reach production through those ' +
      'callers; the mobile client mirrors the format independently in ' +
      'src/lib/period-snapshot.ts rather than calling the RPC. The guard exercises it ' +
      'directly to assert the membership gate migration 055 added and migration 068 ' +
      'accidentally dropped — a gate its in-SQL callers bypass by construction, so testing ' +
      'it through them would prove nothing. What would change this answer: the GV-380 ' +
      'privilege review deciding the authenticated grant should be revoked (it is an ' +
      'internal calculator, and migration 143 revoked eleven peers on exactly that ' +
      'reasoning). If the grant goes, this entry goes with it and the direct case becomes ' +
      'a service-role case.',
    reviewBy: '2026-10-25',
  },
  // recompute_handover_mirror needs NO entry, and the coverage check is what proved it.
  // Migration 195 (GV-475) shipped the RPC server-first and its own tracker note said the
  // mobile affordance was a follow-up, so the GV-477 role-matrix cases were written
  // expecting the migration-195-first window and an entry was drafted here for it. The
  // guard immediately reported that entry STALE, naming govehlo-mobile's
  // src/lib/handover-mirror.ts and src/screens/CarProfile/useHandoverMirror.ts: the
  // follow-up had already landed. Deleted rather than renewed, which is the prescribed
  // course, and a reminder that this list is the wrong place to record an intention.
  // attach_fuel_payment_receipt's and detach_fuel_payment_receipt's entries were
  // deleted here on the entries' own instruction: they covered only the
  // migration-169-first window, and govehlo-mobile has called both RPCs since PR #563
  // (src/lib/fuel-receipts.ts via supabase-helpers.ts) — findClientCallers sees the
  // calls, the guard reported both entries STALE, and stale entries are deleted, not
  // renewed. Same course as set_vehicle_location, upsert_booking_handover and
  // set_tank_state below.
  // set_vehicle_location's entry was deleted here on the entry's own instruction:
  // it covered only the migration-167-first window, and govehlo-mobile has called
  // the RPC since PR #561 (src/lib/vehicle-location.ts via supabase-helpers.ts) —
  // findClientCallers sees it, so the entry went STALE and stale entries are
  // deleted, not renewed. Same course as upsert_booking_handover and set_tank_state.
  // upsert_booking_handover's entry was deleted here exactly as the entry itself
  // prescribed: it covered only the migration-164-first window before the handover
  // sheet shipped, and govehlo-mobile has called the RPC since PR #555
  // (src/lib/handover.ts via supabase-helpers.ts) — findClientCallers sees it, the
  // guard reported the entry STALE, and stale entries are deleted, not renewed.
  // set_workspace_monthly_budget's entry was deleted here (GVM-523), exactly as the entry
  // itself prescribed: it covered only the migration-200-first window, and govehlo-mobile
  // has called the RPC on main since the GVM-574 half landed (src/lib/supabase-helpers.ts,
  // src/screens/Insights/BudgetSheet.tsx) — findClientCallers sees it, the guard reported
  // the entry STALE, and stale entries are deleted, not renewed.
  // The FIVE vehicle-document entries (create/update/delete_vehicle_document,
  // add/delete_vehicle_document_photo) were deleted here on 2026-08-10, exactly as their
  // own block comment prescribed. They covered only the migration-201-first window, and
  // govehlo-mobile has called all five on main since PR #621 (src/lib/vehicle-documents.ts
  // via supabase-helpers.ts, plus the CarProfile archive screens) — findClientCallers sees
  // them, the guard reported all five STALE, and stale entries are deleted, not renewed.
  // The same course set_vehicle_location, upsert_booking_handover, set_tank_state,
  // set_workspace_monthly_budget and the two fuel-receipt RPCs all took. This is what had
  // the umbrella's role-matrix job red.
  // ── Migration 202 (GVM-238 P0), "Jeg er på vej" ─────────────────────────────
  // Two entries, one window, one reason: PostgREST answers PGRST202 for a function that
  // does not exist, so the SQL must be applied in production before any client may call
  // it — the platform half lands first and the mobile half follows. Listed separately
  // because they expire separately: a mobile half that ships the share button but leaves
  // auto-stop to a later slice would make the clear entry stale and not the set one.
  //
  // The role matrix exercises both for the gates nothing else can prove today: that
  // sharing is member-or-creator and NOT admin (the one place this feature deliberately
  // refuses public.can_manage_car_booking), that a refresh keeps started_at and writes the
  // AUDIT type rather than a second feed row, and that clearing is idempotent.
  //
  // What changes this answer, for both: govehlo-mobile's GVM-238 half landing a call, at
  // which point findClientCallers sees it, the guard reports the entry STALE, and it is
  // DELETED rather than renewed — the course every entry above took. If the feature is
  // abandoned instead, the honest fix is to revoke the authenticated grants and drop the
  // column, not to renew these.
  {
    fn: 'set_on_my_way',
    reason:
      'Migration-first window only (migration 202, GVM-238 P0). No client calls it until ' +
      'the mobile share button ships. The matrix proves the gate this feature argues hardest ' +
      'about — the booking\'s member or creator may share, a workspace ADMIN may not, which ' +
      'is the one place the schema deliberately declines can_manage_car_booking — plus the ' +
      '1..600 minute bounds, the ended-booking refusal, and that a refresh preserves ' +
      'started_at while writing the audit event type instead of a second feed row. That last ' +
      'one has no other possible prover: a static scan sees both INSERT sites and cannot say ' +
      'which one a second call takes.',
    reviewBy: '2026-11-10',
  },
  {
    fn: 'clear_on_my_way',
    reason:
      'Migration-first window only (migration 202, GVM-238 P0). The stop half, called by ' +
      'arrival, booking end and the manual stop — three racing auto-stops, which is why ' +
      'IDEMPOTENCE is the property under test: a second clear must return cleared=false and ' +
      'write no event. Also proves the deliberate asymmetry with set_on_my_way — this one ' +
      'DOES admit the workspace admin, because clearing a share stuck on by a crashed client ' +
      'removes information rather than asserting any. No client caller yet.',
    reviewBy: '2026-11-10',
  },
  // set_tank_state's entry was deleted in GV-411, exactly as the entry itself said it
  // should be: it existed only while the mobile stamp writer (GVM-480) was unmerged, and
  // that has landed — findClientCallers now sees govehlo-mobile/src/lib/supabase-helpers.ts
  // and src/lib/tank-state-stamp.ts. The guard had been reporting it STALE since, which is
  // the mechanism working; deleting is the prescribed fix, not renewing.
];
