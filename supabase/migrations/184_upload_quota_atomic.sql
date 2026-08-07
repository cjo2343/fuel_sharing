-- Migration 184: make receipt / incident-photo upload quotas atomic (GV-458)
--
-- THE BUG. Migrations 177 (fuel-receipts, cap 3) and 178 (incident-photos, cap 10)
-- enforce their per-prefix upload quota with a `(select count(*) … ) < <limit>`
-- sub-select inside the Storage INSERT RLS policy's WITH CHECK. That is a classic
-- check-then-insert TOCTOU: several uploads racing under the same
-- <ledger_id>/<entity_id>/ prefix each evaluate their WITH CHECK against the SAME
-- pre-insert count, all read a value below the limit, and all pass — so N concurrent
-- requests can push the prefix to well over the cap. Low blast radius (a bounded amount
-- of extra private-bucket storage, no data disclosure), but the quota is meant to be a
-- hard limit and a count(*) in a policy cannot be one.
--
-- THE FIX. A BEFORE INSERT trigger on storage.objects, scoped to exactly the two
-- quota-managed buckets, that SERIALISES concurrent inserts for the same
-- (bucket, <ledger>/<entity>) prefix on a transaction-scoped advisory lock and then
-- re-counts under that lock. Two racing uploads now take the same lock in turn: the
-- first counts, inserts and commits; the second counts AFTER the first is visible and
-- is rejected once the cap is reached. The advisory lock closes the window the RLS
-- count(*) leaves open, so the trigger — not the policy — is the authoritative gate.
--
-- The RLS policies from 177/178 are LEFT IN PLACE as defence-in-depth (they still bind
-- uploads to a real workspace + entity and express the same numeric cap for a
-- best-effort early rejection); the trigger is what makes the cap race-free. Because
-- those policies still carry a `count(*) … < <limit>`, migration 184 also teaches
-- tools/check-concurrency-hazards.mjs to recognise that shape (its new Pattern C) and
-- registers both policies in that guard's REVIEWED_EXCEPTIONS, justified by this trigger
-- — so the class is caught for the next author instead of shipping-then-hardening again
-- (the GV-454 guard only ever scanned function bodies, never RLS WITH CHECK, which is
-- why it did not flag 177/178).
--
-- The two limits (3 and 10) are copied EXACTLY from migrations 177 and 178. The count
-- uses LIKE against the same <ledger>/<entity>/% prefix those policies use, so the
-- trigger enforces precisely the same limit they express, atomically.
--
-- ── STORAGE COMPATIBILITY — read before editing (the migration-138 lesson) ─────────
-- The `storage` schema exists only in a real Supabase project; the CI guards
-- (schema-equivalence replay, gen:db-types, role matrix) run in a PLAIN Postgres
-- container with NO storage schema. The trigger FUNCTION below is created
-- unconditionally — a plpgsql body defers name resolution to execution, so a static
-- reference to storage.objects compiles fine where that table does not exist, and the
-- function (it `returns trigger`, so it is not a PostgREST-callable RPC and never enters
-- types/database.ts) is therefore byte-identical in both replay paths. Only the
-- `create trigger … on storage.objects` — which DOES resolve the table at DDL time — is
-- wrapped in the `if exists (… schema_name = 'storage')` guard, so plain Postgres skips
-- it and the trigger takes effect ONLY when this SQL is applied in the real Supabase SQL
-- Editor.

-- ── 1. Quota-enforcement trigger function (prod-neutral; created unconditionally) ──
create or replace function public.enforce_storage_upload_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_folder text[];
  v_ledger text;
  v_entity text;
  v_limit integer;
  v_existing integer;
