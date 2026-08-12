-- Migration 205: realtime presence policies must also authorize the broadcast extension (GVM-575)
--
-- Root cause of the private-channel "Unauthorized" that blocked GVM-575 for two days
-- and was misattributed to a Supabase service fault. Realtime's join-time authorization
-- check does not merely SELECT from realtime.messages under the caller's role — it
-- test-INSERTS rows for BOTH extensions, 'broadcast' AND 'presence', in one
-- transaction, to compute the connection's read/write capability per extension.
-- Migration 202's policies authorized extension = 'presence' only, so the broadcast
-- test-row violated the insert policy's WITH CHECK, the 42501 aborted the whole check
-- transaction, and every private join — valid member token or not — was rejected with
-- the generic "Unauthorized: You do not have permissions to read from this Channel
-- topic". The postgres logs had the tell all along: paired lines of
-- `new row violates row-level security policy for table "messages"` on each join
-- attempt. Diagnosis confirmed in prod on 2026-08-12 by reproducing the exact check
-- (set role authenticated + request.jwt.claims + realtime.topic, then inserting a
-- broadcast row -> 42501) and by TEMP broadcast policies flipping the live join from
-- rejected to SUBSCRIBED in ~500ms, with anon and non-member joins still rejected.
-- JWT verification was never broken: a deliberately tampered token is rejected with a
-- distinct JwtSignatureError, so ES256 user tokens verify fine on this tenant.
--
-- The fix re-declares both migration-202 policies (their NEWEST prior definition,
-- per the GV-202 rule) with extension in ('broadcast', 'presence') — the same
-- formulation the Supabase docs use, which is why presence-only policies are an
-- untrodden path. The membership gate is unchanged: only active members of the
-- workspace named by the topic suffix can read or write either extension on
-- presence-* topics, so this widens what a MEMBER may do on a topic they already
-- own, and nothing for anyone else. The two TEMP diagnostic policies created during
-- prod debugging are dropped here so the fix is self-cleaning when applied over them.
--
-- PROD-ONLY by construction, exactly like 202: the whole block sits inside the
-- realtime-schema guard and every statement goes through EXECUTE, so a plain-Postgres
-- replay (CI's schema-equivalence and contract-test databases) never parses a
-- reference to realtime.messages. No table or function signature changes, so
-- types/database.ts moves only by its generation stamp.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'realtime') then
    execute $pol$drop policy if exists "TEMP members broadcast read" on realtime.messages $pol$;
    execute $pol$drop policy if exists "TEMP members broadcast write" on realtime.messages $pol$;

    execute $pol$drop policy if exists "Ledger members can read workspace presence" on realtime.messages $pol$;
    execute $pol$
      create policy "Ledger members can read workspace presence"
      on realtime.messages
      for select
      to authenticated
      using (
        realtime.messages.extension in ('broadcast', 'presence')
        and left(realtime.topic(), 9) = 'presence-'
        and public.is_ledger_member(substring(realtime.topic() from 10))
      )
    $pol$;

    execute $pol$drop policy if exists "Ledger members can track workspace presence" on realtime.messages $pol$;
    execute $pol$
      create policy "Ledger members can track workspace presence"
      on realtime.messages
      for insert
      to authenticated
      with check (
        realtime.messages.extension in ('broadcast', 'presence')
        and left(realtime.topic(), 9) = 'presence-'
        and public.is_ledger_member(substring(realtime.topic() from 10))
      )
    $pol$;
  end if;
end $$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '205_presence_policies_cover_broadcast',
  'Realtime presence policies must also authorize the broadcast extension (GVM-575). Root cause of the private-channel Unauthorized misattributed to a Supabase fault: Realtime''s join-time authorization check test-INSERTS rows for BOTH extensions (broadcast AND presence) in one transaction; migration 202''s presence-only policies made the broadcast test-row violate WITH CHECK, and the 42501 aborted the whole check, rejecting every private join with the generic Unauthorized. Confirmed in prod 2026-08-12: reproducing the check (set role authenticated + claims + the topic GUC, insert broadcast row) raises 42501, and TEMP broadcast policies flip the live join to SUBSCRIBED in ~500ms while anon and non-member joins stay rejected; a tampered token fails with a distinct JwtSignatureError, so ES256 verification was never broken. Re-declares both 202 policies (newest prior definition) with extension in (''broadcast'', ''presence'') — the docs'' own formulation — keeping the membership gate unchanged, and drops the two TEMP diagnostic policies so applying this over them is self-cleaning. Prod-only via the realtime-schema guard with EXECUTE, like 202. No signature changes; types move only by the generation stamp.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
