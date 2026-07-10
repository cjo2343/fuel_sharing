-- Migration 103: settlement/join-code/bootstrap/identity security hardening (GV-244, GV-245, GV-246, GV-247)
--
-- Four findings from the 2026-07-09 schema review, re-verified against code on
-- 2026-07-10. All decisions recorded on GV-244..GV-247.
--
-- GV-244 — upsert_settlement_request_status: party-or-admin gate.
--   Today any ledger MEMBER can call this SECURITY DEFINER RPC to create or
--   transition a settlement request between two OTHER members (including marking
--   it paid). The settlement_requests table RLS is already party-or-admin, so
--   this is purely an RPC bypass. Re-declared off migration 090 (newest prior
--   definition) verbatim, with ONE added guard right after the actor-null check:
--   the actor must be the payer, the recipient, or a ledger admin. All real
--   mobile flows already act as a party (creditor requests, debtor pays/marks
--   paid, reopen is a party); GVM-213 confirm/dispute and the auto-confirm
--   scheduler use separate RPCs and are untouched.
--
-- GV-245 — workspace join codes lengthened 4 -> 6 char body.
--   The body was 4 chars from a 32-symbol alphabet (~1.05M) and rate limiting is
--   per-actor-email only, so disposable accounts allow slow global enumeration.
--   generate_workspace_join_code() is re-declared off migration 045 (newest) with
--   gen_random_bytes(6) and six substr picks (32^6 ~= 1.07 billion). Prefix,
--   alphabet, uniqueness loop and tries cap are unchanged. No global counter /
--   auto-rotate (fail-closed DoS risk; failed guesses can't be attributed to a
--   ledger row anyway). A data-only statement regenerates every existing code.
--
-- GV-246 — remove the is_ledger_bootstrap_open trapdoor.
--   The function (002, re-declared 020) returns true for any signed-in user
--   against a ledger with member rows, no active-admin email, and
--   bootstrap_locked_at null — a latent claim-any-unclaimed-ledger path. It is
--   unreachable in the workspace era (042's create_private_ledger_workspace locks
--   in the same transaction), but it is still a live RLS disjunct. Its only
--   references are the 8 policies from migration 005 (re-verified: nothing
--   re-declared them since; 099 only touched settlement_periods / ledger_events):
--   three pure-bootstrap policies are dropped outright and five are re-created
--   without the `or public.is_ledger_bootstrap_open(...)` disjunct (rest of each
--   policy byte-preserved), then the function itself is dropped. The
--   lock_ledger_bootstrap_when_admin_email_attached trigger and the
--   bootstrap_locked_at column are KEPT — they do not depend on the dropped
--   function, and removing them would be churn, not security.
--
-- GV-247 — identity parties must be active members.
--   member_belongs_to_ledger is deliberately NOT touched (it would re-validate
--   historical rows on unrelated edits). Instead enforce_identity_reassignment()
--   (newest definition: migration 101) is extended so the identity-bearing member
--   column (trips.driver_member_id / fuel_payments.payer_member_id /
--   car_bookings.member_id) must reference an ACTIVE member of the row's ledger:
--   on INSERT unconditionally (no admin/creator check — that is the update-only
--   rule), and on UPDATE additionally whenever the identity actually changes (on
--   top of 101's admin-or-creator permission gate). The three triggers are
--   recreated as `before insert or update` (101's names kept). workspace_expenses
--   is already covered by migration 077; settlement_requests is deliberately
--   excluded (a member who left still owing money must remain requestable —
--   GV-244's party-or-admin gate covers abuse there).
--
-- Trade-offs (accepted, also in the PR):
--   1. GV-245: every old printed/shared join code and old join deep link stops
--      resolving at SQL-apply time. Accepted — pre-launch, one real workspace,
--      the new code is visible in-app.
--   2. GV-247: backfilling an old entry for a since-removed member now requires
--      temporarily reactivating them. Chosen over allowing removed members as
--      live financial parties on new entries.

-- ── GV-244: upsert_settlement_request_status — party-or-admin only ──────────
-- Re-declared off migration 090 (newest prior definition), full body, with only
-- the party-or-admin guard added immediately after the actor-null check.
create or replace function public.upsert_settlement_request_status(
  target_ledger_id text,
  target_open_period_id uuid,
  payer_member_id uuid,
  recipient_member_id uuid,
  amount_value numeric,
  currency_value text,
  next_status text,
  current_pair_keys text[] default array[]::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  saved_request_id uuid;
  prev_status_value text := null;
  requested_at_value timestamptz := null;
  requested_by_value uuid := null;
  paid_at_value timestamptz := null;
  cancelled_count integer := 0;
  normalized_status text := coalesce(nullif(next_status, ''), 'open');
  event_type_value text;
  event_title_value text;
  period_is_open boolean;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save settlement requests' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- GV-244: a settlement request may only be created or transitioned by one of
  -- its two parties or a ledger admin. Without this any signed-in member could
  -- drive a request between two OTHER members (incl. marking it paid) through
  -- this SECURITY DEFINER RPC, bypassing the party-or-admin table RLS.
  if actor_member_id not in (payer_member_id, recipient_member_id)
    and not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only the payer, recipient, or a ledger admin can save this settlement request' using errcode = '42501';
  end if;

  -- Resolve the target period. Normally OPEN (request + pay on the live period).
  -- For a debt carried past a close, mobile acts on the request in its own CLOSED
  -- period (GVM-243): mark paid / remind / reopen are allowed there, but only
  -- against an existing request (guarded below). A missing/foreign period is
  -- rejected outright.
  select (sp.status = 'open' and sp.closed_at is null)
    into period_is_open
  from public.settlement_periods sp
  where sp.id = target_open_period_id
    and sp.ledger_id = target_ledger_id;

  if period_is_open is null then
    raise exception 'Settlement period was not found or does not belong to this ledger' using errcode = '22023';
  end if;

  if payer_member_id is null or recipient_member_id is null then
    raise exception 'Settlement request must include both payer and recipient members' using errcode = '23514';
  end if;

  if payer_member_id = recipient_member_id then
    raise exception 'Settlement request payer and recipient must be different members' using errcode = '23514';
  end if;

  if not public.member_belongs_to_ledger(payer_member_id, target_ledger_id)
    or not public.member_belongs_to_ledger(recipient_member_id, target_ledger_id) then
    raise exception 'Settlement request members must belong to the same ledger' using errcode = '23514';
  end if;

  if amount_value is null or amount_value < 0 then
    raise exception 'Settlement request amount must be zero or greater' using errcode = '23514';
  end if;

  if normalized_status not in ('open', 'requested', 'paid', 'paid_pending', 'cancelled') then
    raise exception 'Invalid settlement request status' using errcode = '23514';
  end if;

  -- A closed period can gain no NEW requests: only an existing (non-cancelled)
  -- request for the pair may transition. This blanket-guards paid / requested /
  -- open on a closed period; the insert branch + stale sweep below stay
  -- open-period-only.
  if not period_is_open then
    if not exists (
      select 1 from public.settlement_requests sr
      where sr.period_id = target_open_period_id
        and sr.from_member_id = payer_member_id
        and sr.to_member_id = recipient_member_id
        and sr.status <> 'cancelled'
    ) then
      raise exception 'No active settlement request for this pair in the closed period' using errcode = '22023';
    end if;
  end if;

  -- Bound the requested amount (GVM-112): no pair settlement can exceed the
  -- period's total fuel spend. Deliberately an upper bound, not equality —
  -- monthly/running request shapes (GVM-76) vary by design, and a false
  -- rejection would block a legitimate payment request. Open-period only: a
  -- closed period's fuel total is frozen and the amount already exists on the row.
  if normalized_status = 'requested' and period_is_open then
    if amount_value is null or amount_value <= 0 then
      raise exception 'Requested amount must be greater than zero' using errcode = '23514';
    end if;
    if amount_value > (
      select coalesce(sum(fp.amount), 0) + 1.0
      from public.fuel_payments fp
      where fp.ledger_id = target_ledger_id
        and fp.period_id = target_open_period_id
        and fp.deleted_at is null
    ) then
      raise exception 'Requested amount is larger than this period''s total fuel spend. Refresh the app and try again.' using errcode = '23514';
    end if;
  end if;

  -- Require an existing, non-cancelled request before claiming or confirming a
  -- payment (GVM-241, extended to paid_pending in GVM-213). Without this the
  -- pair upsert's on-conflict misses for a stale/foreign-period request and
  -- INSERTs a fresh row directly at a settled-ish status, which trips the 003
  -- trigger guard with the cryptic 'Request the payment before marking it paid'.
  -- Raise a clean, mappable error instead.
  if normalized_status in ('paid', 'paid_pending') then
    if not exists (
      select 1 from public.settlement_requests sr
      where sr.period_id = target_open_period_id
        and sr.from_member_id = payer_member_id
        and sr.to_member_id = recipient_member_id
        and sr.status <> 'cancelled'
    ) then
      raise exception 'No active payment request to mark as paid — refresh and try again' using errcode = '23514';
    end if;
  end if;

  if normalized_status = 'requested' then
    requested_at_value := now();
    requested_by_value := recipient_member_id;
  elsif normalized_status = 'paid' then
    paid_at_value := now();
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':settlement:' || target_open_period_id::text));

  -- Transition the pair's request via an explicit lookup + UPDATE, NOT
  -- INSERT ... ON CONFLICT. The 003 integrity trigger is BEFORE INSERT OR UPDATE,
  -- and a BEFORE INSERT trigger fires on an upsert's proposed row *before* the
  -- ON CONFLICT resolves to DO UPDATE — so an upsert to a settled status trips
  -- the trigger's INSERT guard even when a matching request exists (GVM-241).
  -- An explicit UPDATE fires BEFORE UPDATE, where the guard validates the
  -- transition as legal. Genuinely new rows still INSERT (open period only — a
  -- closed period was guaranteed an existing request above). prev_status drives
  -- the dispute event below (a paid_pending row sent back to 'requested').
  select sr.id, sr.status into saved_request_id, prev_status_value
  from public.settlement_requests sr
  where sr.period_id = target_open_period_id
    and sr.from_member_id = payer_member_id
    and sr.to_member_id = recipient_member_id
    and sr.status <> 'cancelled'
  for update;

  if saved_request_id is not null then
    update public.settlement_requests
       set amount = amount_value,
           currency = coalesce(nullif(currency_value, ''), 'DKK'),
           status = normalized_status,
           requested_at = requested_at_value,
           requested_by_member_id = requested_by_value,
           paid_at = paid_at_value,
           updated_at = now()
     where id = saved_request_id;
  elsif period_is_open then
    insert into public.settlement_requests (
      ledger_id,
      period_id,
      from_member_id,
      to_member_id,
      amount,
      currency,
      status,
      requested_at,
      requested_by_member_id,
      paid_at,
      updated_at
    ) values (
      target_ledger_id,
      target_open_period_id,
      payer_member_id,
      recipient_member_id,
      amount_value,
      coalesce(nullif(currency_value, ''), 'DKK'),
      normalized_status,
      requested_at_value,
      requested_by_value,
      paid_at_value,
      now()
    )
    returning id into saved_request_id;
  else
    raise exception 'No active settlement request for this pair in the closed period' using errcode = '22023';
  end if;

  -- Cancel stale requests whose pair is no longer valid this period. Open-period
  -- only: current_pair_keys is computed from the OPEN period's live settlements,
  -- so running it against a closed period would wrongly cancel that archived
  -- period's requests.
  if period_is_open then
    update public.settlement_requests sr
       set status = 'cancelled',
           updated_at = now(),
           requested_at = null,
           requested_by_member_id = null,
           paid_at = null
     where sr.ledger_id = target_ledger_id
       and sr.period_id = target_open_period_id
       and not ((sr.from_member_id::text || '->' || sr.to_member_id::text) = any(coalesce(current_pair_keys, array[]::text[])))
       and sr.status <> 'cancelled';
    get diagnostics cancelled_count = row_count;
  end if;

  -- Activity feed + realtime nudge (GVM-247): every status change writes a
  -- ledger_events row so the other member's client (subscribed to ledger_events)
  -- refetches immediately, and the change lands in the activity feed. The
  -- two-step confirmation (GVM-213) adds payment_claimed (debtor marked paid,
  -- awaiting confirmation) and payment_disputed (recipient sent a paid_pending
  -- debt back to 'requested'); payment_paid now means confirmed/received.
  event_type_value := case
    when normalized_status = 'requested' and prev_status_value = 'paid_pending' then 'payment_disputed'
    when normalized_status = 'requested' then 'payment_requested'
    when normalized_status = 'paid_pending' then 'payment_claimed'
    when normalized_status = 'paid' then 'payment_paid'
    else 'settlement_' || normalized_status
  end;
  event_title_value := case
    when normalized_status = 'requested' and prev_status_value = 'paid_pending' then 'Betaling afvist'
    when normalized_status = 'requested' then 'Betaling anmodet'
    when normalized_status = 'paid_pending' then 'Afventer bekræftelse'
    when normalized_status = 'paid' then 'Betaling bekræftet'
    when normalized_status = 'cancelled' then 'Betaling annulleret'
    else 'Betaling genåbnet'
  end;

  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id, event_type_value, event_title_value, '',
    actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
    jsonb_build_object(
      'settlement_request_id', saved_request_id,
      'from_member_id', payer_member_id,
      'to_member_id', recipient_member_id,
      'amount', amount_value
    )
  );

  return jsonb_build_object(
    'settlement_request_id', saved_request_id,
    'ledger_id', target_ledger_id,
    'period_id', target_open_period_id,
    'status', normalized_status,
    'cancelled_stale_count', cancelled_count
  );
end;
$$;

revoke execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) from public;
grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) to authenticated;

