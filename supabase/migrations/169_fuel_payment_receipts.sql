-- Migration 169: opt-in receipt photos on fuel logs, auto-deleted at settled close (GVM-537)
--
-- A member who tanks the shared car can attach ONE photo of the till receipt to the
-- fuel log. It answers the only question a group ever asks about a fuel amount --
-- "hvad stod der på kvitteringen?" -- and it answers it inside the workspace, where
-- the split is being read, instead of in somebody's camera roll.
--
-- ── TWO OWNER DECISIONS (2026-08-04), both binding and both written into the SQL ──
--
-- (1) STORAGE IS OPT-IN, PER TANKNING. Nothing here uploads anything on its own.
--     There is no "always attach" setting, no workspace-level toggle that turns it on
--     for everybody, and no background capture: a row in public.fuel_payment_receipts
--     exists only because a member chose, for that one fuel log, to attach a photo.
--     A workspace that never taps "vedhæft kvittering" stores nothing at all, and the
--     fuel log itself is complete without one -- the receipt is documentation ON TOP
--     of the amount, never the source of it.
--
-- (2) RETENTION = AUTO-DELETE AT SETTLED CLOSE. The documentation need dies with the
--     settlement. A receipt exists so the group can check an amount while the money
--     is still moving; once the period that fuel log belongs to is CLOSED and its
--     payment cycle is FINISHED, nobody will ever ask again, and a photo of a till
--     receipt (time, place, card tail, sometimes a loyalty number) is not something to
--     keep "just in case". So the daily retention sweep deletes it. This is the first
--     data class on the platform with an EVENT-based retention rule rather than an
--     age-based one, and that is deliberate: an age would either outlive the need or
--     cut into a live settlement, while the settlement itself is the exact signal.
--
-- ── What "settled close" means, precisely (the predicate is in ONE place below) ────
-- A receipt is purgeable when its fuel payment's settlement period is 'closed' AND no
-- settlement_request for that period is in any state other than 'paid' or 'cancelled'.
-- Read it as "the payment cycle has nothing left in flight":
--   • 'open' / 'requested'   — money is still owed or awaiting payment  → KEEP.
--   • 'paid_pending'         — the debtor CLAIMED payment and the creditor has not
--                              confirmed; migration 090 lets the creditor dispute it
--                              straight back to 'requested'. The mobile close-nudge
--                              (src/lib/close-nudge.ts) counts paid_pending as settled
--                              optimistically, which is right for a NUDGE and wrong
--                              for an IRREVERSIBLE DELETE — the receipt is precisely
--                              what a disputed claim gets argued with. → KEEP.
--   • 'cancelled'            — withdrawn, never counted (same rule the close-nudge
--                              uses when it filters the active set) → ignored.
--   • no requests at all     — a closed period where nobody owed anybody ("I er kvit")
--                              has no cycle left to finish → PURGE.
-- A fuel log with no period_id (never bound to a period) is never purgeable: the join
-- yields nothing, so the row is kept.
--
-- ── Photos, storage and who deletes what (copied from migration 138, GVM-396) ─────
-- Same shape as incident photos, deliberately, down to the path convention:
-- <ledger_id>/<fuel_payment_id>/<uuid>.<ext> in a PRIVATE bucket. The receipt ROW is
-- registered through attach_fuel_payment_receipt / detach_fuel_payment_receipt, so the
-- database is the authority on who may attach or detach; the storage.objects policies
-- (mirroring migration 139's hardened final shape) are defense-in-depth on top.
--
-- 138's storage-object COORDINATION is copied exactly, and it is worth stating because
-- it decides three things below. In 138 the storage OBJECT is deleted by the CLIENT
-- through the Storage API; the SQL only owns the row and the authorization. So here:
--   • detach returns the storage_path it removed, and REPLACE returns the path it
--     superseded as 'replaced_storage_path', because the caller is the half of the
--     transaction that has to delete the object. A replace that only rewrote the row
--     would leave the old object sitting in the bucket, readable by every member.
--   • the retention sweep is the ONE place that cannot follow that rule -- a nightly
--     cron has no client -- so it deletes the storage.objects rows itself, inside the
--     plain-Postgres guard, which is what makes the object unreachable through the
--     Storage API for every caller. See the note at the sweep itself.
--
-- ── STORAGE COMPATIBILITY -- READ BEFORE EDITING (the migration-138 lesson) ───────
-- The `storage` schema only exists in a real Supabase project. The CI guards
-- (schema-equivalence replay, role matrix, db-types) run in a PLAIN Postgres container
-- with NO storage schema. So EVERY storage statement below (the bucket row, the
-- storage.objects policies, and the sweep's object delete) is wrapped in a
-- `if exists (select 1 from information_schema.schemata where schema_name = 'storage')`
-- guard: in plain Postgres the guard is false and nothing storage-related runs (both
-- replays stay identical and pass); in prod the guard is true and the real bucket +
-- policies are created. The storage half therefore ONLY takes effect when this SQL is
-- applied in the real Supabase SQL Editor.
--
-- ── Ancestry (the GV-202 rule) ────────────────────────────────────────────────────
-- public.run_operational_retention below is migration 165's body VERBATIM -- 165 is its
-- NEWEST prior definition (130 → 131 → 132 → 141 → 147 → 149 → 165) -- with exactly one
-- sweep added to both halves of the dry-run split, one counter, and one jsonb key.
-- Signature unchanged, so create-or-replace suffices and no caller is stranded.
--
-- ── No new event_type, deliberately ───────────────────────────────────────────────
-- Attaching a receipt writes NO ledger_events row. The mobile Activity feed renders
-- whatever the database writes (GV-413), and "Bo vedhæftede en kvittering" is noise
-- attached to a fuel log the feed already announced. The fuel entry is the news; the
-- receipt is an attribute of it. Nothing here needs classifying in
-- FEED_VISIBLE_EVENT_TYPES or EVENT_TYPE_EXCLUDE.
--
-- ── GDPR ──────────────────────────────────────────────────────────────────────────
-- A till receipt is personal data about the person who paid (time, place, often the
-- last four digits of a card). Data minimisation is served by all three legs of this
-- design: it is OPT-IN (decision 1), it is ONE photo per tankning that a REPLACE
-- overwrites rather than accumulates, and it AUTO-DELETES at settled close (decision
-- 2) -- the only class on the platform that deletes itself while its workspace is
-- still alive. It stays in the EU (Supabase EU private bucket), never appears in a
-- URL, a query string or a log line, and no signed URL is minted here. Account
-- deletion needs NO new step: uploader_member_id points at the member row, which
-- delete_my_account anonymises IN PLACE (name -> 'Slettet medlem', email -> null),
-- exactly like fuel_payments.payer_member_id and trips.driver_member_id, so no
-- attribution PII survives it. This deviates from migration 138, which additionally
-- NULLS vehicle_incident_photos.created_by_member_id, and the difference is deliberate:
-- an incident photo outlives every settlement and can sit in a workspace for years, so
-- detaching authorship is the only bound on it, whereas a receipt is bounded by
-- decision 2 and its authorship is the same pointer the fuel log itself already keeps.
-- Re-declaring delete_my_account (a ~290-line function) to null a pointer that
-- anonymisation already covers is blast radius bought for nothing.

-- ── 1. Receipt table ─────────────────────────────────────────────────────────
-- ONE receipt per tankning: fuel_payment_id is UNIQUE, so a second attach REPLACES
-- the row rather than adding a second (the one-row semantics booking_handovers uses).
-- ledger_id is denormalized for RLS, exactly as migration 138 scopes incident photos:
-- the policy must answer "may this caller read this row?" without joining out to
-- fuel_payments, and the workspace is the security boundary everywhere else too.
create table if not exists public.fuel_payment_receipts (
  id uuid primary key default gen_random_uuid(),
  fuel_payment_id uuid not null unique references public.fuel_payments(id) on delete cascade,
  ledger_id text not null references public.ledgers(id) on delete cascade,
  storage_path text not null unique,
  uploader_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists fuel_payment_receipts_ledger_idx
  on public.fuel_payment_receipts (ledger_id, created_at, id);

alter table public.fuel_payment_receipts enable row level security;

drop policy if exists "Ledger members can read fuel payment receipts"
  on public.fuel_payment_receipts;
create policy "Ledger members can read fuel payment receipts"
  on public.fuel_payment_receipts
  for select
  using (public.is_ledger_member(ledger_id));

-- Reads for workspace members only; inserts/updates/deletes go through the RPCs
-- below (the 166/167 posture: no write grant exists for any client role).
revoke all on table public.fuel_payment_receipts from public;
revoke all on table public.fuel_payment_receipts from anon;
revoke all on table public.fuel_payment_receipts from authenticated;
revoke all on table public.fuel_payment_receipts from service_role;
grant select on table public.fuel_payment_receipts to authenticated;
grant select on table public.fuel_payment_receipts to service_role;

-- ── 2. Write RPCs ────────────────────────────────────────────────────────────
-- Register a receipt against a fuel log. Any workspace member may attach one to a
-- fuel log in their OWN workspace (the same gate migration 138 uses for incident
-- photos -- the group shares the car and the bill). The storage_path MUST live under
-- the fuel log's own <ledger_id>/<fuel_payment_id>/ prefix, so a member cannot
-- register a row that points at another workspace's or another tankning's object.
--
-- REPLACE semantics: fuel_payment_id is unique, so attaching to a fuel log that
-- already has a receipt overwrites the row. Overwriting DESTROYS somebody else's
-- attachment, so that path carries the same gate as detach -- uploader or workspace
-- admin -- while a FIRST attach stays open to any member. The superseded path comes
-- back as 'replaced_storage_path' because deleting the storage OBJECT is the caller's
-- half of the contract (migration 138's coordination, unchanged).
create or replace function public.attach_fuel_payment_receipt(
  p_fuel_payment_id uuid,
  p_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.fuel_payments%rowtype;
  v_existing public.fuel_payment_receipts%rowtype;
  v_actor_member_id uuid;
  v_expected_prefix text;
  v_receipt_id uuid;
begin
  if p_fuel_payment_id is null then
    raise exception 'Missing fuel payment id' using errcode = '22023';
  end if;

  if nullif(btrim(p_storage_path), '') is null then
    raise exception 'Missing storage path' using errcode = '22023';
  end if;

  select * into v_payment
  from public.fuel_payments fp
  where fp.id = p_fuel_payment_id;

  if v_payment.id is null then
    raise exception 'Fuel log was not found' using errcode = '22023';
  end if;

  if v_payment.deleted_at is not null then
    raise exception 'This fuel log has been deleted' using errcode = '22023';
  end if;

  if not public.is_ledger_member(v_payment.ledger_id) then
    raise exception 'Only ledger members can attach fuel receipts' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_payment.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Path convention: <ledger_id>/<fuel_payment_id>/<uuid>.<ext>. Compare the literal
  -- prefix (no LIKE -- ledger ids can contain '_', a LIKE wildcard).
  v_expected_prefix := v_payment.ledger_id || '/' || p_fuel_payment_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) <> v_expected_prefix then
    raise exception 'Storage path must live under the fuel log''s workspace/payment prefix' using errcode = '22023';
  end if;

  select * into v_existing
  from public.fuel_payment_receipts fpr
  where fpr.fuel_payment_id = p_fuel_payment_id;

  if v_existing.id is not null and not (
    public.is_ledger_admin(v_payment.ledger_id)
    or coalesce(v_existing.uploader_member_id = v_actor_member_id, false)
  ) then
    raise exception 'Only the receipt uploader or a workspace admin can replace this receipt' using errcode = '42501';
  end if;

  insert into public.fuel_payment_receipts (
    fuel_payment_id, ledger_id, storage_path, uploader_member_id
  ) values (
    p_fuel_payment_id, v_payment.ledger_id, p_storage_path, v_actor_member_id
  )
  on conflict (fuel_payment_id) do update
  set storage_path = excluded.storage_path,
      uploader_member_id = excluded.uploader_member_id,
      created_at = now()
  returning id into v_receipt_id;

  return jsonb_build_object(
    'receipt_id', v_receipt_id,
    'fuel_payment_id', p_fuel_payment_id,
    'ledger_id', v_payment.ledger_id,
    'replaced', v_existing.id is not null,
    'replaced_storage_path',
      case
        when v_existing.id is not null and v_existing.storage_path <> p_storage_path
          then v_existing.storage_path
        else null
      end
  );
end;
$$;

revoke all on function public.attach_fuel_payment_receipt(uuid, text) from public;
revoke all on function public.attach_fuel_payment_receipt(uuid, text) from anon;
grant execute on function public.attach_fuel_payment_receipt(uuid, text) to authenticated;

-- Detach a registered receipt. Only a workspace admin or the member who uploaded it
-- may detach it -- migration 138's delete_incident_photo gate, verbatim in spirit.
-- The storage object itself is cleaned up by the client (and the storage.objects
-- delete policy gates that to the owner or a workspace admin); THIS row is the
-- authority on who may detach, and the removed path is returned so the caller knows
-- which object to delete.
create or replace function public.detach_fuel_payment_receipt(
  p_receipt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt public.fuel_payment_receipts%rowtype;
  v_actor_member_id uuid;
begin
  if p_receipt_id is null then
    raise exception 'Missing receipt id' using errcode = '22023';
  end if;

  select * into v_receipt
  from public.fuel_payment_receipts fpr
  where fpr.id = p_receipt_id;

  if v_receipt.id is null then
    raise exception 'Fuel receipt was not found' using errcode = '22023';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_receipt.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Only ledger members can detach fuel receipts' using errcode = '42501';
  end if;

  if not (
    public.is_ledger_admin(v_receipt.ledger_id)
    or coalesce(v_receipt.uploader_member_id = v_actor_member_id, false)
  ) then
    raise exception 'Only the receipt uploader or a workspace admin can detach this receipt' using errcode = '42501';
  end if;

  delete from public.fuel_payment_receipts fpr where fpr.id = p_receipt_id;

  return jsonb_build_object(
    'receipt_id', p_receipt_id,
    'fuel_payment_id', v_receipt.fuel_payment_id,
    'ledger_id', v_receipt.ledger_id,
    'storage_path', v_receipt.storage_path
  );
end;
$$;

revoke all on function public.detach_fuel_payment_receipt(uuid) from public;
revoke all on function public.detach_fuel_payment_receipt(uuid) from anon;
grant execute on function public.detach_fuel_payment_receipt(uuid) to authenticated;

-- ── 3. Supabase Storage (PROD-ONLY; see the STORAGE COMPATIBILITY note above) ──
-- Guarded on the `storage` schema existing so plain-Postgres CI replays skip it
-- entirely and only the real Supabase project materialises the private bucket +
-- workspace-scoped object policies. The policies are migration 139's HARDENED shape
-- rather than 138's original one: uploads are bound to a real fuel log in the same
-- ledger, and direct deletes to the object's owner or a workspace admin.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    -- Private bucket, 5 MiB cap, images only (same limits as incident-photos).
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'fuel-receipts', 'fuel-receipts', false, 5242880,
      array['image/jpeg', 'image/png', 'image/webp']
    )
    on conflict (id) do update set
      public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

    -- Workspace-scoped read: the first path segment is the ledger id
    -- (<ledger_id>/<fuel_payment_id>/<uuid>.<ext>), gated through is_ledger_member.
    drop policy if exists "Fuel receipts are readable by workspace members" on storage.objects;
    create policy "Fuel receipts are readable by workspace members"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'fuel-receipts'
        and public.is_ledger_member((storage.foldername(name))[1])
      );

    -- Uploads must land under an EXISTING fuel log in the caller's own workspace, so
    -- the bucket cannot be used as free storage below a ledger prefix (GV-348's
    -- lesson, applied here from day one instead of in a follow-up migration).
    drop policy if exists "Fuel receipts are writable by workspace members" on storage.objects;
    create policy "Fuel receipts are writable by workspace members"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'fuel-receipts'
        and cardinality(storage.foldername(name)) = 2
        and public.is_ledger_member((storage.foldername(name))[1])
        and exists (
          select 1
          from public.fuel_payments fp
          where fp.ledger_id = (storage.foldername(name))[1]
            and fp.id::text = (storage.foldername(name))[2]
        )
      );

    -- Uploader-or-admin delete, matching detach_fuel_payment_receipt's own gate. The
    -- uploader identity lives in public.fuel_payment_receipts, so the object policy
    -- uses storage's own owner_id as the equivalent signal (migration 139's shape).
    drop policy if exists "Fuel receipts are deletable by workspace members" on storage.objects;
    create policy "Fuel receipts are deletable by workspace members"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'fuel-receipts'
        and public.is_ledger_member((storage.foldername(name))[1])
        and (
          owner_id::text = auth.uid()::text
          or public.is_ledger_admin((storage.foldername(name))[1])
        )
      );
  end if;
