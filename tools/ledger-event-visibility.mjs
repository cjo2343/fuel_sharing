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

  // Bookings (migrations 051, 063) and the handover that ends one (164).
  "booking_created",
  // handover_created is written on CREATE only (never on an edit) and is feed-visible
  // on purpose: the whole point of a handover is that the NEXT driver learns where the
  // car and its keys were left, and the feed is where the group looks. The title comes
  // from the client, so it says what happened without repeating the free-text location.
  "handover_created",

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
  // vehicle_location_updated (migration 167, GVM-520) — written by set_vehicle_location
  // when the caller supplies an event_title. Feed-visible on purpose and not a close
  // call: the entire point of recording that the car moved is that the rest of the
  // group finds out. The title comes from the client and the metadata carries only
  // booleans saying whether each field now holds a value, so the free-text parking spot
  // and key placement never reach the event row — the personal-adjacent text stays in
  // the one column every member can already read.
  "vehicle_location_updated",
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
