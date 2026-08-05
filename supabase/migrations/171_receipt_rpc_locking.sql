-- Migration 171: the fuel_payments row is the LOCK ROOT for every receipt write (GV-436)
--
-- An external review of migration 169 found a TOCTOU race in both receipt RPCs. Neither
-- takes a lock, so both do read-decide-write across a window a second transaction walks
-- straight through:
--
--   • attach_fuel_payment_receipt reads fuel_payment_receipts to decide whether this is
--     a FIRST attach (open to any workspace member) or a REPLACE (uploader or admin
--     only), and then upserts. Two members attaching at the same moment BOTH read "no
--     receipt yet", BOTH pass the first-attach gate, and the second upsert overwrites
--     the first. That is not merely a lost row: the superseded storage OBJECT is deleted
--     by the caller it was handed back to as 'replaced_storage_path' — migration 138's
--     coordination, which migration 169 adopted deliberately — and the winner was told
--     nothing had been replaced. The loser's photo is left in the bucket with no row
--     pointing at it: invisible to the client, and out of reach of the settled-close
--     retention sweep, which deletes objects by joining FROM the receipt rows.
--   • detach_fuel_payment_receipt authorizes against a receipt row that a concurrent
--     attach may already have replaced. It can therefore delete a NEW uploader's receipt
--     on the strength of the OLD uploader's identity, and hand back a storage_path that
--     is no longer the one the row points at — deleting the live object and orphaning
--     the new one, the same leak from the other side.
--
-- ── THE PAYMENT ROW IS THE LOCK ROOT, NOT THE RECEIPT ROW ─────────────────────
-- Everything receipt-related serializes on public.fuel_payments, and that choice is the
-- whole migration:
--
--   1. THERE IS ALWAYS ONE. A receipt exists only for a fuel log and cascades from it,
--      so the payment row is present in every case the receipt row is — and, decisively,
--      also in the case the receipt row is NOT. The first-attach race is a race between
--      two transactions that both see NOTHING there; a lock on the receipt row cannot
--      cover it, because the thing to lock has not been created yet.
--   2. IT IS STABLE. A replace UPDATEs the receipt in place today, but what the RPCs
--      promise is "one receipt per tankning, replaceable" — and locking the object being
--      replaced is exactly how a lock silently stops protecting anything the day the
--      replace becomes delete + insert. The payment row is not the thing under
--      contention; it is the thing the contention is ABOUT.
--   3. IT IS THE SAME ROOT ON BOTH SIDES. attach and detach must exclude each other and
--      not merely their own twins, so both take the identical lock: attach through the
--      lookup it already performed, detach through one statement it did not need before.
--
-- ONE LOCK, SO THERE IS NO LOCK ORDER TO GET WRONG. Neither function takes a second row
-- lock, so no deadlock is possible between them and no ordering rule has to be
-- remembered by whoever edits them next — a transaction holds the payment row and
-- nothing else. THE RULE FOR LATER: any new receipt RPC takes this lock, and takes it
-- FIRST. The cost is that a concurrent edit of the fuel log itself waits behind an
-- attach, which is microseconds on a single-row upsert and the correct trade for a photo
-- that cannot otherwise be recovered.
--
-- ── WHAT DOES NOT CHANGE ──────────────────────────────────────────────────────
-- Both functions keep their SIGNATURE, so this is create-or-replace and not DROP +
-- CREATE: no PGRST203 window, and no client change of any kind — govehlo-mobile's
-- shipped GVM-537 calls are byte-identical before and after. Every guard, every errcode,
-- every message and every returned key is migration 169's, verbatim. detach's statements
-- are REORDERED and none of them is rewritten. No new column, no new table, no new
-- event_type, no new grant, no RLS change, no storage change, and nothing for GV-413 to
-- classify.
--
-- ── GDPR ──────────────────────────────────────────────────────────────────────
-- No new category of data, no new store, no new recipient — and a minimisation FIX
-- rather than a neutral one. A till receipt is personal data about the payer (time,
-- place, often a card tail), and the race this closes leaves one in the EU bucket with
-- no row pointing at it: beyond the client's delete, beyond the member who uploaded it,
-- and beyond the settled-close sweep that is the entire retention story for this class.
-- An orphan is stored indefinitely. Locking the payment row is what keeps "deleted at
-- settled close" true of every object rather than of most of them.

