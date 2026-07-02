-- Migration 060: allow cancelling a reopened (open) settlement request (GV-182)
--
-- Found in real two-account testing: user A requested a payment, then reopened it
-- (settlement_requests status requested -> open). New trip/fuel data then flipped
-- the debt direction. When the now-creditor tapped Request, the settlement RPC's
-- stale-pair reconciliation (migration 054 upsert_settlement_request_status: it
-- cancels any request whose from->to pair is not in current_pair_keys) tried to
-- move that stale row open -> cancelled. But is_valid_payment_status_transition
-- (migration 003) only allowed 'cancelled' from 'requested', so the whole request
-- aborted with "Invalid settlement request status transition from open to
-- cancelled" (errcode 23514).
--
-- Recreate is_valid_payment_status_transition with ONE added edge: open ->
-- cancelled. An open request is pre-request state; a stale one must be cancellable
-- by the reconciliation. Every other edge, and the function's exact style
-- (language sql, immutable), is identical to migration 003.

create or replace function public.is_valid_payment_status_transition(p_previous_status text, p_next_status text)
returns boolean
language sql
immutable
as $$
  select case coalesce(p_previous_status, 'open')
    when 'open' then coalesce(p_next_status, 'open') in ('open', 'requested', 'cancelled')
    when 'requested' then coalesce(p_next_status, 'open') in ('requested', 'paid', 'open', 'cancelled')
    when 'paid' then coalesce(p_next_status, 'open') in ('paid', 'open')
    when 'cancelled' then coalesce(p_next_status, 'open') in ('cancelled', 'requested', 'open')
    else false
  end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('060_allow_cancel_open_request', 'allow cancelling a reopened (open) settlement request so stale-pair reconciliation can cancel it (GV-182)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
