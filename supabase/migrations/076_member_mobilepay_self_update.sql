-- Migration 076: member MobilePay self-update RPC (GVM-209)
--
-- CarProfileAccountScreen let a member save their own MobilePay number via a
-- direct ledger_members UPDATE, which RLS ("Ledger admins can update members")
-- blocks for non-admins — so ordinary members could not save their number and
-- settle-up broke for them. This adds a phone-only self-update RPC (the 036
-- profile RPC requires a display name, so it cannot do a phone-only save). The
-- function updates only the caller's own active member row in the given ledger.

create or replace function public.update_own_ledger_member_mobilepay(
  target_ledger_id text default 'main-car',
  member_mobilepay_phone text default null
)
returns table (
  member_id uuid,
  ledger_id text,
  mobilepay_phone text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_member_id uuid;
  safe_phone text := nullif(btrim(coalesce(member_mobilepay_phone, '')), '');
  saved_member public.ledger_members%rowtype;
begin
  safe_member_id := public.current_ledger_member_id(target_ledger_id);
  if safe_member_id is null then
    raise exception 'Current user is not an active member of this workspace.' using errcode = '42501';
  end if;

  if safe_phone is not null and length(safe_phone) > 40 then
    raise exception 'MobilePay number is too long.' using errcode = '22001';
  end if;

  update public.ledger_members lm
  set mobilepay_phone = safe_phone,
      updated_at = now()
  where lm.id = safe_member_id
    and lm.ledger_id = target_ledger_id
  returning lm.* into saved_member;

  if saved_member.id is null then
    raise exception 'Member profile could not be updated.' using errcode = 'P0001';
  end if;

  update_own_ledger_member_mobilepay.member_id := saved_member.id;
  update_own_ledger_member_mobilepay.ledger_id := saved_member.ledger_id;
  update_own_ledger_member_mobilepay.mobilepay_phone := saved_member.mobilepay_phone;
  return next;
end;
$$;

revoke all on function public.update_own_ledger_member_mobilepay(text, text) from public;
revoke all on function public.update_own_ledger_member_mobilepay(text, text) from anon;
grant execute on function public.update_own_ledger_member_mobilepay(text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('076_member_mobilepay_self_update', 'member MobilePay self-update RPC (GVM-209)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
