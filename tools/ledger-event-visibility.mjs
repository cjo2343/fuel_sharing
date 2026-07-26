// The visibility register for public.ledger_events event types (GV-413).
//
// EVERY ENTRY HERE IS AN EVENT TYPE SOMEONE LOOKED AT AND ACCEPTED AS MEMBER-VISIBLE —
// NOT A LIST OF TYPES THE SCANNER HAPPENED TO FIND.
//
// govehlo-mobile's Activity feed has no allow-list. getEventMeta matches on prefix and
// ends in a catch-all, and the row's title is drawn straight from ledger_events.title.
// So the feed shows whatever the database writes, and the ONLY thing keeping an
// internal audit row out of it is the exclusion filter in ledger-data-gateway.ts,
// mirrored here as EVENT_TYPE_EXCLUDE in tools/load-rehearsal/lib/hotpaths.mjs.
//
// That arrangement is right for a feed and wrong for an audit row, and the difference
// was never written down anywhere. Three reminder-audit types leaked into members'
// feeds in a single evening — weekly_digest_sent, booking_fuel_reminder_sent (GVM-488),
// confirm_reminder_sent (GVM-490, live since migration 118) — each caught by a person,
// never by a test.
//
// tools/check-ledger-event-classification.mjs reads every event_type the SQL can write
// and requires each one to be in exactly one of:
//
//   • EVENT_TYPE_EXCLUDE (tools/load-rehearsal/lib/hotpaths.mjs) — audit only. The
//     client filters these out. That list is mirrored from the mobile gateway and
//     compared order-sensitively by check-hotpath-mirror.mjs, so it must be changed on
//     BOTH sides in the same PR pair.
//   • FEED_VISIBLE_EVENT_TYPES (below) — accepted as visible to every member.
//
// The guard forces the choice; it does not make it. Both answers pass. Adding a type
// here is a real decision: the row will appear in every member's Activity feed, with
// its database title, for as long as it is retained.

// ── Feed-visible ────────────────────────────────────────────────────────────
// Order is grouped by domain, not alphabetical — this list is read by people deciding
// where a new type belongs. Nothing compares it against another repo, so unlike
// EVENT_TYPE_EXCLUDE the ordering here carries no cross-repo obligation.
export const FEED_VISIBLE_EVENT_TYPES = [
  // Trips and fuel — the two core log entries (migrations 051, 063).
  "trip_created",
  "fuel_created",
  "trip_fuel_closed",

  // Bookings (migrations 051, 063).
  "booking_created",

  // Members (migrations 059, 079, 096, 112).
  "member_joined",
  "member_renamed",
  "member_promoted",
  "member_deleted",

  // Workspace lifecycle and settings (migrations 052, 053, 119, 132–135).
  "workspace_created",
  "workspace_decommissioned",
  "workspace_restored",
  "settings_changed",

  // Vehicle, insurance and inspection (migrations 052, 064, 074, 138).
  "vehicle_added",
  "vehicle_updated",
  "insurance_updated",
  "inspection_due",
  "vehicle_inspection_booked",
  "vehicle_inspection_booking_cleared",
  "incident_logged",
  "incident_updated",

  // Expenses, recurring entries and repairs (migrations 065–070, 073, 075, 077, 112).
  "expense_added",
  "expense_updated",
  "expense_recurring_added",
  "recurring_expense_added",
  "recurring_expense_updated",
  "recurring_suspended",

  // Settlement and payment status. These are the feed's only actionable rows:
  // payment_requested carries metadata.settlement_request_id and drives the role-aware
  // Pay / Remind CTA (migrations 031, 035, 087, 089, 090, 103, 104, 115, 137).
  "payment_requested",
  "payment_claimed",
  "payment_disputed",
  "payment_paid",
  "payment_marked_paid",
  "payment_reopened",
  "settlement_open",
  "settlement_cancelled",
  "period_closed",

  // Written by govehlo-web, not by any migration: the operator console's soft-delete
  // endpoint (functions/api/owner/workspace/[id]/soft-delete.js) logs one event per
  // removal so members' clients live-sync it. Deliberately visible — a workspace whose
  // data the operator touched should say so. The migrations-only scan is blind to it,
  // which is why the guard also reads govehlo-web when that repo is checked out.
  "operator_data_removed",

  // ── Classified as VISIBLE because that is what production does today, not because
  // it should be ──────────────────────────────────────────────────────────────
  // confirm_reminder_sent is a reminder-audit row (migration 118, live since GV-286).
  // It belongs in EVENT_TYPE_EXCLUDE with the other four *_reminder_sent types, and
  // GVM-490 will move it there. It is recorded here rather than in the exclusion list
  // for one reason: EVENT_TYPE_EXCLUDE is mirrored from govehlo-mobile's
  // ledger-data-gateway.ts and compared order-sensitively by check-hotpath-mirror.mjs,
  // so changing only this side turns the umbrella workflow red on main. Moving it is a
  // two-repo change and is GVM-490's job.
  //
  // Until then this entry states the truth: members can see it. When GVM-490 lands, it
  // moves to EVENT_TYPE_EXCLUDE and this line is deleted — the guard fails if it is in
  // both lists, so the move cannot be half-done.
  "confirm_reminder_sent",
];

// ── Event types written outside the migrations ──────────────────────────────
// govehlo-web writes straight into ledger_events from the operator console rather than
// through an RPC, so a migrations-only scan cannot see these at all. The guard reads
// govehlo-web when that repo is checked out (a dev machine, or the umbrella workflow)
// and skips it otherwise — so this list is what stops "we could not look" being
// mistaken for "nothing writes this" on a run where only fuel_sharing is present.
//
// Every entry still has to be classified feed-or-audit above like anything else; the
// guard fails if one is not. Add to this list when govehlo-web starts writing a new
// event type directly, and delete from it when it stops.
export const WEB_WRITTEN_EVENT_TYPES = ["operator_data_removed"];

// ── Event types no static scan can read ─────────────────────────────────────
// Six migrations build the settlement event type by concatenation:
//
//   event_type_value := case … else 'settlement_' || normalized_status end;
//
// No scanner can reduce that to literals, and a scanner that shrugs at what it cannot
// read is how the last guard died (GV-393). So an unresolvable expression is a hard
// failure unless it is declared here with the concrete types it can produce — which
// then go through the same feed/audit classification as everything else.
//
// normalized_status is constrained by the RPC itself to
// ('open','requested','paid','paid_pending','cancelled'); the CASE handles requested,
// paid and paid_pending explicitly, so the ELSE branch can only ever produce
// settlement_open or settlement_cancelled.
//
// Keys are the expression text with whitespace collapsed. An entry that no INSERT
// writes any more is a failure too, so this cannot rot into a silencer.
export const COMPUTED_EVENT_TYPE_EXPRESSIONS = {
  "'settlement_' || normalized_status": ["settlement_open", "settlement_cancelled"],
};
