-- Migration 201: vehicle document archive (GVM-523)
--
-- The workspace's papirmappe for the shared car: forsikringspolice,
-- registreringsattest, synsrapport, vejhjælpsaftale. Each document is ONE titled
-- entry with an OPTIONAL expiry date and up to a handful of PHOTOGRAPHED PAGES —
-- photos only, no PDF in v1, because the phone camera is the scanner every member
-- already has and a PDF pipeline (upload, render, thumbnail, page count) is a whole
-- second feature for a v1 that only has to answer "hvornår udløber forsikringen, og
-- hvor står policenummeret?".
--
-- ── Owner decisions (2026-08-10), written into the SQL rather than left to a client ──
--
-- (1) EXPIRY SURFACING IS CLIENT-SIDE ONLY. expiry_date is a plain date column and
--     NOTHING here reads it: no push, no scheduled job, no claim_due_* RPC, no
--     retention rule. The mobile Home health queue computes "udløber om 14 dage" from
--     rows it already holds, exactly as the booking/service cards do. A server-side
--     reminder would be a second scheduler hook, a second push key and a second
--     notification preference for a date the group can already see — and it would fire
--     for a document nobody renewed through the app anyway.
--
-- (2) HARD DELETE, NO TOMBSTONE. A document is an attachment, not an accounting row:
--     nothing settles against it, so the five-year financial retention that governs
--     trips/fuel/repairs has nothing to say here. delete_vehicle_document removes the
--     row, the photo rows cascade with it, and the RPC hands the caller the storage
--     paths it must delete — migration 138's coordination, unchanged (see below).
--
-- ── Photos, storage and who deletes what (cloned from 138/139/169) ─────────────────
-- Same shape as incident photos, deliberately, down to the path convention:
-- <ledger_id>/<document_id>/<token>.<ext> in a PRIVATE bucket. The photo ROW is
-- registered through add_vehicle_document_photo / delete_vehicle_document_photo, so
-- the database is the authority on who may attach or detach; the storage.objects
-- policies (migration 139's HARDENED shape from day one, as 169 did) are
-- defence-in-depth on top.
--
-- 138's storage-object COORDINATION is copied exactly: the storage OBJECT is deleted
-- by the CLIENT through the Storage API, and the SQL owns only the row plus the
-- authorization. That is why delete_vehicle_document returns storage_paths (an array —
-- a document has several pages) and delete_vehicle_document_photo returns
-- storage_path, the same way detach_fuel_payment_receipt does. The backstop for a
-- caller that crashes half way is the daily orphan sweep in govehlo-web
-- (/api/hooks/storage-orphan-cleanup, GV-435), which is why
-- list_registered_storage_paths is extended below rather than left at two tables.
--
-- ── STORAGE COMPATIBILITY — READ BEFORE EDITING (the migration-138 lesson) ─────────
-- The `storage` schema only exists in a real Supabase project. The CI guards
-- (schema-equivalence replay, role matrix, db-types) run in a PLAIN Postgres container
-- with NO storage schema. So EVERY storage statement below (the bucket row and the
-- storage.objects policies) is wrapped in a
-- `if exists (select 1 from information_schema.schemata where schema_name = 'storage')`
-- guard: in plain Postgres the guard is false and nothing storage-related runs (both
-- replays stay identical and pass); in prod the guard is true and the real bucket +
-- policies are created. Migration 184's nuance applies to the quota function
-- re-declared below: the trigger FUNCTION is created UNCONDITIONALLY (a plpgsql body
-- defers name resolution to execution, and it `returns trigger` so it never enters
-- types/database.ts), while only `create trigger … on storage.objects` — which
-- resolves the table at DDL time — needs the guard. 184 already bound that trigger and
-- this migration does not re-bind it: replacing the function is enough, because the
-- trigger references it by name.
--
-- ── Ancestry (the GV-202 newest-prior-definition rule) ────────────────────────────
--   • public.enforce_storage_upload_quota() — re-declared off migration 184 (its ONLY
--     and therefore newest prior definition; chain 184 → 201), byte-identical apart
--     from a third bucket branch (vehicle-documents, limit 5) and the two comment lines
--     that said "two buckets". The advisory-lock + recount-under-lock semantics, the
--     LIKE prefix match and the Danish error copy are untouched.
--   • public.list_registered_storage_paths(text, text, integer) — re-declared off
--     migration 191 (chain 191 → 201), byte-identical apart from one added allow-list
--     branch for vehicle_document_photos. Without it the orphan sweep would answer
--     22023 for the new bucket and could never clean it — the sweep is the ONLY thing
--     that removes an object whose row died in a cascade.
--   • public.delete_my_account() is deliberately NOT re-declared. Same reasoning
--     migration 169 wrote down: created_by_member_id points at the member row that
--     delete_my_account anonymises IN PLACE (name -> 'Slettet medlem', email -> null),
--     exactly like fuel_payments.payer_member_id and trips.driver_member_id, so no
--     attribution PII survives account deletion. Re-declaring a ~290-line function to
--     null a pointer anonymisation already covers is blast radius bought for nothing.
--
-- ── No new event_type, deliberately (GV-413) ──────────────────────────────────────
-- Filing a document writes NO ledger_events row. The mobile Activity feed renders
-- whatever the database writes, and "Bo lagde registreringsattesten ind" is not news
-- the group needs pushed at it — the archive is PULL-based, read when somebody goes
-- looking for the policy number. Nothing here needs classifying in
-- FEED_VISIBLE_EVENT_TYPES or EVENT_TYPE_EXCLUDE. The cost is accepted and named: no
-- ledger_events row means no cross-client live sync (the migration 087 lesson), so a
-- second member sees a new document on their next refresh rather than instantly.
--
-- ── GDPR ──────────────────────────────────────────────────────────────────────────
-- A registreringsattest carries the owner's NAME and ADDRESS and an insurance policy
-- carries a policy number — personal data about a member, photographed by another
-- member. Minimisation is served by the shape rather than by a promise: nothing
-- uploads on its own (a row exists only because a member photographed a page), the
-- bucket is PRIVATE and workspace-scoped by the leading path segment, the object cap
-- is 5 pages per document, no path or signed URL ever appears in a URL, a query string
-- or a log line, and processing stays in the EU (Supabase EU). Any member may delete a
-- page they uploaded; a workspace admin may delete any of them. Recorded in
-- docs/gdpr/ropa.md (A2), docs/gdpr/retention.md and docs/gdpr/deletion-limitations.md.

-- ── 1. Document table ────────────────────────────────────────────────────────
-- ledger_id is denormalized onto both tables for RLS, exactly as migration 138 scopes
-- incident photos: the policy must answer "may this caller read this row?" without
-- joining out, and the workspace is the security boundary everywhere else too.
create table if not exists public.vehicle_documents (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  title text not null check (btrim(title) <> '' and char_length(title) <= 120),
  expiry_date date,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vehicle_documents_ledger_created_idx
  on public.vehicle_documents (ledger_id, created_at desc, id);

-- The health-queue read is "which documents in this workspace expire soonest": rows
-- with no expiry are not in that answer at all, so the index is partial.
create index if not exists vehicle_documents_ledger_expiry_idx
  on public.vehicle_documents (ledger_id, expiry_date)
  where expiry_date is not null;

alter table public.vehicle_documents enable row level security;

drop policy if exists "Ledger members can read vehicle documents"
  on public.vehicle_documents;
create policy "Ledger members can read vehicle documents"
  on public.vehicle_documents
  for select
  using (public.is_ledger_member(ledger_id));

-- Reads for workspace members only; all writes go through the RPCs below (the 138/169
-- posture: no write grant exists for any client role).
revoke all on table public.vehicle_documents from public;
revoke all on table public.vehicle_documents from anon;
revoke all on table public.vehicle_documents from authenticated;
revoke all on table public.vehicle_documents from service_role;
grant select on table public.vehicle_documents to authenticated;
grant select on table public.vehicle_documents to service_role;

-- ── 2. Document photo table (mirrors vehicle_incident_photos) ────────────────
create table if not exists public.vehicle_document_photos (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.vehicle_documents(id) on delete cascade,
  ledger_id text not null references public.ledgers(id) on delete cascade,
  storage_path text not null unique,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists vehicle_document_photos_document_idx
  on public.vehicle_document_photos (document_id, created_at, id);

alter table public.vehicle_document_photos enable row level security;

drop policy if exists "Ledger members can read vehicle document photos"
  on public.vehicle_document_photos;
create policy "Ledger members can read vehicle document photos"
  on public.vehicle_document_photos
  for select
  using (public.is_ledger_member(ledger_id));

-- Reads for workspace members only; inserts/deletes go through the photo RPCs. The
-- service_role select is what lets the orphan sweep read the registered paths.
revoke all on table public.vehicle_document_photos from public;
revoke all on table public.vehicle_document_photos from anon;
revoke all on table public.vehicle_document_photos from authenticated;
revoke all on table public.vehicle_document_photos from service_role;
grant select on table public.vehicle_document_photos to authenticated;
grant select on table public.vehicle_document_photos to service_role;

-- ── 3. Write RPCs ────────────────────────────────────────────────────────────
-- File a new document. Any active workspace member may file one; the creator is
-- resolved from the caller (current_ledger_member_id), never trusted from a param.
--
-- The per-workspace cap of 50 is taken UNDER AN ADVISORY LOCK and re-counted under it
-- (migration 184's shape, applied to a table instead of a bucket prefix). A plain
-- count-then-insert is a check-then-insert race: N members filing at the same moment
-- all read the same sub-cap count and all pass. The lock is transaction-scoped, keyed
-- on the workspace, and held only for the count + insert, so it serialises document
-- CREATION in one workspace and nothing else.
create or replace function public.create_vehicle_document(
  target_ledger_id text,
  document_title text,
  document_expiry date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_member_id uuid;
  v_title text;
  v_document_id uuid;
  v_existing integer;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Mangler workspace-id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Kun medlemmer af workspacet kan gemme dokumenter' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Kunne ikke matche brugeren med et aktivt medlem' using errcode = '42501';
  end if;

  v_title := nullif(btrim(document_title), '');
  if v_title is null then
    raise exception 'Dokumentet skal have en titel' using errcode = '22023';
  end if;
  if char_length(v_title) > 120 then
    raise exception 'Titlen kan højst være 120 tegn' using errcode = '22023';
  end if;

  -- Serialise concurrent creates in THIS workspace, then count under the lock, so the
  -- cap is a hard limit rather than a value two racing callers can both read as 49.
  perform pg_advisory_xact_lock(hashtext('vehicle_documents:' || target_ledger_id));

  select count(*)
    into v_existing
    from public.vehicle_documents vd
   where vd.ledger_id = target_ledger_id;

  if v_existing >= 50 then
    raise exception 'Der er plads til højst 50 dokumenter i et workspace' using errcode = '23514';
  end if;

  insert into public.vehicle_documents (
    ledger_id, title, expiry_date, created_by_member_id
  ) values (
    target_ledger_id, v_title, document_expiry, v_actor_member_id
  )
  returning id into v_document_id;

  return jsonb_build_object(
    'document_id', v_document_id,
    'ledger_id', target_ledger_id
  );
end;
$$;

revoke all on function public.create_vehicle_document(text, text, date) from public;
revoke all on function public.create_vehicle_document(text, text, date) from anon;
grant execute on function public.create_vehicle_document(text, text, date) to authenticated;

-- Edit a document's title and expiry. The gate MIRRORS migration 138's
-- update_vehicle_incident: only a workspace admin OR the member who filed the document
-- may edit it. Any-member editing was considered and rejected for the same reason 138
-- rejected it — the person who photographed the papers is the one who knows what they
-- say, and the workspace admin is the escape hatch when they are gone.
--
-- FULL-SET semantics, unlike 138's leave-null-unchanged: the title is required and a
-- NULL expiry CLEARS the date. A document whose expiry was entered by mistake has to
-- be able to lose it, and "null means unchanged" would make that impossible without a
-- second clear_expiry flag. This is migration 167's set_vehicle_location posture.
create or replace function public.update_vehicle_document(
  target_document_id uuid,
  document_title text,
  document_expiry date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.vehicle_documents%rowtype;
  v_actor_member_id uuid;
  v_title text;
begin
  if target_document_id is null then
    raise exception 'Mangler dokument-id' using errcode = '22023';
  end if;

  select * into v_document
  from public.vehicle_documents vd
  where vd.id = target_document_id;

  if v_document.id is null then
    raise exception 'Dokumentet blev ikke fundet' using errcode = '22023';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_document.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Kun medlemmer af workspacet kan rette dokumenter' using errcode = '42501';
  end if;

  if not (
    public.is_ledger_admin(v_document.ledger_id)
    or coalesce(v_document.created_by_member_id = v_actor_member_id, false)
  ) then
    raise exception 'Kun den, der gemte dokumentet, eller en administrator kan rette det' using errcode = '42501';
  end if;

  v_title := nullif(btrim(document_title), '');
  if v_title is null then
    raise exception 'Dokumentet skal have en titel' using errcode = '22023';
  end if;
  if char_length(v_title) > 120 then
    raise exception 'Titlen kan højst være 120 tegn' using errcode = '22023';
  end if;

  update public.vehicle_documents vd
  set title = v_title,
      expiry_date = document_expiry,
      updated_at = now()
  where vd.id = target_document_id;

  return jsonb_build_object(
    'document_id', target_document_id,
    'ledger_id', v_document.ledger_id
  );
end;
$$;

revoke all on function public.update_vehicle_document(uuid, text, date) from public;
revoke all on function public.update_vehicle_document(uuid, text, date) from anon;
grant execute on function public.update_vehicle_document(uuid, text, date) to authenticated;

-- Delete a document. Creator-or-admin, the same gate as the edit above. The photo ROWS
-- cascade with it; the storage OBJECTS are the CALLER's half of the contract (migration
-- 138's coordination), so every path is returned. A caller that dies in between leaves
-- objects the daily orphan sweep (GV-435) removes 24h later.
create or replace function public.delete_vehicle_document(
  target_document_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.vehicle_documents%rowtype;
  v_actor_member_id uuid;
  v_paths text[] := '{}';
begin
  if target_document_id is null then
    raise exception 'Mangler dokument-id' using errcode = '22023';
  end if;

  select * into v_document
  from public.vehicle_documents vd
  where vd.id = target_document_id;

  if v_document.id is null then
    raise exception 'Dokumentet blev ikke fundet' using errcode = '22023';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_document.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Kun medlemmer af workspacet kan slette dokumenter' using errcode = '42501';
  end if;

  if not (
    public.is_ledger_admin(v_document.ledger_id)
    or coalesce(v_document.created_by_member_id = v_actor_member_id, false)
  ) then
    raise exception 'Kun den, der gemte dokumentet, eller en administrator kan slette det' using errcode = '42501';
  end if;

  -- Collected BEFORE the delete: the cascade takes the photo rows with the document,
  -- and a caller told nothing would leave every page in the bucket.
  select coalesce(array_agg(vdp.storage_path order by vdp.created_at, vdp.id), '{}'::text[])
    into v_paths
    from public.vehicle_document_photos vdp
   where vdp.document_id = target_document_id;

  delete from public.vehicle_documents vd where vd.id = target_document_id;

  return jsonb_build_object(
    'document_id', target_document_id,
    'ledger_id', v_document.ledger_id,
    'storage_paths', to_jsonb(v_paths)
  );
end;
$$;

revoke all on function public.delete_vehicle_document(uuid) from public;
revoke all on function public.delete_vehicle_document(uuid) from anon;
grant execute on function public.delete_vehicle_document(uuid) to authenticated;

-- Register a photographed page against a document. Any workspace member may add a page
-- to a document in their OWN workspace (migration 138's add_incident_photo gate — the
-- group shares the car and its papers). The storage_path MUST live under the document's
-- own <ledger_id>/<document_id>/ prefix, so a member cannot register a row that points
-- at another workspace's or another document's object.
create or replace function public.add_vehicle_document_photo(
  p_document_id uuid,
  p_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.vehicle_documents%rowtype;
  v_actor_member_id uuid;
  v_expected_prefix text;
  v_photo_id uuid;
begin
  if p_document_id is null then
    raise exception 'Mangler dokument-id' using errcode = '22023';
  end if;

  if nullif(btrim(p_storage_path), '') is null then
    raise exception 'Mangler sti til filen' using errcode = '22023';
  end if;

  select * into v_document
  from public.vehicle_documents vd
  where vd.id = p_document_id;

  if v_document.id is null then
    raise exception 'Dokumentet blev ikke fundet' using errcode = '22023';
  end if;

  if not public.is_ledger_member(v_document.ledger_id) then
    raise exception 'Kun medlemmer af workspacet kan tilføje sider' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_document.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Kunne ikke matche brugeren med et aktivt medlem' using errcode = '42501';
  end if;

  -- Path convention: <ledger_id>/<document_id>/<token>.<ext>. Compare the literal
  -- prefix (no LIKE -- ledger ids can contain '_', a LIKE wildcard).
  v_expected_prefix := v_document.ledger_id || '/' || p_document_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) <> v_expected_prefix then
    raise exception 'Filen skal ligge under dokumentets eget workspace og dokument-id' using errcode = '22023';
  end if;

  insert into public.vehicle_document_photos (
    document_id, ledger_id, storage_path, created_by_member_id
  ) values (
    p_document_id, v_document.ledger_id, p_storage_path, v_actor_member_id
  )
  returning id into v_photo_id;

  return jsonb_build_object(
    'photo_id', v_photo_id,
    'document_id', p_document_id,
    'ledger_id', v_document.ledger_id
  );
end;
$$;

revoke all on function public.add_vehicle_document_photo(uuid, text) from public;
revoke all on function public.add_vehicle_document_photo(uuid, text) from anon;
grant execute on function public.add_vehicle_document_photo(uuid, text) to authenticated;

-- Remove one registered page. Only a workspace admin or the member who uploaded it may
-- delete it (migration 138's delete_incident_photo gate). The storage object itself is
-- cleaned up by the client, so the removed path is returned; THIS row is the authority
-- on who may detach a page.
create or replace function public.delete_vehicle_document_photo(
  p_photo_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_photo public.vehicle_document_photos%rowtype;
  v_actor_member_id uuid;
begin
  if p_photo_id is null then
    raise exception 'Mangler side-id' using errcode = '22023';
  end if;

  select * into v_photo
  from public.vehicle_document_photos vdp
  where vdp.id = p_photo_id;

  if v_photo.id is null then
    raise exception 'Siden blev ikke fundet' using errcode = '22023';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_photo.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Kun medlemmer af workspacet kan slette sider' using errcode = '42501';
  end if;

  if not (
    public.is_ledger_admin(v_photo.ledger_id)
    or coalesce(v_photo.created_by_member_id = v_actor_member_id, false)
  ) then
    raise exception 'Kun den, der lagde siden op, eller en administrator kan slette den' using errcode = '42501';
  end if;

  delete from public.vehicle_document_photos vdp where vdp.id = p_photo_id;

  return jsonb_build_object(
    'photo_id', p_photo_id,
    'document_id', v_photo.document_id,
    'ledger_id', v_photo.ledger_id,
    'storage_path', v_photo.storage_path
  );
end;
$$;

revoke all on function public.delete_vehicle_document_photo(uuid) from public;
revoke all on function public.delete_vehicle_document_photo(uuid) from anon;
grant execute on function public.delete_vehicle_document_photo(uuid) to authenticated;

-- ── 4. Supabase Storage (PROD-ONLY; see the STORAGE COMPATIBILITY note above) ──
-- Guarded on the `storage` schema existing so plain-Postgres CI replays skip it
-- entirely and only the real Supabase project materialises the private bucket +
-- workspace-scoped object policies. The policies are migration 139's HARDENED shape
-- from day one (as 169 did): uploads are bound to a real document in the same ledger,
-- and direct deletes to the object's owner or a workspace admin. The per-document
-- object CAP is not expressed here — it lives in the quota trigger below, which is the
-- race-free gate (migration 184's finding: a count(*) inside a WITH CHECK cannot be a
-- hard limit).
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    -- Private bucket, 5 MiB cap, images only (same limits as incident-photos).
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'vehicle-documents', 'vehicle-documents', false, 5242880,
      array['image/jpeg', 'image/png', 'image/webp']
    )
    on conflict (id) do update set
      public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

    -- Workspace-scoped read: the first path segment is the ledger id
    -- (<ledger_id>/<document_id>/<token>.<ext>), gated through is_ledger_member.
    drop policy if exists "Vehicle documents are readable by workspace members" on storage.objects;
    create policy "Vehicle documents are readable by workspace members"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'vehicle-documents'
        and public.is_ledger_member((storage.foldername(name))[1])
      );

    -- Uploads must land under an EXISTING document in the caller's own workspace, so
    -- the bucket cannot be used as free storage below a ledger prefix (GV-348's lesson).
    drop policy if exists "Vehicle documents are writable by workspace members" on storage.objects;
    create policy "Vehicle documents are writable by workspace members"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'vehicle-documents'
        and cardinality(storage.foldername(name)) = 2
        and public.is_ledger_member((storage.foldername(name))[1])
        and exists (
          select 1
          from public.vehicle_documents vd
          where vd.ledger_id = (storage.foldername(name))[1]
            and vd.id::text = (storage.foldername(name))[2]
        )
      );

    -- Uploader-or-admin delete, matching delete_vehicle_document_photo's own gate. The
    -- uploader identity lives in public.vehicle_document_photos, so the object policy
    -- uses storage's own owner_id as the equivalent signal (migration 139's shape).
    drop policy if exists "Vehicle documents are deletable by workspace members" on storage.objects;
    create policy "Vehicle documents are deletable by workspace members"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'vehicle-documents'
        and public.is_ledger_member((storage.foldername(name))[1])
        and (
          owner_id::text = auth.uid()::text
          or public.is_ledger_admin((storage.foldername(name))[1])
        )
      );
  end if;
end
$$;

-- ── 5. Upload quota: re-declared off migration 184 (chain 184 → 201) ───────────
-- Byte-identical to 184's body apart from the third bucket branch and the two comment
-- lines that said "two buckets". Five pages per document: a registreringsattest is two
-- sides, an insurance policy a couple of pages, and a member who needs a sixth is
-- filing two documents. 5 * 5 MiB = 25 MiB per document maximum.
--
-- The trigger itself is NOT re-bound here: migration 184 already created
-- enforce_storage_upload_quota_trg on storage.objects and it resolves this function by
-- name, so replacing the function is the whole change.
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
  -- Only the three quota-managed private buckets are serialised here; every other
  -- bucket returns immediately, so the trigger is a no-op for the rest of Storage.
  if new.bucket_id = 'fuel-receipts' then
    v_limit := 3;
  elsif new.bucket_id = 'incident-photos' then
    v_limit := 10;
  elsif new.bucket_id = 'vehicle-documents' then
    v_limit := 5;
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
  -- trigger enforces exactly the numeric cap those policies express. The
  -- vehicle-documents bucket (migration 201) has no count in its own policy at all, so
  -- for it this trigger is the ONLY cap — which is the shape 184 argued for.
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

-- ── 6. Orphan sweep reader: re-declared off migration 191 (chain 191 → 201) ────
-- One added allow-list branch. The govehlo-web sweep (/api/hooks/storage-orphan-cleanup)
-- reads every registered path for a bucket before it deletes anything, and refuses to
-- delete at all when that read fails — so without this branch the new bucket would
-- answer 22023 forever and its cascade-orphaned objects would never be swept. Still
-- service_role only; still an allow-list CASE, never an interpolated table name.
create or replace function public.list_registered_storage_paths(
  p_table text,
  p_after text default null,
  p_limit integer default 1000
)
returns table(storage_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
begin
  -- Allow-list, never interpolate: the sweep names exactly three registered-path
  -- tables. Anything else is a caller bug and fails loudly.
  if p_table = 'fuel_payment_receipts' then
    return query
      select r.storage_path
        from public.fuel_payment_receipts r
       where r.storage_path > coalesce(p_after, '')
       order by r.storage_path asc
       limit v_limit;
  elsif p_table = 'vehicle_incident_photos' then
    return query
      select r.storage_path
        from public.vehicle_incident_photos r
       where r.storage_path > coalesce(p_after, '')
       order by r.storage_path asc
       limit v_limit;
  elsif p_table = 'vehicle_document_photos' then
    return query
      select r.storage_path
        from public.vehicle_document_photos r
       where r.storage_path > coalesce(p_after, '')
       order by r.storage_path asc
       limit v_limit;
  else
    raise exception 'Unknown registered-path table' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.list_registered_storage_paths(text, text, integer) from public;
revoke all on function public.list_registered_storage_paths(text, text, integer) from anon;
revoke all on function public.list_registered_storage_paths(text, text, integer) from authenticated;
grant execute on function public.list_registered_storage_paths(text, text, integer) to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '201_vehicle_documents',
  'Vehicle document archive (GVM-523, platform half): the workspace''s papirmappe for the shared car -- forsikringspolice, registreringsattest, synsrapport, vejhjaelpsaftale -- as titled entries with an OPTIONAL expiry date and up to five PHOTOGRAPHED pages each. PHOTOS ONLY, no PDF in v1: the phone camera is the scanner every member already has, and an upload/render/thumbnail/page-count pipeline is a whole second feature for a v1 that only has to answer "hvornaar udloeber forsikringen, og hvor staar policenummeret". TWO OWNER DECISIONS OF 2026-08-10, both written into the SQL. (1) EXPIRY SURFACING IS CLIENT-SIDE ONLY: expiry_date is a plain date column and NOTHING server-side reads it -- no push, no scheduled job, no claim_due_* RPC, no retention rule. The mobile Home health queue computes "udloeber om 14 dage" from rows it already holds, exactly as the booking/service cards do; a server-side reminder would mean a second scheduler hook, a second push key and a second notification preference for a date the group can already see. (2) HARD DELETE, NO TOMBSTONE: a document is an attachment, not an accounting row, so the five-year financial retention that governs trips/fuel/repairs has nothing to say here -- delete_vehicle_document removes the row, the photo rows cascade, and the RPC hands the caller the storage paths it must delete. TABLES: public.vehicle_documents (id, ledger_id references ledgers on delete cascade, title not null with a trimmed-non-empty + 120-char check, expiry_date nullable, created_by_member_id references ledger_members on delete set null, created_at, updated_at) and public.vehicle_document_photos (id, document_id references vehicle_documents on delete cascade, ledger_id, storage_path unique, created_by_member_id, created_at) -- vehicle_incident_photos'' shape verbatim, with ledger_id denormalized onto both for RLS exactly as migration 138 scopes incident photos. Indexes: (ledger_id, created_at desc, id) for the archive list and a PARTIAL (ledger_id, expiry_date) where expiry_date is not null for the health queue, since rows without an expiry are not in that answer at all. RLS on both: one members-read policy via is_ledger_member; every write grant revoked from public/anon/authenticated/service_role and only select granted back (the 138/169 posture), so the five SECURITY DEFINER RPCs are the only writers and service_role''s select is what lets the orphan sweep read registered paths. RPCs, all gating on is_ledger_member/is_ledger_admin themselves and resolving the actor with current_ledger_member_id (never trusted from a param), all Danish error copy: create_vehicle_document(text, text, date) files a document -- any active member may, with a per-workspace cap of 50 taken UNDER A TRANSACTION-SCOPED ADVISORY LOCK keyed on the workspace and re-counted under it (migration 184''s shape applied to a table instead of a bucket prefix), because a plain count-then-insert is a check-then-insert race in which N members filing at once all read the same sub-cap count and all pass. update_vehicle_document(uuid, text, date) and delete_vehicle_document(uuid) are gated CREATOR-OR-ADMIN, mirroring migration 138''s update_vehicle_incident rather than opening edits to any member: the person who photographed the papers is the one who knows what they say, and the admin is the escape hatch when they are gone. update is FULL-SET (title required, a NULL expiry CLEARS the date) rather than 138''s leave-null-unchanged, migration 167''s set_vehicle_location posture, because an expiry entered by mistake has to be removable without a second clear-flag argument. delete returns storage_paths as a jsonb ARRAY -- a document has several pages -- collected BEFORE the delete, since the cascade takes the photo rows with it and a caller told nothing would leave every page in the bucket. add_vehicle_document_photo(uuid, text) / delete_vehicle_document_photo(uuid) clone add_incident_photo / delete_incident_photo: any member may add a page to a document in their OWN workspace, only the uploader or a workspace admin may remove one, and the storage_path must live under the literal <ledger_id>/<document_id>/ prefix compared with left(), NOT LIKE (a ledger id can contain the ''_'' wildcard). STORAGE: private bucket vehicle-documents (5 MiB, image/jpeg|png|webp) with three storage.objects policies in migration 139''s HARDENED shape from day one -- member read below the ledger prefix, insert bound to cardinality 2 AND an existing vehicle_documents row in that ledger, delete gated to owner_id = auth.uid() or is_ledger_admin. Every storage statement sits inside the `if exists (information_schema.schemata where schema_name = ''storage'')` guard, so plain-Postgres CI replays skip the storage half entirely and it materialises ONLY in the real Supabase SQL Editor (the migration-138 lesson). The per-document object CAP is deliberately NOT a count(*) in the INSERT policy: public.enforce_storage_upload_quota() is re-declared off migration 184 (chain 184 -> 201, the GV-202 newest-prior-definition rule), byte-identical apart from a third branch (vehicle-documents, limit 5 -- a registreringsattest is two sides and a policy a couple of pages; 5 * 5 MiB = 25 MiB per document) and the two comment lines that said "two buckets", keeping the advisory-lock + recount-under-lock semantics, the LIKE prefix match and the Danish error copy intact. For this bucket that trigger is the ONLY cap, which is exactly the shape 184 argued for, so no new Pattern C exception is registered in tools/check-concurrency-hazards.mjs. The trigger is not re-bound: 184 already created enforce_storage_upload_quota_trg and it resolves the function by name. public.list_registered_storage_paths(text, text, integer) is likewise re-declared off migration 191 (chain 191 -> 201) with ONE added allow-list branch for vehicle_document_photos -- without it the govehlo-web orphan sweep (/api/hooks/storage-orphan-cleanup, GV-435) would answer 22023 for the new bucket and could never clean it, and that sweep is the only thing that removes an object whose row died in a cascade; still service_role only, still an allow-list CASE and never an interpolated table name. NO NEW event_type: filing a document writes no ledger_events row, because the archive is PULL-based -- read when somebody goes looking for the policy number -- so nothing needs classifying in FEED_VISIBLE_EVENT_TYPES or EVENT_TYPE_EXCLUDE (GV-413). The cost is accepted and named: no event means no cross-client live sync (the migration 087 lesson), so a second member sees a new document on their next refresh rather than instantly. NO CHANGE TO delete_my_account, the same deliberate deviation migration 169 documented: created_by_member_id points at the member row that delete_my_account anonymises IN PLACE (name -> ''Slettet medlem'', email -> null), so no attribution PII survives, and re-declaring a ~290-line function to null a pointer anonymisation already covers is blast radius bought for nothing. GDPR: a registreringsattest carries the owner''s NAME and ADDRESS and a policy carries a policy number -- personal data about one member photographed by another -- so minimisation is served by the shape rather than a promise: nothing uploads on its own, the bucket is private and workspace-scoped by the leading path segment, five pages per document is a hard cap, no path or signed URL appears in a URL, a query string or a log line, and processing stays in the EU. Recorded in docs/gdpr/ropa.md (A2), docs/gdpr/retention.md and docs/gdpr/deletion-limitations.md (section 6''s orphan caveat now names the third bucket). Guarded twice: tools/test-vehicle-document-contract.mjs runs in the dependency-free gate and pins the RPC-only posture, the creator-or-admin gates, the left()-prefix rule, the hardened storage policies, the 184/191 re-declaration ancestry and the absence of any ledger_events write, in BOTH the migration and the consolidated schema; tools/test-rls-role-matrix.mjs proves the behaviour against a real Postgres (create/edit/delete gates per role, wrong-prefix and foreign-workspace rejection, direct table writes denied, the returned storage_paths, and the storage.objects policies). Until the mobile half ships, the five RPCs carry dated entries in tools/role-matrix-coverage-allowlist.mjs -- the migration-first window that list exists to record. MERGE ORDER: PostgREST answers PGRST202 for a function that does not exist, so this SQL must be applied in the Supabase SQL Editor BEFORE govehlo-mobile''s GVM-523 half ships, and the govehlo-web half (EXPECTED_LATEST_MIGRATION 201 + the third bucket in the orphan sweep) must not deploy before it either.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
