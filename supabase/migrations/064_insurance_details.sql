-- Migration 064: Insurance coverage, premium & deductible + write RPC (GVM-165)
--
-- Migration 043 (GVM-11) added insurance_provider / _policy_no / _renewal but
-- shipped only a read-only stub: no entry UI ever existed, so the fields were
-- never populated for real users. This completes the Car-profile insurance card
-- to match the design prototype (coverage type + monthly premium + deductible +
-- an Active/expired status derived from the renewal date), and adds the write
-- path so an owner can actually enter and edit it.
--
-- Coverage/premium/deductible are single-value-per-car, so they live as columns
-- on the ledger row alongside the migration-043 insurance fields. The write goes
-- through a dedicated security-definer RPC (mirroring update_ledger_vehicle from
-- migration 052) so the save is admin-gated server-side and emits a ledger_events
-- row for the activity feed + operator audit trail.

-- ── New insurance columns on the ledger ───────────────────────────
alter table public.ledgers
  add column if not exists insurance_coverage        text,
  add column if not exists insurance_premium_dkk      numeric(12, 2),
  add column if not exists insurance_deductible_dkk   numeric(12, 2);

-- ── Write path: update_ledger_insurance ───────────────────────────
-- Admin-gated; updates only the fields provided (coalesce keeps the rest) and
-- emits an insurance_updated event. Follows the migration 051/052 event pattern:
-- actor via current_ledger_member_id, email via auth.jwt(), redacted metadata
-- (changed keys only — no values, GDPR data minimisation).
create or replace function public.update_ledger_insurance(
  target_ledger_id text,
  provider_value text default null,
  policy_no_value text default null,
  coverage_value text default null,
  renewal_value date default null,
  premium_value numeric default null,
  deductible_value numeric default null,
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  changed_keys text[] := array[]::text[];
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can update the insurance' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  update public.ledgers set
    insurance_provider       = coalesce(provider_value, insurance_provider),
    insurance_policy_no      = coalesce(policy_no_value, insurance_policy_no),
    insurance_coverage       = coalesce(coverage_value, insurance_coverage),
    insurance_renewal        = coalesce(renewal_value, insurance_renewal),
    insurance_premium_dkk    = coalesce(premium_value, insurance_premium_dkk),
    insurance_deductible_dkk = coalesce(deductible_value, insurance_deductible_dkk),
    updated_at = now()
  where id = target_ledger_id;

  if not found then
    raise exception 'Workspace not found' using errcode = '22023';
  end if;

  -- Record which fields the save touched (keys only, no values — GDPR data
  -- minimisation; the human-readable summary lives in event_body).
  if provider_value is not null then changed_keys := array_append(changed_keys, 'provider'); end if;
  if policy_no_value is not null then changed_keys := array_append(changed_keys, 'policy_no'); end if;
  if coverage_value is not null then changed_keys := array_append(changed_keys, 'coverage'); end if;
  if renewal_value is not null then changed_keys := array_append(changed_keys, 'renewal'); end if;
  if premium_value is not null then changed_keys := array_append(changed_keys, 'premium'); end if;
  if deductible_value is not null then changed_keys := array_append(changed_keys, 'deductible'); end if;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'insurance_updated',
      event_title,
      coalesce(event_body, ''),
      actor_member_id,
      nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('changed', to_jsonb(changed_keys))
    );
  end if;

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'event_type', 'insurance_updated'
  );
end;
$$;

grant execute on function public.update_ledger_insurance(text, text, text, text, date, numeric, numeric, text, text) to authenticated;

-- ── Register migration ────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('064_insurance_details',
        'Add insurance coverage/premium/deductible to ledgers + update_ledger_insurance RPC (GVM-165).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
