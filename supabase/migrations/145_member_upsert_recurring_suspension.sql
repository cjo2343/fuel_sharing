-- Migration 145: Suspend a deactivated member's recurring templates on the path the clients actually use (GV-373)
--
-- Migration 114 (GV-277) taught payer-deactivation to suspend recurring templates
-- and announce it in the feed. It taught the WRONG function.
--
-- That work landed on set_ledger_member_active_admin, which has no client caller —
-- migration 143's own review notes say so out loud: "both clients deactivate through
-- upsert_ledger_member_admin's is_active parameter". They do:
--   * govehlo-mobile  src/lib/supabase-helpers.ts  -> rpc('upsert_ledger_member_admin')
--   * govehlo-web     admin/admin.js               -> rpc('upsert_ledger_member_admin')
-- The only caller of set_ledger_member_active_admin in the entire codebase is this
-- repo's own role-matrix guard, which is exactly why the hole survived: the guard
-- exercises the fixed function, so GV-277 has looked green while every real
-- deactivation went through the unfixed one.
--
-- ── What this is NOT ────────────────────────────────────────────────────────────
-- This is not a money bug, and nothing here touches generator logic. Both recurring
-- generators already gate on member_is_active_in_ledger (migration 114 part B), so a
-- deactivated payer's templates are skipped whether or not they were suspended. That
-- gating is correct and is left completely alone.
--
-- The damage is to the UI and the audit trail: the template still reads is_active =
-- true in Udgifter, so it LOOKS live while it can never generate anything, and the
-- group is never told it stopped. The mobile client already ships the whole reading
-- half of this contract (src/lib/recurring-suspension.ts, GVM-330: the reassignment
-- sheet, the Activity-feed CTA and the Expenses badge all key off is_active = false
-- plus a payer who is gone). Every one of those affordances is dark today, because
-- the event that triggers them is written by a function nothing calls.
--
-- ── The change ──────────────────────────────────────────────────────────────────
-- upsert_ledger_member_admin re-declared off migration 042 (its newest prior
-- definition — 012 created it, 042 locked out member creation, nothing since). The
-- admin gate, the required-name/email checks, the invite-only lockout, the
-- self-demotion guard, the advisory lock, the member update and the last-admin guard
-- are all 042 VERBATIM. One block is added, after the last-admin guard so a rejected
-- deactivation never does the work.
--
-- One deliberate difference from 114's copy of this block. set_ledger_member_active_admin
-- is a single-purpose toggle, so it can fire on `member_is_active is false` alone.
-- upsert_ledger_member_admin is the full-member upsert: the clients call it for name,
-- email, phone and role edits too, carrying the member's CURRENT is_active along in
-- the payload. Firing on the value would re-run the scan on every routine profile edit
-- of an already-inactive member. So this fires on the TRANSITION — active before, not
-- active after — which is also what makes the replay case structurally silent instead
-- of relying on GV-208's active-payer write guard to leave nothing to suspend.
--
-- Re-activation is deliberately NOT the mirror image; see the note on that block.
--
-- The event copy is byte-identical to 114's on purpose: both functions write the same
-- event_type into the same feed, rendered by the same mobile card. An admin should not
-- be able to tell which RPC their tap happened to reach.
--
-- Safe to rerun (create or replace; idempotent migration record).

