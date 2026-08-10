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
  {
    fn: 'set_workspace_monthly_budget',
    reason:
      'The migration-first window, and nothing more. Migration 200 (GVM-574) ships the ' +
      'SHARED workspace monthly budget server-side ahead of the mobile half, because ' +
      'PostgREST answers PGRST202 for a function that does not exist — so the RPC must be ' +
      'applied in production before any client may call it. No client calls it yet, which ' +
      'is precisely why the guard sees an overlap. The role matrix exercises it for the ' +
      'admin gate, the four validation refusals, the øre rounding, the GV-292 no-op rule ' +
      'and the Danish-formatted settings_changed event — none of which any other caller ' +
      'could prove today. What changes this answer: govehlo-mobile\'s GVM-574 half landing ' +
      'a call in src/lib/supabase-helpers.ts, at which point findClientCallers sees it, the ' +
      'guard reports this entry STALE, and it is DELETED rather than renewed — the course ' +
      'set_vehicle_location, upsert_booking_handover, set_tank_state and the two fuel-receipt ' +
      'RPCs all took. If the mobile half is abandoned instead, the honest fix is to revoke ' +
      'the authenticated grant, not to renew this.',
    reviewBy: '2026-11-10',
  },
  // set_tank_state's entry was deleted in GV-411, exactly as the entry itself said it
  // should be: it existed only while the mobile stamp writer (GVM-480) was unmerged, and
  // that has landed — findClientCallers now sees govehlo-mobile/src/lib/supabase-helpers.ts
  // and src/lib/tank-state-stamp.ts. The guard had been reporting it STALE since, which is
  // the mechanism working; deleting is the prescribed fix, not renewing.
];