end
$$;

-- ── 4. Retention: the sweep that makes decision (2) real ──────────────────────
-- run_operational_retention re-declared off migration 165 (its newest prior
-- definition — the GV-202 rule), byte-identical apart from the receipt sweep in both
-- halves of the dry-run split, its counter, and the purgedFuelReceipts key. The daily
-- retention cron (migration 130's /api/hooks/retention-cleanup, RETENTION_CLEANUP_KEY,
-- 03:30 UTC) is what runs it, so "auto-deleted at settled close" means "deleted on the
-- first nightly sweep after the settlement finished" — which is the same enforcement
-- promise every other automatic class on this platform makes.
create or replace function public.run_operational_retention(
  p_stale_push_days integer default 180,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stale_tokens integer := 0;
  v_expired_events integer := 0;
  v_deleted_messages integer := 0;
  v_deleted_bookings integer := 0;
  v_deleted_recurring_templates integer := 0;
  v_deleted_trips integer := 0;
  v_deleted_fuel_payments integer := 0;
  v_deleted_workspace_expenses integer := 0;
  v_deleted_vehicle_repairs integer := 0;
  v_deleted_owner_activity integer := 0;
  v_purged_workspaces integer := 0;
  v_deleted_rate_limit_counters integer := 0;
  v_purged_newsletter_pending integer := 0;
  v_purged_fuel_receipts integer := 0;
  v_purged_receipt_paths text[] := '{}';
  v_short_cutoff timestamptz := now() - interval '90 days';
  v_financial_cutoff timestamptz := date_trunc('year', now()) - interval '5 years';
  v_audit_cutoff timestamptz := now() - interval '24 months';
  v_workspace_cutoff timestamptz := now() - interval '90 days';
  -- GV-385: throttle counters are working state, not history. The longest window any
  -- caller configures is a day, and the two admin readers (owner/ocr-telemetry and
  -- owner/external-usage) both look back 7 days, so 30 days is already generous.
  v_rate_limit_cutoff timestamptz := now() - interval '30 days';
  -- GV-433: the double-opt-in window /nyhedsbrev and /privatliv promise. 168 hours =
  -- PENDING_TTL_HOURS in the web Functions and the interval migration 161's confirm
  -- refuses past — three copies of one number, each pinned by its own guard.
  v_newsletter_pending_cutoff timestamptz := now() - interval '168 hours';
begin
  if p_stale_push_days is null or p_stale_push_days < 30 or p_stale_push_days > 3650 then
    raise exception 'p_stale_push_days must be between 30 and 3650' using errcode = '22023';
  end if;
  if p_dry_run is null then
    raise exception 'p_dry_run must not be null' using errcode = '22023';
  end if;

  if p_dry_run then
    select count(*) into v_stale_tokens from public.expo_push_tokens
    where updated_at < now() - make_interval(days => p_stale_push_days);
    select count(*) into v_expired_events from public.ledger_events
    where expires_at is not null and expires_at < now();
    select count(*) into v_deleted_messages from public.messages where deleted_at < v_short_cutoff;
    select count(*) into v_deleted_bookings from public.car_bookings where deleted_at < v_short_cutoff;
    select count(*) into v_deleted_recurring_templates from public.recurring_expenses where deleted_at < v_short_cutoff;
    select count(*) into v_deleted_trips from public.trips where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_fuel_payments from public.fuel_payments where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_workspace_expenses from public.workspace_expenses where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_vehicle_repairs from public.vehicle_repairs where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_owner_activity from public.owner_activity_log where created_at < v_audit_cutoff;
    select count(*) into v_deleted_rate_limit_counters from public.owner_api_rate_limits where window_started_at < v_rate_limit_cutoff;
    select count(*) into v_purged_newsletter_pending from public.newsletter_subscribers
    where confirmed_at is null and requested_at < v_newsletter_pending_cutoff;
    -- GVM-537: same predicate as the real half below, so the dry run a human reads in
    -- the SQL editor reports exactly what the cron would destroy tonight.
    select count(*) into v_purged_fuel_receipts from public.fuel_payment_receipts fpr
    where exists (
      select 1
      from public.fuel_payments fp
      join public.settlement_periods sp on sp.id = fp.period_id
      where fp.id = fpr.fuel_payment_id
        and sp.status = 'closed'
        and not exists (
          select 1
          from public.settlement_requests sr
          where sr.period_id = sp.id
            and sr.status not in ('paid', 'cancelled')
        )
    );
    select count(*) into v_purged_workspaces from public.ledgers where deleted_at < v_workspace_cutoff;
  else
    with purged as (delete from public.expo_push_tokens where updated_at < now() - make_interval(days => p_stale_push_days) returning 1)
      select count(*) into v_stale_tokens from purged;
    with purged as (delete from public.ledger_events where expires_at is not null and expires_at < now() returning 1)
      select count(*) into v_expired_events from purged;
    with purged as (delete from public.messages where deleted_at < v_short_cutoff returning 1)
      select count(*) into v_deleted_messages from purged;
    with purged as (delete from public.car_bookings where deleted_at < v_short_cutoff returning 1)
      select count(*) into v_deleted_bookings from purged;
    with purged as (delete from public.recurring_expenses where deleted_at < v_short_cutoff returning 1)
      select count(*) into v_deleted_recurring_templates from purged;

    -- GVM-537: opt-in receipt photos die with the settlement they documented. Period
    -- 'closed' AND nothing in flight (no settlement_request outside paid/cancelled);
    -- a paid_pending claim is NOT settled here, because the creditor can still dispute
    -- it back to 'requested' and the receipt is what that argument needs. Placed ahead
    -- of the fuel_payments tombstone purge so this sweep sees, counts and deletes the
    -- objects of every receipt it is responsible for before any cascade can remove the
    -- rows silently, and its paths are collected for the storage delete that follows.
    with purged as (
      delete from public.fuel_payment_receipts fpr
      where exists (
        select 1
        from public.fuel_payments fp
        join public.settlement_periods sp on sp.id = fp.period_id
        where fp.id = fpr.fuel_payment_id
          and sp.status = 'closed'
          and not exists (
            select 1
            from public.settlement_requests sr
            where sr.period_id = sp.id
              and sr.status not in ('paid', 'cancelled')
          )
      )
      returning fpr.storage_path
    )
    select count(*), coalesce(array_agg(storage_path), '{}'::text[])
      into v_purged_fuel_receipts, v_purged_receipt_paths
      from purged;

    -- The ONE place the platform deletes a storage object from SQL. Everywhere else
    -- (migration 138/139 and the detach RPC above) the client owns that half, but a
    -- nightly cron has no client, and a receipt row deleted while its object survives
    -- would leave the photo readable to every workspace member — the opposite of the
    -- promise. Dynamic EXECUTE inside the storage-schema guard so a plain-Postgres
    -- replay never even parses a reference to storage.objects.
    --
    -- Honest limitation, not solved here and not new: a CASCADE (a workspace purge, or
    -- the fuel_payments tombstone purge below removing a receipt's parent) still drops
    -- receipt ROWS without anyone deleting their objects — exactly the condition
    -- incident photos have lived with since migration 138. Documented in
    -- docs/gdpr/deletion-limitations.md; a Storage-API cleanup pass in the retention
    -- hook is the fix, and it belongs in govehlo-web, not in this migration.
    if v_purged_fuel_receipts > 0
       and exists (select 1 from information_schema.schemata where schema_name = 'storage') then
      execute 'delete from storage.objects where bucket_id = ''fuel-receipts'' and name = any($1)'
        using v_purged_receipt_paths;
    end if;

    -- Closed-period entry triggers deliberately freeze accounting history. The
    -- account-deletion path already uses this transaction-local gate for GDPR
    -- scrubs; enable it only inside this service-role-only function and only
    -- around tombstones that have outlived the accounting retention window.
    perform set_config('govehlo.pii_scrub', '1', true);
    with purged as (delete from public.trips where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_trips from purged;
    with purged as (delete from public.fuel_payments where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_fuel_payments from purged;
    with purged as (delete from public.workspace_expenses where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_workspace_expenses from purged;
    with purged as (delete from public.vehicle_repairs where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_vehicle_repairs from purged;

    -- GV-316: purge workspaces whose operator decommission tombstone has
    -- outlived the 90-day grace window. On delete cascade removes every child
    -- row; the closed-period locks stand aside for a whole-workspace teardown
    -- (settlement_periods delete first). Kept inside the pii_scrub gate for
    -- parity with the financial-row purges above.
    with purged as (delete from public.ledgers where deleted_at < v_workspace_cutoff returning 1)
      select count(*) into v_purged_workspaces from purged;
    perform set_config('govehlo.pii_scrub', '', true);
    with purged as (delete from public.owner_activity_log where created_at < v_audit_cutoff returning 1)
      select count(*) into v_deleted_owner_activity from purged;
    with purged as (delete from public.owner_api_rate_limits where window_started_at < v_rate_limit_cutoff returning 1)
      select count(*) into v_deleted_rate_limit_counters from purged;
    -- GV-433: migration 161 swept expired pending signups only inside
    -- newsletter_request_subscription — opportunistic, so with no new signups an
    -- abandoned address sat forever while the privacy page promised seven days. Its
    -- tracker text already named this line as the right move. Confirmed rows are
    -- NEVER touched here: they leave only by unsubscribe (hard delete, migration 161).
    with purged as (delete from public.newsletter_subscribers
      where confirmed_at is null and requested_at < v_newsletter_pending_cutoff returning 1)
      select count(*) into v_purged_newsletter_pending from purged;
  end if;

  return jsonb_build_object(
    'staleExpoPushTokens', v_stale_tokens,
    'expiredLedgerEvents', v_expired_events,
    'deletedMessages', v_deleted_messages,
    'deletedBookings', v_deleted_bookings,
    'deletedRecurringTemplates', v_deleted_recurring_templates,
    'deletedTrips', v_deleted_trips,
    'deletedFuelPayments', v_deleted_fuel_payments,
    'deletedWorkspaceExpenses', v_deleted_workspace_expenses,
    'deletedVehicleRepairs', v_deleted_vehicle_repairs,
    'deletedOwnerActivity', v_deleted_owner_activity,
    'purgedWorkspaces', v_purged_workspaces,
    'deletedRateLimitCounters', v_deleted_rate_limit_counters,
    'purgedNewsletterPending', v_purged_newsletter_pending,
    'purgedFuelReceipts', v_purged_fuel_receipts,
    'dryRun', p_dry_run,
    'staleDays', p_stale_push_days,
    'shortRetentionDays', 90,
    'financialRetentionYears', 5,
    'auditRetentionMonths', 24,
    'workspaceGraceDays', 90,
    'rateLimitRetentionDays', 30,
    'newsletterPendingTtlHours', 168,
    'fuelReceiptRetentionRule', 'closed_and_fully_paid',
    'ranAt', now()
  );
end;
$$;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '169_fuel_payment_receipts',
  'Opt-in receipt photos on fuel logs, auto-deleted at settled close (GVM-537, platform half). TWO OWNER DECISIONS OF 2026-08-04, both binding and both written into the SQL rather than left to the client. (1) STORAGE IS OPT-IN PER TANKNING: nothing uploads on its own, there is no workspace-level "always attach" toggle and no background capture — a public.fuel_payment_receipts row exists only because a member chose, for that one fuel log, to attach a photo, and a workspace that never taps "vedhæft kvittering" stores nothing at all. (2) RETENTION IS AUTO-DELETE AT SETTLED CLOSE: the documentation need dies with the settlement, so the daily retention sweep destroys the receipt once the period its fuel log belongs to is closed and its payment cycle is finished. This is the platform''s FIRST event-based retention rule (every other automatic class is age-based) and the only class that deletes itself while its workspace is still alive — deliberate, because an age would either outlive the need or cut into a live settlement while the settlement itself is the exact signal. New table public.fuel_payment_receipts: id, fuel_payment_id (NOT NULL UNIQUE, references fuel_payments on delete cascade — ONE receipt per tankning, so a second attach REPLACES rather than accumulates, the same one-row semantics booking_handovers uses), ledger_id (denormalized for RLS exactly as migration 138 scopes incident photos, so the policy answers "may this caller read this row?" without joining out), storage_path (unique), uploader_member_id (references ledger_members on delete set null), created_at. RLS: one policy, workspace members read via is_ledger_member; every write grant is revoked from public/anon/authenticated/service_role and only select is granted back (the 166/167 posture), so the two SECURITY DEFINER RPCs are the only writers. attach_fuel_payment_receipt(uuid, text) is migration 138''s add_incident_photo contract applied to a fuel log: any workspace member may attach to a fuel log in their OWN workspace, the payment must exist and not be soft-deleted, the actor is resolved with current_ledger_member_id (never trusted from a param), and the storage_path must live under the literal <ledger_id>/<fuel_payment_id>/ prefix (compared with left(), not LIKE — ledger ids can contain the ''_'' wildcard). Because the unique constraint makes a second attach DESTROY somebody else''s attachment, the REPLACE path carries the detach gate — uploader or workspace admin — while a first attach stays open to any member; the superseded path is returned as replaced_storage_path so the caller can delete the orphaned object. detach_fuel_payment_receipt(uuid) is delete_incident_photo''s gate verbatim in spirit (uploader or workspace admin, 42501 otherwise) and returns the removed storage_path. STORAGE COORDINATION IS COPIED FROM MIGRATION 138 UNCHANGED: the storage OBJECT is deleted by the CLIENT through the Storage API and the SQL owns only the row plus the authorization — which is why both RPCs hand the caller the path it must delete. Private bucket fuel-receipts (5 MiB, image/jpeg|png|webp) plus three storage.objects policies in migration 139''s HARDENED shape from day one instead of a follow-up: member read below the ledger prefix, insert bound to cardinality 2 AND an existing fuel_payments row in that ledger, delete gated to owner_id = auth.uid() or is_ledger_admin. Every storage statement is wrapped in the `if exists (information_schema.schemata where schema_name = ''storage'')` guard, so plain-Postgres CI replays (schema equivalence, role matrix, db-types) skip the storage half entirely and it materialises ONLY when this SQL is applied in the real Supabase SQL editor — the migration-138 lesson. run_operational_retention is re-declared off its NEWEST prior definition, migration 165 (chain 130 → 131 → 132 → 141 → 147 → 149 → 165 — the GV-202 rule), byte-identical apart from one sweep added to BOTH halves of the dry-run split, its counter, and two returned keys. The purge predicate, stated once and identically in both halves: delete a receipt when its fuel payment''s settlement period has status ''closed'' AND no settlement_request for that period sits in any status other than ''paid'' or ''cancelled''. Read as "nothing left in flight" — open/requested keep the receipt because money is still owed; CANCELLED is ignored, the same way the mobile close-nudge filters the active set; a closed period with no requests at all ("I er kvit") is purgeable because there is no cycle left to finish; and a fuel log with no period_id is never purgeable because the join yields nothing. PAID_PENDING DELIBERATELY DOES NOT COUNT AS SETTLED: src/lib/close-nudge.ts treats a paid_pending claim as settled optimistically, which is right for a nudge and wrong for an irreversible delete — migration 090 lets the creditor dispute the claim straight back to ''requested'', and the receipt is exactly what that argument needs. The sweep deletes the matching storage.objects rows itself — the one place on the platform where SQL deletes a storage object — because a nightly cron has no client to run 138''s coordination, and a receipt row deleted while its object survived would leave the photo readable to every workspace member. That delete uses dynamic EXECUTE inside the storage-schema guard so a plain-Postgres replay never parses a reference to storage.objects, and it runs before the fuel_payments tombstone purge so a receipt is never orphaned by its own parent''s cascade mid-sweep. Both halves report the count as purgedFuelReceipts, alongside the new constant fuelReceiptRetentionRule = closed_and_fully_paid, so the dry run a human runs in the SQL editor states exactly what tonight''s cron would destroy. NO NEW event_type: attaching a receipt writes no ledger_events row, because the feed already announced the fuel entry and the receipt is an attribute of it, not news — so nothing needs classifying in FEED_VISIBLE_EVENT_TYPES or EVENT_TYPE_EXCLUDE (GV-413). NO CHANGE TO delete_my_account, and that is a deliberate deviation from migration 138 rather than an omission: uploader_member_id points at the member row that delete_my_account anonymises IN PLACE (name -> ''Slettet medlem'', email -> null), exactly like fuel_payments.payer_member_id and trips.driver_member_id, so no attribution PII survives account deletion; 138 additionally NULLS vehicle_incident_photos.created_by_member_id because an incident photo outlives every settlement and detaching authorship is its only bound, whereas a receipt is bounded by decision (2) — re-declaring a ~290-line function to null a pointer anonymisation already covers is blast radius bought for nothing. GDPR: a till receipt is personal data about the payer (time, place, often a card tail), and all three legs of the design serve minimisation — opt-in, one photo per tankning that a replace overwrites rather than accumulates, and automatic deletion at settled close. Processing stays in the EU (Supabase EU private bucket); no path or signed URL ever goes in a URL, a query string or a log line. Recorded in docs/gdpr/ropa.md (A2), docs/gdpr/retention.md and docs/gdpr/deletion-limitations.md. Guarded by tools/test-fuel-receipt-retention-contract.mjs (Docker: proves an OPEN period keeps its receipt, a CLOSED-but-unpaid period keeps it, a closed period with a paid_pending claim keeps it, and a closed-and-paid period loses it) and by role-matrix cases for attach/replace/detach, cross-ledger rejection and direct table writes. MERGE ORDER: PostgREST answers PGRST202 for a function that does not exist, so this SQL must be applied in production BEFORE govehlo-mobile''s GVM-537 half ships.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
