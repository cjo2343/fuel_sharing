-- Migration 096: purge notification_preferences on account deletion (GV-229)
--
-- notification_preferences (migration 095, GVM-119) has no FK to auth.users (the
-- schema-equivalence harness has no auth schema), so account deletion left an
-- orphaned row. Re-declare delete_my_account (verbatim from migration 072, the
-- newest definition) with one extra DELETE — same pattern migration 057 used to
-- add the push-token purge. The row holds no PII; this is data minimisation.

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

  -- Let the settlement lock trigger (GV-199) know these writes are GDPR PII
  -- scrubs, not settlement edits, so its closed-period rejection stands aside.
  -- Transaction-local, so it clears automatically at commit/rollback.
  perform set_config('govehlo.pii_scrub', '1', true);

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

    -- Structured fuel stop (migration 063): the from/to labels + lat/lng are the
    -- member's route history — potentially their home address. Null the whole
    -- jsonb; station coords are public, but from/to are personal, so simplest-
    -- correct wins (GV-197).
    update public.car_bookings cb
    set fuel_stop = null, updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and (cb.member_id = v_member.id or cb.created_by_member_id = v_member.id)
      and cb.fuel_stop is not null;

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


  -- Purge this user's notification preferences (GV-229). No PII (three booleans
  -- + a uuid), but data minimisation says don't leave an orphaned row behind.
  delete from public.notification_preferences np where np.user_id = v_uid;

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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('096_purge_notification_preferences_on_delete',
        'delete_my_account also purges notification_preferences on account deletion (GV-229) — data minimisation for the GVM-119 prefs row.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
