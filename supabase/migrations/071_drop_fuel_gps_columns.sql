-- Migration 071: drop the driver-GPS columns from fuel_payments (GV-196)
--
-- GDPR data minimisation, defence-in-depth follow-up to GV-186 (migration 062).
-- Migration 062 stopped upsert_fuel_payment from persisting user_lat/user_lng
-- (always writes NULL) and backfilled every existing row to NULL, but it kept
-- the columns. As long as the columns exist, the fuel_payments RLS insert/update
-- policies still let a member write a row DIRECTLY with GPS populated, bypassing
-- the RPC. Dropping the columns removes that path entirely — the driver's own
-- position can no longer be stored anywhere in the table.
--
-- This migration:
--   1. Re-declares upsert_fuel_payment FIRST (verbatim from migration 062) with
--      the user_lat/user_lng references removed from its INSERT column list,
--      VALUES and UPDATE set-list. The 19-arg signature is UNCHANGED — the
--      user_lat_value/user_lng_value params stay accepted-and-ignored so an
--      already-running older client build that still passes them does not break.
--      Function-first so the live function never references a dropped column.
--   2. Re-declares delete_my_account (verbatim from migration 057) with the
--      fuel-stop user-coordinate scrub block removed: with the columns gone
--      there is nothing left to scrub.
--   3. Drops fuel_payments.user_lat / user_lng.
--
-- Analytics are unaffected (station_name/brand, station_lat/lng, price/amount/
-- liters, payment_date, odometer all remain) — the only data removed is the
-- driver's own position, which was never part of station/price analytics.

create or replace function public.upsert_fuel_payment(
  target_ledger_id text,
  target_open_period_id uuid,
  legacy_fuel_id text,
  payer_member_id uuid,
  payment_date_value date,
  amount_value numeric,
  currency_value text,
  liters_value numeric,
  price_per_liter_value numeric,
  odometer_value numeric,
  station_name_value text,
  station_brand_value text,
  station_lat_value numeric,
  station_lng_value numeric,
  user_lat_value numeric,
  user_lng_value numeric,
  full_tank_value boolean,
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  locked_period_id uuid;
  saved_fuel_id uuid;
  existing_fuel record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if legacy_fuel_id is null or legacy_fuel_id = '' then
    raise exception 'Missing legacy fuel id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save fuel payments' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Take a SHARED row lock on the open period (GVM-112): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight write and a close
  -- serialize here — either this entry commits first and the close's server-side
  -- recompute sees it, or the close commits first and this check finds no open
  -- period and fails cleanly.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if payer_member_id is null or not public.member_belongs_to_ledger(payer_member_id, target_ledger_id) then
    raise exception 'Fuel payer must be an active member of this ledger' using errcode = '23514';
  end if;

  if amount_value is null or amount_value < 0 then
    raise exception 'Fuel amount must be zero or greater' using errcode = '23514';
  end if;

  if liters_value is not null and liters_value < 0 then
    raise exception 'Fuel liters must be zero or greater' using errcode = '23514';
  end if;

  if price_per_liter_value is not null and price_per_liter_value < 0 then
    raise exception 'Fuel price per liter must be zero or greater' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':fuel:' || legacy_fuel_id));

  select *
    into existing_fuel
  from public.fuel_payments
  where ledger_id = target_ledger_id
    and legacy_id = legacy_fuel_id
  for update;

  if existing_fuel.id is not null and not (
    public.is_ledger_admin(target_ledger_id)
    or existing_fuel.created_by_member_id = actor_member_id
    or existing_fuel.payer_member_id = actor_member_id
  ) then
    raise exception 'Only the fuel creator, payer, or a ledger admin can update this fuel payment' using errcode = '42501';
  end if;

  if existing_fuel.id is null and not (
    public.is_ledger_admin(target_ledger_id)
    or payer_member_id = actor_member_id
  ) then
    raise exception 'Only the fuel payer or a ledger admin can create this fuel payment' using errcode = '42501';
  end if;

  -- GDPR data minimisation (GV-186 / GV-196): the driver's own position is never
  -- stored — the user_lat/user_lng columns have been dropped (migration 071). The
  -- user_lat_value/user_lng_value params are retained in the signature for
  -- backward compatibility with older client builds but are intentionally
  -- discarded here. station_lat/station_lng are still recorded.
  insert into public.fuel_payments (
    legacy_id,
    ledger_id,
    period_id,
    payer_member_id,
    payment_date,
    amount,
    currency,
    liters,
    price_per_liter,
    odometer,
    station_name,
    station_brand,
    station_lat,
    station_lng,
    full_tank,
    created_by_member_id,
    deleted_at,
    updated_at
  ) values (
    legacy_fuel_id,
    target_ledger_id,
    target_open_period_id,
    payer_member_id,
    payment_date_value,
    amount_value,
    coalesce(nullif(currency_value, ''), 'DKK'),
    liters_value,
    price_per_liter_value,
    odometer_value,
    nullif(station_name_value, ''),
    nullif(station_brand_value, ''),
    station_lat_value,
    station_lng_value,
    coalesce(full_tank_value, false),
    actor_member_id,
    null,
    now()
  )
  on conflict (ledger_id, legacy_id) do update set
    period_id = excluded.period_id,
    payer_member_id = excluded.payer_member_id,
    payment_date = excluded.payment_date,
    amount = excluded.amount,
    currency = excluded.currency,
    liters = excluded.liters,
    price_per_liter = excluded.price_per_liter,
    odometer = excluded.odometer,
    station_name = excluded.station_name,
    station_brand = excluded.station_brand,
    station_lat = excluded.station_lat,
    station_lng = excluded.station_lng,
    full_tank = excluded.full_tank,
    deleted_at = null,
    updated_at = now()
  returning id into saved_fuel_id;

  -- Activity feed event, on create only (GVM-84).
  if existing_fuel.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'fuel_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('fuel_id', saved_fuel_id)
    );
  end if;

  return jsonb_build_object(
    'fuel_id', saved_fuel_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_fuel_id
  );
