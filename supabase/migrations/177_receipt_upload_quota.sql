-- Migration 177: receipt upload quota (GV-446)
--
-- The fuel-receipts Storage INSERT policy (migration 169) checks workspace membership
-- and fuel_payment existence but has NO per-payment object count limit. A caller with
-- a valid Supabase JWT can hit the Storage API directly, uploading unlimited 5 MiB
-- objects under any <ledger_id>/<fuel_payment_id>/ path they have membership for.
-- The fuel_payment_receipts table has a UNIQUE on fuel_payment_id (one ROW per payment),
-- but Storage objects are not constrained by that table.
--
-- Fix: add a count check to the INSERT policy — fewer than 3 objects may exist under the
-- same <ledger_id>/<fuel_payment_id>/ prefix before a new INSERT is allowed. Why 3: the
-- mobile app's replace flow creates a new object before deleting the old one (2 objects
-- simultaneously). If the cleanup fails, 2 objects persist. Cap at 3 gives margin for
-- one failed cleanup. 3 * 5 MiB = 15 MiB per fuel_payment is the maximum.
--
-- Only the INSERT policy is changed; SELECT, UPDATE, and DELETE policies are untouched.

-- ── Storage-schema guard ────────────────────────────────────────────────────────
-- storage.objects only exists in Supabase, not in plain-Postgres CI replays.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
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
        and (
          select count(*)
          from storage.objects so2
          where so2.bucket_id = 'fuel-receipts'
            and so2.name like (storage.foldername(name))[1] || '/' || (storage.foldername(name))[2] || '/%'
        ) < 3
      );
  end if;
end $$;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '177_receipt_upload_quota',
  'GV-446: per-payment object count cap on fuel-receipts Storage INSERT policy. The existing policy (migration 169) checks workspace membership and fuel_payment existence but imposes no limit on how many objects a caller can upload under a given <ledger_id>/<fuel_payment_id>/ prefix. A malicious workspace member could upload unlimited 5 MiB objects via the Storage API directly. The fix adds a count check: fewer than 3 objects must exist under the same prefix before a new INSERT is allowed. Cap of 3 accommodates the mobile replace flow (new object created before old one deleted = 2 simultaneously) plus one failed cleanup. 3 * 5 MiB = 15 MiB per fuel_payment maximum. Only the INSERT policy is changed; SELECT, UPDATE, and DELETE policies are untouched. No new table, no new RPC, no new event_type, no grant change.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
