-- Migration 097: tighten trips read policy to is_ledger_member (GV-176)
--
-- The trips SELECT policy shipped in migration 005 matches ledger membership by
-- email only (EXISTS on ledger_members with no is_active check), so a DEACTIVATED
-- member whose email still matches could keep reading the group's trips. Every
-- sibling read policy (car_bookings, settlement_requests, ledger_events, periods,
-- …) already uses is_ledger_member(), which additionally requires is_active — trips
-- is the one remaining loose ledger-scoped read policy. Bring it in line.
--
-- (push_subscriptions matching on email is intentional and stays: those rows are
-- self-owned per user, not ledger-scoped, so is_active does not apply.)
--
-- Found by the GV-175 equivalence audit. The consolidated schema already carried the
-- tightened form; this migration is what makes production match it.

drop policy if exists "Ledger members can read trips" on public.trips;
create policy "Ledger members can read trips" on public.trips
  for select to authenticated
  using (public.is_ledger_member(ledger_id));

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('097_tighten_trips_read_policy',
        'trips read policy uses is_ledger_member (requires is_active) instead of an email-only match, so a deactivated member whose email still matches can no longer read trips (GV-176).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