-- Register a receipt against a fuel log. Any workspace member may attach one to a
-- fuel log in their OWN workspace (the same gate migration 138 uses for incident
-- photos -- the group shares the car and the bill). The storage_path MUST live under
-- the fuel log's own <ledger_id>/<fuel_payment_id>/ prefix, so a member cannot
-- register a row that points at another workspace's or another tankning's object.
--
-- REPLACE semantics: fuel_payment_id is unique, so attaching to a fuel log that
-- already has a receipt overwrites the row. Overwriting DESTROYS somebody else's
-- attachment, so that path carries the same gate as detach -- uploader or workspace
-- admin -- while a FIRST attach stays open to any member. The superseded path comes
-- back as 'replaced_storage_path' because deleting the storage OBJECT is the caller's
-- half of the contract (migration 138's coordination, unchanged).
--
-- ── GV-436 ───────────────────────────────────────────────────────────────────
-- Re-declared off its migration 169 definition — the newest and the ONLY prior one; no
-- other migration has ever declared this function. Exactly one thing changes: the
-- fuel_payments lookup below gains `for update`. Everything else, in-body comments
-- included, is 169's text.
create or replace function public.attach_fuel_payment_receipt(
  p_fuel_payment_id uuid,
  p_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.fuel_payments%rowtype;
  v_existing public.fuel_payment_receipts%rowtype;
  v_actor_member_id uuid;
  v_expected_prefix text;
  v_receipt_id uuid;
begin
  if p_fuel_payment_id is null then
    raise exception 'Missing fuel payment id' using errcode = '22023';
  end if;

  if nullif(btrim(p_storage_path), '') is null then
    raise exception 'Missing storage path' using errcode = '22023';
  end if;

  -- GV-436: `for update` makes THIS statement the serialization point for everything
  -- below it. The payment row is the lock root for every receipt write (see the header),
  -- so a second attach -- or a detach -- waits here instead of racing the existence
  -- check further down, and the receipt read that follows is then made against a state
  -- no concurrent writer can still change.
  select * into v_payment
  from public.fuel_payments fp
  where fp.id = p_fuel_payment_id
  for update;

  if v_payment.id is null then
    raise exception 'Fuel log was not found' using errcode = '22023';
  end if;

  if v_payment.deleted_at is not null then
    raise exception 'This fuel log has been deleted' using errcode = '22023';
  end if;

  if not public.is_ledger_member(v_payment.ledger_id) then
    raise exception 'Only ledger members can attach fuel receipts' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_payment.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Path convention: <ledger_id>/<fuel_payment_id>/<uuid>.<ext>. Compare the literal
  -- prefix (no LIKE -- ledger ids can contain '_', a LIKE wildcard).
  v_expected_prefix := v_payment.ledger_id || '/' || p_fuel_payment_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) <> v_expected_prefix then
    raise exception 'Storage path must live under the fuel log''s workspace/payment prefix' using errcode = '22023';
  end if;

  select * into v_existing
  from public.fuel_payment_receipts fpr
  where fpr.fuel_payment_id = p_fuel_payment_id;

  if v_existing.id is not null and not (
    public.is_ledger_admin(v_payment.ledger_id)
    or coalesce(v_existing.uploader_member_id = v_actor_member_id, false)
  ) then
    raise exception 'Only the receipt uploader or a workspace admin can replace this receipt' using errcode = '42501';
  end if;

  insert into public.fuel_payment_receipts (
    fuel_payment_id, ledger_id, storage_path, uploader_member_id
  ) values (
    p_fuel_payment_id, v_payment.ledger_id, p_storage_path, v_actor_member_id
  )
  on conflict (fuel_payment_id) do update
  set storage_path = excluded.storage_path,
      uploader_member_id = excluded.uploader_member_id,
      created_at = now()
  returning id into v_receipt_id;

  return jsonb_build_object(
    'receipt_id', v_receipt_id,
    'fuel_payment_id', p_fuel_payment_id,
    'ledger_id', v_payment.ledger_id,
    'replaced', v_existing.id is not null,
    'replaced_storage_path',
      case
        when v_existing.id is not null and v_existing.storage_path <> p_storage_path
          then v_existing.storage_path
        else null
      end
  );
end;
$$;

revoke all on function public.attach_fuel_payment_receipt(uuid, text) from public;
revoke all on function public.attach_fuel_payment_receipt(uuid, text) from anon;
grant execute on function public.attach_fuel_payment_receipt(uuid, text) to authenticated;

-- Detach a registered receipt. Only a workspace admin or the member who uploaded it
-- may detach it -- migration 138's delete_incident_photo gate, verbatim in spirit.
-- The storage object itself is cleaned up by the client (and the storage.objects
-- delete policy gates that to the owner or a workspace admin); THIS row is the
-- authority on who may detach, and the removed path is returned so the caller knows
-- which object to delete.
--
-- ── GV-436 ───────────────────────────────────────────────────────────────────
-- Re-declared off its migration 169 definition — the newest and the ONLY prior one. The
-- statements are REORDERED and not one of them is rewritten: the receipt is read once,
-- UNLOCKED, purely to find its fuel_payments row; that row is locked; and the receipt is
-- then RE-READ so that the existence check, the uploader-or-admin gate, the delete and
-- the returned storage_path are all decided against a copy no concurrent attach can
-- still replace. Every message and errcode is byte-identical to 169's, including the
-- not-found guard now raised from two places rather than one.
create or replace function public.detach_fuel_payment_receipt(
  p_receipt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt public.fuel_payment_receipts%rowtype;
  v_payment_id uuid;
  v_actor_member_id uuid;
begin
  if p_receipt_id is null then
    raise exception 'Missing receipt id' using errcode = '22023';
  end if;

  -- GV-436, 1 of 3. An UNLOCKED read whose only job is to find the LOCK ROOT. Nothing
  -- is authorized against this copy and nothing is returned from it, because a
  -- concurrent attach may replace the receipt between this statement and the lock
  -- below; the only field taken from it is the fuel_payments id, which a replace
  -- cannot change (it is the receipt's UNIQUE key).
  select fpr.fuel_payment_id into v_payment_id
  from public.fuel_payment_receipts fpr
  where fpr.id = p_receipt_id;

  if v_payment_id is null then
    raise exception 'Fuel receipt was not found' using errcode = '22023';
  end if;

  -- GV-436, 2 of 3. The SAME lock root attach_fuel_payment_receipt takes, so the two
  -- RPCs exclude each other rather than merely their own twins. Locking the receipt row
  -- instead would be the mistake: it is the row an attach REPLACES, and a lock on the
  -- object under replacement protects nothing the day the replace stops being an
  -- in-place update.
  perform 1
  from public.fuel_payments fp
  where fp.id = v_payment_id
  for update;

  -- GV-436, 3 of 3. RE-READ under the lock, and decide EVERYTHING against this copy:
  -- existence, the uploader-or-admin gate, the delete, and the storage_path handed back
  -- for the caller to delete. If a concurrent attach replaced the receipt first, this
  -- read returns the REPLACEMENT -- so the gate judges the member who actually owns the
  -- object now, and the path returned is the one the row actually points at, instead of
  -- an already-orphaned one. The not-found guard covers the row having gone entirely.
  select * into v_receipt
  from public.fuel_payment_receipts fpr
  where fpr.id = p_receipt_id;

  if v_receipt.id is null then
    raise exception 'Fuel receipt was not found' using errcode = '22023';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_receipt.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Only ledger members can detach fuel receipts' using errcode = '42501';
  end if;

  if not (
    public.is_ledger_admin(v_receipt.ledger_id)
    or coalesce(v_receipt.uploader_member_id = v_actor_member_id, false)
  ) then
    raise exception 'Only the receipt uploader or a workspace admin can detach this receipt' using errcode = '42501';
  end if;

  delete from public.fuel_payment_receipts fpr where fpr.id = p_receipt_id;

  return jsonb_build_object(
    'receipt_id', p_receipt_id,
    'fuel_payment_id', v_receipt.fuel_payment_id,
    'ledger_id', v_receipt.ledger_id,
    'storage_path', v_receipt.storage_path
  );
end;
$$;

revoke all on function public.detach_fuel_payment_receipt(uuid) from public;
revoke all on function public.detach_fuel_payment_receipt(uuid) from anon;
grant execute on function public.detach_fuel_payment_receipt(uuid) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '171_receipt_rpc_locking',
  'The fuel_payments row is the LOCK ROOT for every receipt write (GV-436). Closes a TOCTOU race an external review found in migration 169''s two receipt RPCs, both of which did read-decide-write with no lock. attach_fuel_payment_receipt read fuel_payment_receipts to decide whether a call was a FIRST attach (open to any workspace member) or a REPLACE (uploader or workspace admin only) and then upserted, so two members attaching at the same moment BOTH read "no receipt yet", BOTH passed the first-attach gate, and the second upsert overwrote the first. THE DAMAGE IS NOT THE LOST ROW BUT THE ORPHANED OBJECT: the superseded storage object is deleted by the caller it is handed back to as replaced_storage_path (migration 138''s coordination, which 169 adopted deliberately), and the winner was told nothing had been replaced — so the loser''s photo stays in the bucket with no row pointing at it, invisible to the client AND out of reach of the settled-close retention sweep, which finds objects by joining FROM the receipt rows. detach_fuel_payment_receipt had the mirror-image hole: it authorized against a receipt row a concurrent attach may already have replaced, so it could delete a NEW uploader''s receipt on the strength of the OLD uploader''s identity and hand back a storage_path that was no longer the one the row pointed at — deleting the live object and orphaning the new one. THE FIX IS ONE LOCK ROOT FOR EVERYTHING RECEIPT-RELATED, public.fuel_payments, chosen over the receipt row for three reasons: (1) THERE IS ALWAYS ONE — a receipt exists only for a fuel log and cascades from it, so the payment row is present in every case the receipt row is and, decisively, also in the case it is NOT, which is the first-attach race between two transactions that both see nothing there; a lock on the receipt row cannot cover it because the thing to lock does not exist yet. (2) IT IS STABLE — a replace UPDATEs the receipt in place today, but what the RPCs promise is "one receipt per tankning, replaceable", and locking the object under replacement is how a lock silently stops protecting anything the day that becomes delete + insert; the payment row is not the thing under contention, it is the thing the contention is ABOUT. (3) IT IS THE SAME ROOT ON BOTH SIDES — attach and detach must exclude each other and not merely their own twins, so both take the identical lock. attach takes it through the fuel_payments lookup it already performed, now `select * into v_payment from public.fuel_payments fp where fp.id = p_fuel_payment_id for update`, which makes that statement the serialization point for the existence check, the membership gate, the prefix check, the uploader-or-admin replace gate and the upsert below it. detach is REORDERED, and not one of its statements is rewritten: it reads the receipt once UNLOCKED purely to learn its fuel_payment_id (the receipt''s UNIQUE key, which a replace cannot change), locks that fuel_payments row, and then RE-READS the receipt so that existence, the uploader-or-admin gate, the delete and the returned storage_path are all decided against a copy no concurrent attach can still replace — a caller whose receipt was replaced under it now meets the new owner''s gate and the new owner''s path instead of silently destroying them. ONE LOCK, SO THERE IS NO LOCK ORDER TO GET WRONG: neither function takes a second row lock, so no deadlock is possible between them and no ordering rule has to be remembered by whoever edits them next. THE RULE FOR LATER: any new receipt RPC takes this lock, and takes it FIRST. The cost is that a concurrent edit of the fuel log itself waits behind an attach — microseconds on a single-row upsert, and the correct trade for a photo that cannot otherwise be recovered. BOTH FUNCTIONS KEEP THEIR SIGNATURE, so this is create-or-replace rather than DROP + CREATE: no PGRST203 window and no client change of any kind, govehlo-mobile''s shipped GVM-537 calls being byte-identical before and after. Both are re-declared off their migration 169 definitions, the newest and the ONLY prior ones (no other migration has ever declared either), and every guard, errcode, message and returned key is 169''s verbatim, in-body comments included. No new column, no new table, no new event_type, no new grant, no RLS change, no storage change, and nothing for GV-413 to classify. Grants are restated exactly as 169 states them: revoke all from public and anon, grant execute to authenticated. GDPR: no new category of data, no new store and no new recipient — and a data-minimisation FIX rather than a neutral change. A till receipt is personal data about the payer (time, place, often a card tail), and an orphaned object is beyond the client''s delete, beyond the member who uploaded it and beyond the settled-close sweep that is the entire retention story for this class, i.e. stored indefinitely; locking the payment row is what keeps "deleted at settled close" true of every object rather than of most of them. Pinned by tools/test-fuel-receipt-contract.mjs, which asserts `for update` on the fuel_payments read of BOTH RPCs and detach''s lock-then-re-read ordering, in the migration and in the consolidated schema alike.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
