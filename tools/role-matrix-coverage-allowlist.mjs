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
  {
    fn: 'set_tank_state',
    reason:
      'Dark ON PURPOSE, and only until GVM-480 lands. Migration 154 (GV-405) is the ' +
      'backend half of the pre-departure fuel-stop push, split across three tickets: this ' +
      'migration, the Cloudflare hook endpoint (GV-406), and the mobile stamp writer ' +
      'that calls this RPC after every trip / fuel write (GVM-480). Until that last one ' +
      'ships, nothing writes ledgers.tank_state_*, so the claim RPC finds no complete ' +
      'stamp and pushes nothing — the feature degrades to silence rather than to a wrong ' +
      'nudge, which is the intended staging. The guard exercises it because the member ' +
      'gate is the only thing standing between one workspace and another workspace\'s ' +
      'tank data, and a gate nobody tests is the gate migration 068 dropped. What would ' +
      'change this answer: GVM-480 merging, at which point findClientCallers sees the ' +
      'call site, this entry goes STALE, and deleting it is the correct fix. If GVM-480 ' +
      'is ABANDONED instead, the honest fix is to revoke the authenticated grant and ' +
      'retire the RPC, not to renew this entry.',
    reviewBy: '2026-10-26',
  },
];