-- ── GV-245: workspace join code 4 -> 6 char body ────────────────────────────
-- Re-declared off migration 045 (newest prior definition): gen_random_bytes(6)
-- and six substr picks instead of four. Prefix, alphabet, uniqueness loop and
-- tries cap unchanged.
create or replace function public.generate_workspace_join_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Crockford-ish base32 without easily-confused chars (no I, O, 0, 1).
  code_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  rand_bytes bytea;
  candidate text;
  tries integer := 0;
begin
  loop
    tries := tries + 1;
    rand_bytes := extensions.gen_random_bytes(6);
    candidate := 'GV-'
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 0) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 1) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 2) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 3) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 4) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 5) % 32), 1);
    exit when not exists (select 1 from public.ledgers where join_code = candidate);
    if tries >= 20 then
      raise exception 'Could not generate a unique join code; please try again.' using errcode = 'P0001';
    end if;
  end loop;
  return candidate;
end;
$$;

revoke all on function public.generate_workspace_join_code() from public;
revoke all on function public.generate_workspace_join_code() from anon;
revoke all on function public.generate_workspace_join_code() from authenticated;

-- Data-only (NOT mirrored in supabase-schema.sql — the equivalence check compares
-- schema objects, not data): regenerate every existing join code so the shorter
-- 4-char codes stop resolving. One RPC call per ledger row is fine at this scale.
update public.ledgers
set join_code = public.generate_workspace_join_code(), updated_at = now()
where join_code is not null;

