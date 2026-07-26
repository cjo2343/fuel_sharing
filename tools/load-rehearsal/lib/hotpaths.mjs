// The mobile app's authenticated hot paths, expressed as PostgREST requests.
//
// This module is the single place that MIRRORS the real client so the load
// driver exercises exactly what a member's device does. It is derived, line for
// line, from:
//
//   govehlo-mobile/src/store/ledger-data-gateway.ts   (the 12-query read fan-out
//       LedgerContext runs on every workspace load, + the trip_participants read)
//   govehlo-mobile/src/store/LedgerContext.tsx         (resolveActiveLedgerId →
//       list_my_ledgers; the settlement-balance + write RPCs)
//   govehlo-mobile/src/lib/supabase-helpers.ts         (RPC names + argument keys)
//   govehlo-mobile/src/lib/settlement-data-guard.ts    (SETTLE_ROW_CAP + 1 sentinel)
//
// If the gateway changes, this file must change with it. The unit tests assert
// the mirrored labels, filters, limits and the event-type exclusion so drift is
// caught here rather than in a live run.

// Mirrors settlement-data-guard.ts: the fan-out fetches SETTLE_ROW_CAP + 1 rows
// so truncation is provable.
export const SETTLE_ROW_CAP = 500;

// Mirrors ledger-data-gateway.ts: reminder-audit event types kept off the member
// feed.
export const EVENT_TYPE_EXCLUDE = [
  "payment_reminder_sent",
  "close_reminder_sent",
  "booking_completion_reminder_sent",
  "weekly_digest_sent",
  "booking_fuel_reminder_sent",
  // GVM-490: live in members' feeds since migration 118 as "Påmindelse om
  // bekræftelse sendt". Appended last — check-hotpath-mirror.mjs compares this
  // list against the gateway's with join(","), so the order is the contract.
  "confirm_reminder_sent",
];

// Explicit projections (data minimisation) — copied verbatim from the gateway.
// GV-393: these had drifted to 12 columns while the gateway had grown to 17
// (created_at, paid_claimed_at, last_reminder_at, reminder_count and
// last_confirm_reminder_at were missing), so the rehearsal under-measured the
// settlements payload on every VU iteration. tools/check-hotpath-mirror.mjs now
// compares this string against the gateway's, byte for byte.
export const SETTLEMENT_REQUEST_COLUMNS =
  "id,ledger_id,period_id,from_member_id,to_member_id,amount,currency,status,created_at,requested_at,paid_claimed_at,paid_at,paid_note,dispute_note,last_reminder_at,reminder_count,last_confirm_reminder_at";
export const SETTLEMENT_PERIOD_COLUMNS =
  "id,ledger_id,status,label,opened_at,closed_at,snapshot_json";

function enc(v) {
  return encodeURIComponent(v);
}

// The 12 parallel reads LedgerContext fans out on every workspace load, in the
// same order as ledger-data-gateway.ts's Promise.all. Each entry is
// { label, table, query } where query is the PostgREST query string.
export function ledgerReadRequests(ledgerId) {
  const lid = enc(ledgerId);
  return [
    { label: "read:ledger", table: "ledgers", query: `select=*&id=eq.${lid}&limit=1` },
    {
      label: "read:members",
      table: "ledger_members",
      query: `select=*&ledger_id=eq.${lid}&is_active=eq.true&order=name.asc`,
    },
    {
      label: "read:periods",
      table: "settlement_periods",
      query: `select=${SETTLEMENT_PERIOD_COLUMNS}&ledger_id=eq.${lid}&order=opened_at.desc`,
    },
    {
      label: "read:trips",
      table: "trips",
      query: `select=*&ledger_id=eq.${lid}&deleted_at=is.null&order=trip_date.desc&limit=${SETTLE_ROW_CAP + 1}`,
    },
    {
      label: "read:fuel",
      table: "fuel_payments",
      query: `select=*&ledger_id=eq.${lid}&deleted_at=is.null&order=payment_date.desc&limit=${SETTLE_ROW_CAP + 1}`,
    },
    {
      label: "read:settlements",
      table: "settlement_requests",
      query: `select=${SETTLEMENT_REQUEST_COLUMNS}&ledger_id=eq.${lid}&order=created_at.desc`,
    },
    {
      // Deliberately NO deleted_at filter, matching the gateway (GVM-388):
      // cancelled bookings are soft-deletes and the Historik Bookinger tab lists
      // them, so the real read returns them too. GV-393: this carried
      // `&deleted_at=is.null` and so under-measured the bookings row count.
      label: "read:bookings",
      table: "car_bookings",
      query: `select=*&ledger_id=eq.${lid}&order=start_at.desc`,
    },
    {
      label: "read:events",
      table: "ledger_events",
      query:
        `select=*&ledger_id=eq.${lid}` +
        `&event_type=not.in.(${EVENT_TYPE_EXCLUDE.join(",")})` +
        `&order=created_at.desc&limit=100`,
    },
    {
      label: "read:repairs",
      table: "vehicle_repairs",
      query: `select=*&ledger_id=eq.${lid}&deleted_at=is.null&order=repair_date.desc`,
    },
    {
      label: "read:messages",
      table: "messages",
      query: `select=*&ledger_id=eq.${lid}&deleted_at=is.null&order=created_at.desc&limit=200`,
    },
    {
      label: "read:expenses",
      table: "workspace_expenses",
      query: `select=*&ledger_id=eq.${lid}&deleted_at=is.null&order=expense_date.desc`,
    },
    {
      label: "read:recurring",
      table: "recurring_expenses",
      query: `select=*&ledger_id=eq.${lid}&deleted_at=is.null&order=next_due_date.asc`,
    },
  ];
}

// The dependent 13th read: trip_participants for the loaded trip ids (the gateway
// only runs it when there is at least one trip). Kept separate because it needs
// the trip ids from the trips read.
export function tripParticipantsRequest(tripIds) {
  return {
    label: "read:participants",
    table: "trip_participants",
    query: `select=*&trip_id=in.(${tripIds.map(enc).join(",")})`,
  };
}

// The workspace list the app resolves before any load (resolveActiveLedgerId).
export const WORKSPACE_LIST_RPC = "list_my_ledgers";

// The settlement-balance computation path. SettleScreen computes the split
// client-side from the fan-out reads, but the server exposes the identical math
// via calculate_period_settlement (it is the very function close_settlement_period
// validates the client's snapshot against). Driving it as an authenticated member
// exercises the settlement query path server-side.
export const SETTLEMENT_CALC_RPC = "calculate_period_settlement";

// Write-mix RPCs (mirrors supabase-helpers.ts). These are the hot writes a member
// makes: log a trip, log a fuel payment, post a chat message (the feed write).
export const WRITE_RPCS = {
  trip: "upsert_trip_with_participants",
  fuel: "upsert_fuel_payment",
  message: "post_message",
};