begin
  -- Only the two quota-managed private buckets are serialised here; every other bucket
  -- returns immediately, so the trigger is a no-op for the rest of Storage.
  if new.bucket_id = 'fuel-receipts' then
    v_limit := 3;
  elsif new.bucket_id = 'incident-photos' then
    v_limit := 10;
  else
    return new;
  end if;

  -- Path convention is <ledger_id>/<entity_id>/<uuid>.<ext>. A malformed path is left
  -- for the RLS WITH CHECK policy to reject (it runs AFTER this BEFORE INSERT trigger)
  -- rather than counted here — the quota only concerns well-formed two-segment paths.
  v_folder := storage.foldername(new.name);
  if cardinality(v_folder) <> 2 then
    return new;
  end if;
  v_ledger := v_folder[1];
  v_entity := v_folder[2];

  -- Serialise every concurrent INSERT for the same (bucket, <ledger>/<entity>) prefix
  -- on a transaction-scoped advisory lock, so the count below is taken under the lock
  -- and the check-then-insert window the RLS count(*) leaves open is closed. Racing
  -- uploads no longer both observe the same sub-limit count.
  perform pg_advisory_xact_lock(hashtext(new.bucket_id || ':' || v_ledger || '/' || v_entity));

  -- Re-count existing objects under the same prefix, under the lock. LIKE is used
  -- deliberately and identically to the RLS policies in migrations 177/178, so the
  -- trigger enforces exactly the numeric cap those policies express.
  select count(*)
    into v_existing
    from storage.objects so2
   where so2.bucket_id = new.bucket_id
     and so2.name like v_ledger || '/' || v_entity || '/%';

  if v_existing >= v_limit then
    raise exception 'Upload-grænsen for denne mappe er nået (maks. % filer).', v_limit
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ── 2. Bind the trigger to storage.objects (PROD-ONLY; see the compatibility note) ──
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    drop trigger if exists enforce_storage_upload_quota_trg on storage.objects;
    create trigger enforce_storage_upload_quota_trg
      before insert on storage.objects
      for each row
      execute function public.enforce_storage_upload_quota();
  end if;
end $$;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '184_upload_quota_atomic',
  'GV-458: make the fuel-receipts and incident-photos upload quotas ATOMIC. Migrations 177 (cap 3) and 178 (cap 10) enforce their per-prefix object-count quota with a `(select count(*) …) < <limit>` sub-select inside the Storage INSERT RLS policy''s WITH CHECK — a check-then-insert TOCTOU: several uploads racing under the same <ledger_id>/<entity_id>/ prefix all evaluate WITH CHECK against the same pre-insert count, all read a value below the limit, and all pass, so N concurrent requests can push a prefix past its cap. Low blast radius (bounded extra private-bucket storage, no data disclosure) but a quota that is meant to be a hard limit cannot be one when expressed as count(*) in a policy. The fix is a BEFORE INSERT trigger on storage.objects, public.enforce_storage_upload_quota(), scoped to exactly those two buckets: it serialises concurrent inserts for the same (bucket, <ledger>/<entity>) prefix on a transaction-scoped advisory lock (pg_advisory_xact_lock(hashtext(bucket || '':'' || ledger || ''/'' || entity))) and re-counts under that lock, raising a Danish error (errcode check_violation) once the cap is reached — so the second of two racing uploads counts AFTER the first is visible and is rejected. The two limits (3 for fuel-receipts, 10 for incident-photos) and the LIKE prefix match are copied exactly from 177/178, so the trigger enforces the same numeric cap those policies express, atomically. The RLS policies from 177/178 are LEFT IN PLACE as defence-in-depth (they still bind uploads to a real workspace + entity and give a best-effort early rejection); the trigger is the authoritative race-free gate. STORAGE COMPATIBILITY (migration-138 lesson): the trigger FUNCTION is created unconditionally — a plpgsql body defers name resolution to execution, so its static reference to storage.objects compiles in plain-Postgres CI where that table does not exist, and because it returns trigger it is not a PostgREST-callable RPC and does not enter types/database.ts (types unchanged); only the `create trigger … on storage.objects`, which resolves the table at DDL time, is wrapped in the `if exists (information_schema.schemata where schema_name = ''storage'')` guard, so the trigger materialises only in the real Supabase SQL Editor. This migration also closes the GV-454 guard gap: tools/check-concurrency-hazards.mjs gains a Pattern C that flags `count(*) … < <limit>` inside `create policy … with check|using (…)` (it previously scanned only function bodies, never RLS WITH CHECK, which is why it never caught 177/178), and both surviving policies are registered in that guard''s REVIEWED_EXCEPTIONS with this trigger as the justification, with a self-test proving the raw pattern is flagged and the exception clears it. No new table, no new RPC, no new event_type, no grant change, no public-type change.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