end;
$$;

grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) to authenticated;

-- Re-declare delete_my_account (verbatim from migration 057) with the fuel-stop
-- user-coordinate scrub removed: the user_lat/user_lng columns are dropped below,
-- so there is nothing left to null out.
create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := public.current_user_email();
  v_member record;
  v_old_name text;
  v_first_name text;
  v_anon_name text;
  v_suffix integer;
  v_no_other_active boolean;
  v_successor record;
  v_ledgers_scrubbed integer := 0;
  v_ledgers_deleted integer := 0;
  v_admins_promoted integer := 0;
begin
  if v_uid is null or v_email is null then
    raise exception 'Account deletion requires a signed-in user' using errcode = '42501';
  end if;

  for v_member in
    select lm.id, lm.ledger_id, lm.name, lm.role, lm.is_active
    from public.ledger_members lm
    where lm.email is not null
      and lower(lm.email) = v_email
  loop
    v_old_name := v_member.name;
    v_first_name := split_part(v_old_name, ' ', 1);

    -- No other active member left? The workspace dies with this account: nobody
    -- could ever access it again, so full deletion is the cleanest erasure.
    -- Every child table references ledgers(id) with on delete cascade.
    select not exists (
      select 1
      from public.ledger_members lm2
      where lm2.ledger_id = v_member.ledger_id
        and lm2.is_active = true
        and lm2.id <> v_member.id
    ) into v_no_other_active;
    if v_no_other_active then
      delete from public.ledgers l where l.id = v_member.ledger_id;
      v_ledgers_deleted := v_ledgers_deleted + 1;
      continue;
    end if;

    -- Admin succession: never leave a live workspace admin-less. Promote the
    -- longest-standing active member and say so in the feed (system actor).
    if v_member.is_active and v_member.role = 'admin' and not exists (
      select 1
      from public.ledger_members lm3
      where lm3.ledger_id = v_member.ledger_id
        and lm3.is_active = true
        and lm3.role = 'admin'
        and lm3.id <> v_member.id
    ) then
      select lm4.id, lm4.name
      into v_successor
      from public.ledger_members lm4
      where lm4.ledger_id = v_member.ledger_id
        and lm4.is_active = true
        and lm4.id <> v_member.id
      order by lm4.created_at asc, lm4.id asc
      limit 1;

      update public.ledger_members lm5
      set role = 'admin', updated_at = now()
      where lm5.id = v_successor.id;

      insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, target_member_id, metadata)
      values (
        v_member.ledger_id,
        'member_promoted',
        v_successor.name || ' er nu administrator',
        'Automatisk, fordi den tidligere administrator slettede sin konto',
        null,
        null,
        v_successor.id,
        jsonb_build_object('reason', 'account_deleted')
      );
      v_admins_promoted := v_admins_promoted + 1;
    end if;

    -- Per-ledger-unique anonymized name (unique(ledger_id, name) would reject a
    -- second 'Slettet medlem' in the same group).
    v_anon_name := 'Slettet medlem';
    v_suffix := 1;
    while exists (
      select 1
      from public.ledger_members lm6
      where lm6.ledger_id = v_member.ledger_id
        and lm6.name = v_anon_name
        and lm6.id <> v_member.id
    ) loop
      v_suffix := v_suffix + 1;
      v_anon_name := 'Slettet medlem ' || v_suffix;
    end loop;

    -- Authored free text: trip notes are the creator's words, not car facts.
    update public.trips t
    set note = null, updated_at = now()
    where t.ledger_id = v_member.ledger_id
      and t.created_by_member_id = v_member.id
      and t.note is not null;

    -- Bookings: purposes are authored text; future bookings would block the car
    -- for a person who no longer exists.
    update public.car_bookings cb
    set purpose = null, updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and (cb.member_id = v_member.id or cb.created_by_member_id = v_member.id)
      and cb.purpose is not null;

    update public.car_bookings cb
    set deleted_at = now(), updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and cb.member_id = v_member.id
      and cb.start_at > now()
      and cb.deleted_at is null;

    -- Chat: blank + soft-delete their messages (the app already filters deleted).
    update public.messages msg
    set body = '', deleted_at = coalesce(msg.deleted_at, now())
    where msg.ledger_id = v_member.ledger_id
      and msg.sender_member_id = v_member.id;

    -- Feed events: drop stored emails and replace the member's name inside titles
    -- and bodies they authored or are targeted by. Events self-expire after 30
    -- days, so this is belt-and-braces on top of bounded retention. Very short
    -- first names (< 3 chars) are skipped for the substring pass — the collision
    -- risk with unrelated words outweighs the residual exposure.
    if char_length(v_first_name) < 3 then
      v_first_name := v_old_name;
    end if;
    update public.ledger_events ev
    set actor_email = case when ev.actor_member_id = v_member.id then null else ev.actor_email end,
        target_email = case when ev.target_member_id = v_member.id then null else ev.target_email end,
        title = replace(replace(ev.title, v_old_name, 'Slettet medlem'), v_first_name, 'Slettet medlem'),
        body = replace(replace(ev.body, v_old_name, 'Slettet medlem'), v_first_name, 'Slettet medlem')
    where ev.ledger_id = v_member.ledger_id
      and (ev.actor_member_id = v_member.id or ev.target_member_id = v_member.id);

    -- Archived snapshots: closed periods keep their maths, but the name fields
    -- inside people[] / settlements[] must stop identifying the person. The
    -- entry fingerprint (migration 054) covers trip/fuel ids only, never names,
    -- so this rewrite cannot invalidate any integrity check.
    update public.settlement_periods sp
    set snapshot_json = jsonb_set(
      sp.snapshot_json,
      '{people}',
      (
        select coalesce(jsonb_agg(
          case when person ->> 'id' = v_member.id::text
            then jsonb_set(person, '{name}', to_jsonb(v_anon_name))
            else person
          end
        ), '[]'::jsonb)
        from jsonb_array_elements(sp.snapshot_json -> 'people') as person
      )
    )
    where sp.ledger_id = v_member.ledger_id
      and sp.snapshot_json is not null
      and jsonb_typeof(sp.snapshot_json -> 'people') = 'array';

    update public.settlement_periods sp
    set snapshot_json = jsonb_set(
      sp.snapshot_json,
      '{settlements}',
      (
        select coalesce(jsonb_agg(
          case when settled ->> 'toId' = v_member.id::text
            then jsonb_set(settled, '{toName}', to_jsonb(v_anon_name))
            else settled
          end
        ), '[]'::jsonb)
        from (
          select case when raw ->> 'fromId' = v_member.id::text
            then jsonb_set(raw, '{fromName}', to_jsonb(v_anon_name))
            else raw
          end as settled
          from jsonb_array_elements(sp.snapshot_json -> 'settlements') as raw
        ) as renamed
      )
    )
    where sp.ledger_id = v_member.ledger_id
      and sp.snapshot_json is not null
      and jsonb_typeof(sp.snapshot_json -> 'settlements') = 'array';

    -- Invites addressed to this email in this ledger.
    update public.ledger_invites li
    set invited_email = null, updated_at = now()
    where li.ledger_id = v_member.ledger_id
      and lower(coalesce(li.invited_email, '')) = v_email;

    -- Finally the member row itself. Role drops to 'member' (succession above
    -- already ensured another admin exists when one was needed).
    update public.ledger_members lm7
    set name = v_anon_name,
        email = null,
        mobilepay_phone = null,
        role = 'member',
        is_active = false,
        updated_at = now()
    where lm7.id = v_member.id;

    -- Feed transparency, in app voice, without re-publishing the old name.
    insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, metadata)
    values (
      v_member.ledger_id,
      'member_deleted',
      'Et medlem slettede sin konto',
      v_anon_name || ' er anonymiseret. Gruppens regnskab er uændret.',
      null,
      null,
      jsonb_build_object('member_id', v_member.id)
    );

    v_ledgers_scrubbed := v_ledgers_scrubbed + 1;
  end loop;

  -- Cross-ledger cleanup keyed by identity rather than membership.
  delete from public.push_subscriptions ps
  where lower(ps.user_email) = v_email;

  delete from public.ledger_onboarding_rate_limits rl
  where lower(rl.actor_email) = v_email;

  update public.owner_activity_log oal
  set actor_email = null, actor_user_id = null
  where oal.actor_user_id = v_uid
     or lower(coalesce(oal.actor_email, '')) = v_email;

  -- Push tokens die with the account (migration 057): match by user id and by
  -- the scrubbed email so nothing keeps addressing this person's devices.
  delete from public.expo_push_tokens ept
  where ept.user_id = v_uid
     or lower(ept.email) = v_email;

  -- Kill the credentials last: cascades sessions/identities, frees the email for
  -- a fresh sign-up. The caller's JWT stays technically valid until expiry but no
  -- longer matches any member (email scrubbed), so RLS yields nothing.
  delete from auth.users au where au.id = v_uid;

  return jsonb_build_object(
    'ledgers_scrubbed', v_ledgers_scrubbed,
    'ledgers_deleted', v_ledgers_deleted,
    'admins_promoted', v_admins_promoted
  );
end;
$$;

-- Drop the driver-GPS columns. Migration 062 already backfilled every row to
-- NULL; this removes the columns (and with them the direct-write bypass the
-- fuel_payments RLS insert/update policies would otherwise allow).
alter table public.fuel_payments
  drop column if exists user_lat,
  drop column if exists user_lng;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('071_drop_fuel_gps_columns', 'Drop driver-GPS columns user_lat/user_lng from fuel_payments; re-declare upsert_fuel_payment and delete_my_account without them (GV-196)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
