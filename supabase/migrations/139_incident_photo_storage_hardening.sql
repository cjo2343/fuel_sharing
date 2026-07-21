-- Migration 139: Harden incident-photo Storage authorization (GV-348)
--
-- Migration 138 made the bucket private, but its object policies were broader than
-- the RPC contract: any workspace member could upload an arbitrary object below the
-- ledger prefix or delete another member's object directly through Storage. Keep
-- member reads, while binding uploads to a real incident and direct deletes to the
-- uploader or a workspace admin.

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
      );

    drop policy if exists "Incident photos are deletable by workspace members" on storage.objects;
    create policy "Incident photos are deletable by workspace members"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'incident-photos'
        and public.is_ledger_member((storage.foldername(name))[1])
        and (
          owner_id::text = auth.uid()::text
          or public.is_ledger_admin((storage.foldername(name))[1])
        )
      );
  end if;
end
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '139_incident_photo_storage_hardening',
  'Restricts incident-photo Storage uploads to existing incidents in the same ledger and direct object deletion to the uploader or a ledger admin; member read access remains unchanged.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