create or replace function public.upsert_ledger_member_admin(
  target_ledger_id text default 'main-car',
  target_member_id uuid default null,
  member_name text default null,
  member_email text default null,
  member_mobilepay_phone text default null,
  member_role text default 'member',
  member_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  existing_member public.ledger_members%rowtype;
  saved_member_id uuid;
  normalized_email text := nullif(lower(trim(coalesce(member_email, ''))), '');
  normalized_role text := case when member_role = 'admin' then 'admin' else 'member' end;
  active_admin_count integer := 0;
  suspended_count integer := 0;
  suspended_names text;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can manage members' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not identify the current ledger admin' using errcode = '42501';
  end if;

  if nullif(trim(coalesce(member_name, '')), '') is null then
    raise exception 'Member name is required' using errcode = '23502';
  end if;

  if normalized_email is null then
    raise exception 'Member login email is required' using errcode = '23502';
  end if;

  -- Invite-only onboarding: this RPC may only update existing members. New members
  -- join by redeeming a workspace invite (redeem_ledger_invite), which enforces
  -- consent, expiry, max-uses, and rate limits. Reject creating a brand-new member
  -- row (null target_member_id) for everyone, including the app owner.
  if target_member_id is null then
    raise exception 'New members join by redeeming a workspace invite; member management can only update existing members' using errcode = '42501';
  end if;

  select * into existing_member
  from public.ledger_members
  where id = target_member_id and ledger_id = target_ledger_id
  for update;

  if existing_member.id is null then
    raise exception 'Member does not belong to this ledger' using errcode = '23503';
  end if;

  if existing_member.id = actor_member_id and (member_is_active is false or normalized_role <> 'admin') then
    raise exception 'Admins cannot demote or deactivate themselves' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':member-admin'));

  update public.ledger_members
  set name = trim(member_name),
      email = normalized_email,
      mobilepay_phone = nullif(trim(coalesce(member_mobilepay_phone, '')), ''),
      role = normalized_role,
      is_active = coalesce(member_is_active, true),
      updated_at = now()
  where id = target_member_id and ledger_id = target_ledger_id
  returning id into saved_member_id;

  select count(*) into active_admin_count
  from public.ledger_members
  where ledger_id = target_ledger_id and is_active = true and role = 'admin';

  if active_admin_count < 1 then
    raise exception 'At least one active admin is required' using errcode = '23514';
  end if;

  -- GV-373: on the active -> inactive TRANSITION, suspend every recurring template
  -- the member fronts. existing_member holds the pre-update row (it is selected
  -- before the update above), so this reads the real transition rather than the
  -- payload's is_active — a name or phone edit on an already-inactive member carries
  -- is_active = false too, and must stay a no-op. That gate is also the idempotency
  -- guarantee: a replayed deactivation finds the member already inactive, does
  -- nothing, and writes no second event.
  --
  -- Left active, a suspended-payer template would keep LOOKING live in Udgifter while
  -- the generators skip it (they gate on member_is_active_in_ledger, unchanged here),
  -- and the group would never be told. The event is what lights up the client half of
  -- this contract: the Activity-feed CTA and the Expenses badge from GVM-330.
  if existing_member.is_active is true and coalesce(member_is_active, true) is false then
    with suspended as (
      update public.recurring_expenses re
      set is_active = false, updated_at = now()
      where re.ledger_id = target_ledger_id
        and re.paid_by_member_id = target_member_id
        and re.is_active = true
        and re.deleted_at is null
      returning re.description, re.category
    )
    select count(*),
           string_agg(coalesce(nullif(btrim(s.description), ''), initcap(s.category)),
                      ', ' order by coalesce(nullif(btrim(s.description), ''), initcap(s.category)))
      into suspended_count, suspended_names
      from suspended s;

    if suspended_count > 0 then
      insert into public.ledger_events (
        ledger_id, event_type, title, body, actor_member_id, actor_email, target_member_id, metadata
      ) values (
        target_ledger_id,
        'recurring_suspended',
        'Faste udgifter sat på pause',
        coalesce(existing_member.name, 'Et medlem')
          || ' blev deaktiveret, så deres faste udgifter blev sat på pause: '
          || suspended_names
          || '. Vælg en ny betaler eller slet dem.',
        actor_member_id,
        nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
        target_member_id,
        jsonb_build_object('deactivated_member_id', target_member_id, 'suspended_count', suspended_count)
      );
    end if;
  end if;

  -- Re-activation is deliberately NOT symmetric: bringing a member back does not
  -- resume anything. Auto-resuming would be a money surprise on two counts. The feed
  -- told the group these were paused and nothing would say they restarted; and the
  -- generators catch up on missed occurrences (bounded at max_catchup_occurrences =
  -- 24 since GV-274), so a template paused for months would materialise its whole
  -- backlog as real charges the moment the member was re-activated — money nobody
  -- asked for, from a tap that only said "this person is back".
  --
  -- The resolution path is an explicit admin action that already ships: GVM-330's
  -- reassignment sheet repoints the payer and flips is_active back on through the
  -- ordinary upsert_recurring_expense write. Re-activating the original member simply
  -- makes the template stop being flagged as payer-orphaned (the client keys that off
  -- the payer being absent from the active roster) while it stays paused until
  -- someone deliberately resumes it. That is the same end state migration 114 leaves,
  -- so both deactivation paths continue to behave identically.

  return saved_member_id;
end;
$$;

revoke execute on function public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean) from public;
grant execute on function public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('145_member_upsert_recurring_suspension', 'upsert_ledger_member_admin re-declared off 042: on the active -> inactive transition it suspends every recurring template the member pays for and writes the recurring_suspended ledger_events row, closing GV-373. Migration 114 put that behaviour on set_ledger_member_active_admin, which no client calls — both clients deactivate through this RPC''s is_active parameter (migration 143''s notes say so), so GV-277 never fired in production and GVM-330''s reassignment CTA/badge stayed dark. Not a money bug: both generators already skip inactive-payer templates via member_is_active_in_ledger and are untouched; the defect was a stale is_active in Udgifter plus a missing feed entry. Unlike 114 this gates on the TRANSITION (pre-update is_active) rather than the payload value, because this RPC is the full-member upsert the clients also call for name/email/phone/role edits, which carry the current is_active along; that gate is also what makes a replay silent. Event copy is byte-identical to 114''s so both writers render the same card. Re-activation deliberately does not resume templates (backlog catch-up would be a money surprise); resolution stays GVM-330''s explicit reassignment.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