-- ── GV-246: remove the is_ledger_bootstrap_open trapdoor ────────────────────
-- Drop the three pure-bootstrap policies outright (no legitimate remainder).
drop policy if exists "Bootstrap users can update ledgers" on public.ledgers;
drop policy if exists "Bootstrap users can read members" on public.ledger_members;
drop policy if exists "Bootstrap users can update members" on public.ledger_members;

-- Re-create the five member/admin policies WITHOUT the bootstrap disjunct; the
-- rest of each policy is byte-preserved from migration 005.
drop policy if exists "Ledger members can read JSON ledger" on public.car_share_ledgers;
create policy "Ledger members can read JSON ledger" on public.car_share_ledgers for select to authenticated using (public.is_ledger_member(id));
drop policy if exists "Ledger admins can insert JSON ledger" on public.car_share_ledgers;
create policy "Ledger admins can insert JSON ledger" on public.car_share_ledgers for insert to authenticated with check (public.is_ledger_admin(id));
drop policy if exists "Ledger admins can update JSON ledger" on public.car_share_ledgers;
create policy "Ledger admins can update JSON ledger" on public.car_share_ledgers for update to authenticated using (public.is_ledger_admin(id)) with check (public.is_ledger_admin(id));
drop policy if exists "Ledger members can read ledgers" on public.ledgers;
create policy "Ledger members can read ledgers" on public.ledgers for select to authenticated using (public.is_ledger_member(id));
drop policy if exists "Ledger members can read members" on public.ledger_members;
create policy "Ledger members can read members" on public.ledger_members for select to authenticated using (public.is_ledger_member(ledger_id));

