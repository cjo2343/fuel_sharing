-- Migration 152: soft per-member cap on upcoming bookings (GVM-434)
--
-- Third slice of the fair-share epic. Slices one and two (GVM-432/433) made car
-- usage VISIBLE; this one lets a group agree a number out loud: how many upcoming
-- bookings one member may hold before the app says something.
--
-- IT IS A NUDGE, NOT A RULE, and the schema is deliberately shaped to make that
-- impossible to get wrong later. There is NO enforcement here — no trigger, no
-- check on car_bookings, nothing that can reject an insert. The column stores a
-- number the CLIENT reads to decide whether to show a soft heads-up in the booking
-- sheet, and the booking still saves either way. That follows the policy already
-- settled elsewhere in the product: soft warning as the rule, hard block only for
-- the unambiguously broken case (GVM-413 warns on another member's window,
-- GVM-417 blocks only DURING a running booking). A land grab is unfairness, not
-- corruption, so nothing here refuses a write. It is also the same
-- stored-but-not-enforced shape as rule_require_requests_before_close (migration
-- 098), which exists to drive a client decision and has no database enforcement.
--
-- NULL = OFF, and off is the default (the ticket asks for it explicitly). That is
-- what protects live data: every existing workspace gets NULL, so no group that has
-- never heard of this feature starts warning its members about bookings they made
-- last month. The setting only ever begins to bite after an admin turns it on.
--
-- COUNT OF BOOKINGS, not booked days — the ticket's open question. Days are harder
-- to game, but they punish the one three-week summer holiday, which is the most
-- legitimate long booking a shared car ever sees, and the ticket names that risk
-- itself. The title asks for a cap on "fremtidige bookinger", so bookings it is.
-- The days/horizon variant stays available as a later, separate setting.

alter table public.ledgers
  add column if not exists booking_future_cap_per_member integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ledgers_booking_future_cap_check'
  ) then
    alter table public.ledgers
      add constraint ledgers_booking_future_cap_check
      check (booking_future_cap_per_member is null
             or (booking_future_cap_per_member >= 1 and booking_future_cap_per_member <= 50));
  end if;
end $$;

-- ── set_booking_future_cap: admin sets (or clears) the workspace's soft cap ──────
--
-- Its own admin-gated RPC rather than a sixth parameter on update_ledger_settings,
-- for the reason migration 080 gave for set_close_reminder_enabled: that function
-- patches with coalesce, so a NULL parameter means "leave it alone" and there would
-- be no way to express "turn the cap off" at all. Here NULL is a real value.
--
-- Emits a settings_changed event on a REAL change only, exactly as migration 119
-- made the settlement rules do: cross-client live sync IS that insert (migration
-- 087 lesson), and a group deserves to see in the feed that someone changed a rule
-- about their bookings. Setting the same number twice writes an identical row and
-- emits nothing. Danish server copy, overridable by the client for app voice.
create or replace function public.set_booking_future_cap(
  target_ledger_id text,
  cap_value integer,
  event_title text default null,
  event_body text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old_cap integer;
  actor_id uuid;
  current_actor_email text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can change the booking cap.' using errcode = '42501';
  end if;

  -- Reject an unusable number up front rather than letting the check constraint
  -- surface as a raw 23514. 50 upcoming bookings for one member is already far
  -- past anything a nudge could helpfully say.
  if cap_value is not null and (cap_value < 1 or cap_value > 50) then
    raise exception 'Booking cap must be between 1 and 50' using errcode = '22023';
  end if;

  select l.booking_future_cap_per_member
    into old_cap
    from public.ledgers l
    where l.id = target_ledger_id;

  update public.ledgers l
  set booking_future_cap_per_member = cap_value,
      updated_at = now()
  where l.id = target_ledger_id;

  if cap_value is distinct from old_cap then
    actor_id := public.current_ledger_member_id(target_ledger_id);
    current_actor_email := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');

    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'settings_changed',
      coalesce(nullif(btrim(event_title), ''), 'Bookingloft ændret'),
      coalesce(
        nullif(btrim(event_body), ''),
        case
          when cap_value is null then 'Der er ikke længere et loft over kommende bookinger.'
          when cap_value = 1 then 'Gruppen får nu et blødt praj ved mere end 1 kommende booking pr. person.'
          else 'Gruppen får nu et blødt praj ved mere end ' || cap_value::text
               || ' kommende bookinger pr. person.'
        end
      ),
      actor_id,
      current_actor_email,
      jsonb_build_object(
        'field', 'booking_future_cap_per_member',
        'old', old_cap,
        'new', cap_value
      )
    );
  end if;
end;
$$;

revoke all on function public.set_booking_future_cap(text, integer, text, text) from public;
revoke all on function public.set_booking_future_cap(text, integer, text, text) from anon;
grant execute on function public.set_booking_future_cap(text, integer, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('152_booking_future_cap',
        'Soft per-member cap on upcoming bookings (GVM-434), third slice of the fair-share epic. New nullable ledgers.booking_future_cap_per_member (check: null or 1..50) where NULL means OFF and is the default, so every existing workspace keeps behaving exactly as before and no group starts warning members about bookings they already made. Deliberately UNENFORCED in the database — no trigger, no constraint on car_bookings — because the ticket asks the cap to warn, not block: the client reads the number and shows a non-blocking heads-up in the booking sheet, matching the settled policy that soft warning is the rule and a hard block is reserved for the unambiguously broken case (GVM-413 vs GVM-417). Same stored-but-not-enforced shape as rule_require_requests_before_close (098). Counts BOOKINGS, not booked days: the ticket left that open and flagged that a day-based cap punishes the one long holiday trip, which is the most legitimate long booking a shared car sees. New admin-gated set_booking_future_cap(text, integer, text, text) rather than a sixth update_ledger_settings parameter, because that function coalesce-patches and could therefore never express "clear the cap" (the same reason migration 080 gave set_close_reminder_enabled its own RPC). Writes a settings_changed ledger_event on a real change only (is distinct from, so re-saving the same number emits nothing), with Danish server-composed copy the client may override — the event insert is what live-syncs the rule change to other members (migration 087 lesson). Revokes execute from public and anon explicitly (148 convention), grants authenticated.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
