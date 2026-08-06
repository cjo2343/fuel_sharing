-- Migration 178: incident-photo upload quota (GV-450)
--
-- The incident-photos Storage INSERT policy (migration 139) checks workspace
-- membership and vehicle_incident existence but has NO per-incident object count
-- limit. A caller with a valid Supabase JWT can hit the Storage API directly,
-- uploading unlimited 5 MiB objects under any <ledger_id>/<incident_id>/ path they
-- have membership for. Same risk profile as GV-446 on fuel-receipts.
--
-- Fix: add a count check to the INSERT policy -- fewer than 10 objects may exist
-- under the same <ledger_id>/<incident_id>/ prefix before a new INSERT is allowed.
-- Why 10 (vs 3 for fuel receipts): incident photos are multi-photo by design -- a
-- member documents an incident from several angles, so several photos per incident
-- is normal, not an anomaly. 10 * 5 MiB = 50 MiB per incident is the maximum.
--
-- Only the INSERT policy is changed; SELECT and DELETE policies are untouched.

-- ── Storage-schema guard ────────────────────────────────────────────────────────
-- storage.objects only exists in Supabase, not in plain-Postgres CI replays.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    drop policy if exists "Incident photos are writable by workspace members" on storage.objects;
    create policy "Incident photos are writable by workspace members"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'incident-photos'
        and cardinality(storage.foldername(name)) = 2
        and public.is_ledger_member((storage.foldername(name))[1])
        and exists (
          select 1
          from public.vehicle_incidents vi
          where vi.ledger_id = (storage.foldername(name))[1]
            and vi.id::text = (storage.foldername(name))[2]
        )
        and (
          select count(*)
          from storage.objects so2
          where so2.bucket_id = 'incident-photos'
            and so2.name like (storage.foldername(name))[1] || '/' || (storage.foldername(name))[2] || '/%'
        ) < 10
      );
  end if;
end $$;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '178_incident_photo_upload_quota',
  'GV-450: per-incident object count cap on incident-photos Storage INSERT policy. The existing policy (migration 139) checks workspace membership and vehicle_incident existence but imposes no limit on how many objects a caller can upload under a given <ledger_id>/<incident_id>/ prefix. A malicious workspace member could upload unlimited 5 MiB objects via the Storage API directly. The fix adds a count check: fewer than 10 objects must exist under the same prefix before a new INSERT is allowed. Cap of 10 (vs 3 for fuel receipts in GV-446) reflects that incident photos are multi-photo by design -- a member documents an incident from several angles, so several photos per incident is expected. 10 * 5 MiB = 50 MiB per incident maximum. Only the INSERT policy is changed; SELECT and DELETE policies are untouched. No new table, no new RPC, no new event_type, no grant change.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