-- Prod drift discovered at first apply (2026-07-10): the live database carries
-- legacy-named copies of the car_share_ledgers write policies ("Ledger MEMBERS
-- can insert/update JSON ledger") that predate the 005 file's "admins" naming
-- and still reference the trapdoor, so the function drop below was blocked
-- (2BP01). Drop them by name, then sweep ANY remaining policy whose expression
-- still references the function, so no other unrecorded name drift can block
-- the drop. Both are no-ops on a fresh install.
drop policy if exists "Ledger members can insert JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger members can update JSON ledger" on public.car_share_ledgers;

do $sweep$
declare
  leftover_policy record;
begin
  for leftover_policy in
    select pol.schemaname, pol.tablename, pol.policyname
    from pg_policies pol
    where coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')
          like '%is_ledger_bootstrap_open%'
  loop
    execute format('drop policy %I on %I.%I',
                   leftover_policy.policyname, leftover_policy.schemaname, leftover_policy.tablename);
  end loop;
end
$sweep$;

-- With no policy referencing it, drop the function. The
-- lock_ledger_bootstrap_when_admin_email_attached trigger and the
-- bootstrap_locked_at column are intentionally kept (no dependency, removing
-- them is churn not security).
drop function public.is_ledger_bootstrap_open(text);

-- ── GV-247: identity parties must be active members ─────────────────────────
-- Extends migration 101's enforce_identity_reassignment() (newest definition).
-- 101's admin-or-creator reassignment gate is preserved verbatim; two active-
-- member checks are added — an unconditional one on INSERT and one on UPDATE
-- whenever the identity actually changes. OLD is only read on the UPDATE path so
-- the same function is safe under the new `before insert or update` triggers.
create or replace function public.enforce_identity_reassignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id text := new.ledger_id;
  v_actor_member_id uuid;
  v_old_identity uuid;
  v_new_identity uuid;
  v_creator_member_id uuid;
begin
  -- Identity-bearing member column per table (GV-253 / GV-247). Any other table
  -- falls straight through untouched.
  if tg_table_name = 'trips' then
    v_new_identity := new.driver_member_id;
  elsif tg_table_name = 'fuel_payments' then
    v_new_identity := new.payer_member_id;
  elsif tg_table_name = 'car_bookings' then
    v_new_identity := new.member_id;
  else
    return new;
  end if;

  -- GV-247: on INSERT the identity party must be an ACTIVE member of NEW's
  -- ledger. No admin/creator check here — that permission rule is UPDATE-only.
  if tg_op = 'INSERT' then
    if v_new_identity is not null and not exists (
      select 1 from public.ledger_members lm
      where lm.id = v_new_identity
        and lm.ledger_id = v_ledger_id
        and lm.is_active
    ) then
      raise exception 'Identity members must be active ledger members' using errcode = '23514';
    end if;
    return new;
  end if;

  -- UPDATE path: resolve the OLD identity + creator (safe now that INSERT has
  -- already returned above).
  if tg_table_name = 'trips' then
    v_old_identity := old.driver_member_id;
  elsif tg_table_name = 'fuel_payments' then
    v_old_identity := old.payer_member_id;
  elsif tg_table_name = 'car_bookings' then
    v_old_identity := old.member_id;
  end if;
  v_creator_member_id := old.created_by_member_id;

  -- Guard only an actual reassignment; an unchanged identity passes through so the
  -- driver / payer / booked member keeps editing every non-identity field.
  if v_new_identity is not distinct from v_old_identity then
    return new;
  end if;

  -- Reassignment is admin-or-creator only. The JWT helpers resolve the real actor
  -- even inside the SECURITY DEFINER upsert RPCs (auth.jwt() is request-scoped),
  -- mirroring how is_ledger_admin / current_ledger_member_id already work there.
  v_actor_member_id := public.current_ledger_member_id(v_ledger_id);
  if not (
    public.is_ledger_admin(v_ledger_id)
    or (v_creator_member_id is not null and v_creator_member_id = v_actor_member_id)
  ) then
    raise exception
      'Only the creator or a ledger admin can reassign who this entry belongs to.'
      using errcode = '42501';
  end if;

  -- GV-247: the reassigned identity must also be an ACTIVE member of the ledger.
  if v_new_identity is not null and not exists (
    select 1 from public.ledger_members lm
    where lm.id = v_new_identity
      and lm.ledger_id = v_ledger_id
      and lm.is_active
  ) then
    raise exception 'Identity members must be active ledger members' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_identity_reassignment() from public;

-- Recreate the three triggers as `before insert or update` (101's names kept).
drop trigger if exists enforce_identity_reassignment_trips on public.trips;
create trigger enforce_identity_reassignment_trips
before insert or update on public.trips
for each row execute function public.enforce_identity_reassignment();

drop trigger if exists enforce_identity_reassignment_fuel on public.fuel_payments;
create trigger enforce_identity_reassignment_fuel
before insert or update on public.fuel_payments
for each row execute function public.enforce_identity_reassignment();

drop trigger if exists enforce_identity_reassignment_bookings on public.car_bookings;
create trigger enforce_identity_reassignment_bookings
before insert or update on public.car_bookings
for each row execute function public.enforce_identity_reassignment();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('103_security_hardening',
        'Security wave (GV-244..GV-247): upsert_settlement_request_status re-declared off 090 with a party-or-admin guard so only the payer, recipient or a ledger admin can create/transition a settlement request (closes the SECURITY DEFINER bypass of the party-or-admin table RLS). Join codes lengthened 4->6 char body (generate_workspace_join_code off 045, gen_random_bytes(6)); all existing codes regenerated (data-only). is_ledger_bootstrap_open trapdoor removed: 3 pure-bootstrap policies dropped, 5 policies re-created without the bootstrap disjunct, then the function dropped (bootstrap trigger + column kept). enforce_identity_reassignment extended (off 101) so trips.driver_member_id / fuel_payments.payer_member_id / car_bookings.member_id must reference an active member on INSERT and on identity-changing UPDATE; triggers recreated as before insert or update. Trade-offs: old join codes/links die at apply time; backfilling a removed member needs temporary reactivation.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
