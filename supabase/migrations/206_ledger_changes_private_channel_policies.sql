-- Migration 206: authorize members on the ledger-changes live-sync topics (GVM-575)
--
-- Second half of closing GVM-575. Migration 205 fixed the presence channel; this one
-- prepares the OTHER realtime channel the mobile app opens — `ledger-changes-<id>`,
-- the postgres_changes live-sync channel from migration 087's contract — to be opened
-- with private: true, which it must be before "Allow public access" can be switched
-- off in Realtime Settings (the actual GVM-575 deliverable).
--
-- A private channel's join-time authorization is checked against realtime.messages
-- policies even when the client only listens for postgres_changes: the check
-- test-writes rows for BOTH extensions ('broadcast' AND 'presence') in one
-- transaction and needs SELECT back, so a topic with no read+write policy pair is
-- rejected outright — the exact 205 lesson, which is why these policies carry the
-- same extension list even though nothing on this channel broadcasts today. The
-- postgres_changes rows themselves are still authorized separately, per source
-- table, by the RLS policies on public.ledger_events and public.messages; nothing
-- here widens what data a member can see.
--
-- Gate: same shape as the presence pair. Topic prefix matched with left(), never
-- LIKE (a ledger id may contain '_'); membership via public.is_ledger_member on the
-- suffix after the 15-character prefix 'ledger-changes-'.
--
-- PROD-ONLY by construction, exactly like 202/205: the whole block sits inside the
-- realtime-schema guard and every statement goes through EXECUTE, so a
-- plain-Postgres replay never parses a reference to realtime.messages. No table or
-- function signature changes, so types/database.ts moves only by its generation
-- stamp.
--
-- Rollout order (the mobile side fails gracefully either way): apply this SQL, then
-- ship the mobile change opening the channel with private: true, then flip
-- "Allow public access" off and verify presence + live sync.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'realtime') then
    execute $pol$drop policy if exists "Ledger members can read workspace live-sync" on realtime.messages $pol$;
    execute $pol$
      create policy "Ledger members can read workspace live-sync"
      on realtime.messages
      for select
      to authenticated
      using (
        realtime.messages.extension in ('broadcast', 'presence')
        and left(realtime.topic(), 15) = 'ledger-changes-'
        and public.is_ledger_member(substring(realtime.topic() from 16))
      )
    $pol$;

    execute $pol$drop policy if exists "Ledger members can join workspace live-sync" on realtime.messages $pol$;
    execute $pol$
      create policy "Ledger members can join workspace live-sync"
      on realtime.messages
      for insert
      to authenticated
      with check (
        realtime.messages.extension in ('broadcast', 'presence')
        and left(realtime.topic(), 15) = 'ledger-changes-'
        and public.is_ledger_member(substring(realtime.topic() from 16))
      )
    $pol$;
  end if;
end $$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '206_ledger_changes_private_channel_policies',
  'Authorize members on the ledger-changes live-sync topics (GVM-575, second half). Migration 205 fixed presence; this prepares the mobile app''s ledger-changes-<id> postgres_changes channel (migration 087 live-sync contract) to be opened with private: true, required before "Allow public access" can be switched off — the actual GVM-575 deliverable. A private channel''s join is authorized against the messages policies even for a listen-only postgres_changes channel: the check test-writes rows for BOTH extensions in one transaction and reads them back, so a topic with no read+write pair is rejected outright (the 205 lesson; hence the same extension list although nothing on this channel broadcasts today). The postgres_changes rows themselves stay authorized separately by RLS on public.ledger_events and public.messages — nothing here widens what data a member can see. Same gate shape as the presence pair: left() prefix match on the 15-character ''ledger-changes-'' prefix (never LIKE — a ledger id may contain underscore), membership via public.is_ledger_member on the suffix. Prod-only via the guard with EXECUTE, like 202/205. No signature changes; types move only by the generation stamp. Rollout: apply SQL, ship the mobile private: true change, then flip public access off and verify.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
