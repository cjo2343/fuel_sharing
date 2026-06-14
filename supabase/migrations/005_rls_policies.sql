-- Migration 005: row-level security enablement and member/admin policies.

alter table public.car_share_ledgers enable row level security;
alter table public.ledgers enable row level security;
alter table public.ledger_members enable row level security;
alter table public.settlement_periods enable row level security;
alter table public.trips enable row level security;
alter table public.trip_participants enable row level security;
alter table public.fuel_payments enable row level security;
alter table public.car_bookings enable row level security;
alter table public.settlement_requests enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.ledger_events enable row level security;

-- Drop broad/test policies and recreate member-restricted policies.
drop policy if exists "Authenticated friends can read ledgers" on public.car_share_ledgers;
drop policy if exists "Authenticated friends can insert ledgers" on public.car_share_ledgers;
drop policy if exists "Authenticated friends can update ledgers" on public.car_share_ledgers;
drop policy if exists "Authenticated users can read ledgers" on public.ledgers;
drop policy if exists "Authenticated users can read members" on public.ledger_members;
drop policy if exists "Authenticated users can read periods" on public.settlement_periods;
drop policy if exists "Authenticated users can read trips" on public.trips;
drop policy if exists "Authenticated users can read participants" on public.trip_participants;
drop policy if exists "Authenticated users can read fuel" on public.fuel_payments;
drop policy if exists "Authenticated users can read settlement requests" on public.settlement_requests;

drop policy if exists "Ledger members can read JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger members can insert JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger members can update JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger admins can insert JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger admins can update JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger members can read ledgers" on public.ledgers;
drop policy if exists "Ledger admins can update ledgers" on public.ledgers;
drop policy if exists "Bootstrap users can update ledgers" on public.ledgers;
drop policy if exists "Ledger members can read members" on public.ledger_members;
drop policy if exists "Ledger admins can insert members" on public.ledger_members;
drop policy if exists "Ledger admins can update members" on public.ledger_members;
drop policy if exists "Ledger admins can delete members" on public.ledger_members;
drop policy if exists "Bootstrap users can read members" on public.ledger_members;
drop policy if exists "Bootstrap users can update members" on public.ledger_members;
drop policy if exists "Ledger members can read periods" on public.settlement_periods;
drop policy if exists "Ledger members can insert periods" on public.settlement_periods;
drop policy if exists "Ledger members can update periods" on public.settlement_periods;
drop policy if exists "Ledger admins can update periods" on public.settlement_periods;
drop policy if exists "Ledger members can read trips" on public.trips;
drop policy if exists "Ledger members can insert trips" on public.trips;
drop policy if exists "Ledger members can update trips" on public.trips;
drop policy if exists "Trip creators and admins can insert trips" on public.trips;
drop policy if exists "Trip creators drivers and admins can update trips" on public.trips;
drop policy if exists "Ledger members can read trip participants" on public.trip_participants;
drop policy if exists "Ledger members can insert trip participants" on public.trip_participants;
drop policy if exists "Ledger members can update trip participants" on public.trip_participants;
drop policy if exists "Ledger members can delete trip participants" on public.trip_participants;
drop policy if exists "Trip managers can insert trip participants" on public.trip_participants;
drop policy if exists "Trip managers can update trip participants" on public.trip_participants;
drop policy if exists "Trip managers can delete trip participants" on public.trip_participants;
drop policy if exists "Ledger members can read fuel payments" on public.fuel_payments;
drop policy if exists "Ledger members can insert fuel payments" on public.fuel_payments;
drop policy if exists "Ledger members can update fuel payments" on public.fuel_payments;
drop policy if exists "Fuel creators payers and admins can insert fuel payments" on public.fuel_payments;
drop policy if exists "Fuel creators payers and admins can update fuel payments" on public.fuel_payments;
drop policy if exists "Ledger members can read car bookings" on public.car_bookings;
drop policy if exists "Booking creators members and admins can insert car bookings" on public.car_bookings;
drop policy if exists "Booking creators members and admins can update car bookings" on public.car_bookings;
drop policy if exists "Ledger members can read settlement requests" on public.settlement_requests;
drop policy if exists "Ledger members can insert settlement requests" on public.settlement_requests;
drop policy if exists "Ledger members can update settlement requests" on public.settlement_requests;
drop policy if exists "Settlement parties and admins can insert settlement requests" on public.settlement_requests;
drop policy if exists "Settlement parties and admins can update settlement requests" on public.settlement_requests;

create policy "Ledger members can read JSON ledger" on public.car_share_ledgers for select to authenticated using (public.is_ledger_member(id) or public.is_ledger_bootstrap_open(id));
create policy "Ledger admins can insert JSON ledger" on public.car_share_ledgers for insert to authenticated with check (public.is_ledger_admin(id) or public.is_ledger_bootstrap_open(id));
create policy "Ledger admins can update JSON ledger" on public.car_share_ledgers for update to authenticated using (public.is_ledger_admin(id) or public.is_ledger_bootstrap_open(id)) with check (public.is_ledger_admin(id) or public.is_ledger_bootstrap_open(id));

create policy "Ledger members can read ledgers" on public.ledgers for select to authenticated using (public.is_ledger_member(id) or public.is_ledger_bootstrap_open(id));
create policy "Ledger admins can update ledgers" on public.ledgers for update to authenticated using (public.is_ledger_admin(id)) with check (public.is_ledger_admin(id));
create policy "Bootstrap users can update ledgers" on public.ledgers for update to authenticated using (public.is_ledger_bootstrap_open(id)) with check (public.is_ledger_bootstrap_open(id));

create policy "Ledger members can read members" on public.ledger_members for select to authenticated using (public.is_ledger_member(ledger_id) or public.is_ledger_bootstrap_open(ledger_id));
create policy "Ledger admins can insert members" on public.ledger_members for insert to authenticated with check (public.is_ledger_admin(ledger_id));
create policy "Ledger admins can update members" on public.ledger_members for update to authenticated using (public.is_ledger_admin(ledger_id)) with check (public.is_ledger_admin(ledger_id));
create policy "Ledger admins can delete members" on public.ledger_members for delete to authenticated using (public.is_ledger_admin(ledger_id));
create policy "Bootstrap users can read members" on public.ledger_members for select to authenticated using (public.is_ledger_bootstrap_open(ledger_id));
create policy "Bootstrap users can update members" on public.ledger_members for update to authenticated using (public.is_ledger_bootstrap_open(ledger_id)) with check (public.is_ledger_bootstrap_open(ledger_id));

create policy "Ledger members can read periods" on public.settlement_periods for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger members can insert periods" on public.settlement_periods for insert to authenticated with check (public.is_ledger_member(ledger_id));
create policy "Ledger admins can update periods" on public.settlement_periods for update to authenticated using (public.is_ledger_admin(ledger_id)) with check (public.is_ledger_admin(ledger_id));

create policy "Ledger members can read trips" on public.trips for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Trip creators and admins can insert trips" on public.trips for insert to authenticated with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or driver_member_id = public.current_ledger_member_id(ledger_id)));
create policy "Trip creators drivers and admins can update trips" on public.trips for update to authenticated using (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or driver_member_id = public.current_ledger_member_id(ledger_id))) with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or driver_member_id = public.current_ledger_member_id(ledger_id)));

create policy "Ledger members can read trip participants" on public.trip_participants for select to authenticated using (exists (select 1 from public.trips t where t.id = trip_participants.trip_id and public.is_ledger_member(t.ledger_id)));
create policy "Trip managers can insert trip participants" on public.trip_participants for insert to authenticated with check (public.can_manage_trip(trip_id));
create policy "Trip managers can update trip participants" on public.trip_participants for update to authenticated using (public.can_manage_trip(trip_id)) with check (public.can_manage_trip(trip_id));
create policy "Trip managers can delete trip participants" on public.trip_participants for delete to authenticated using (public.can_manage_trip(trip_id));

create policy "Ledger members can read fuel payments" on public.fuel_payments for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Fuel creators payers and admins can insert fuel payments" on public.fuel_payments for insert to authenticated with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or payer_member_id = public.current_ledger_member_id(ledger_id)));
create policy "Fuel creators payers and admins can update fuel payments" on public.fuel_payments for update to authenticated using (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or payer_member_id = public.current_ledger_member_id(ledger_id))) with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or payer_member_id = public.current_ledger_member_id(ledger_id)));

create policy "Ledger members can read car bookings" on public.car_bookings for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Booking creators members and admins can insert car bookings" on public.car_bookings for insert to authenticated with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or member_id = public.current_ledger_member_id(ledger_id)));
create policy "Booking creators members and admins can update car bookings" on public.car_bookings for update to authenticated using (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or member_id = public.current_ledger_member_id(ledger_id))) with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or member_id = public.current_ledger_member_id(ledger_id)));

create policy "Ledger members can read settlement requests" on public.settlement_requests for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Settlement parties and admins can insert settlement requests" on public.settlement_requests for insert to authenticated with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or from_member_id = public.current_ledger_member_id(ledger_id) or to_member_id = public.current_ledger_member_id(ledger_id) or requested_by_member_id = public.current_ledger_member_id(ledger_id)));
create policy "Settlement parties and admins can update settlement requests" on public.settlement_requests for update to authenticated using (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or from_member_id = public.current_ledger_member_id(ledger_id) or to_member_id = public.current_ledger_member_id(ledger_id) or requested_by_member_id = public.current_ledger_member_id(ledger_id))) with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or from_member_id = public.current_ledger_member_id(ledger_id) or to_member_id = public.current_ledger_member_id(ledger_id) or requested_by_member_id = public.current_ledger_member_id(ledger_id)));


drop policy if exists "Ledger members can read ledger events" on public.ledger_events;
drop policy if exists "Ledger members can insert ledger events" on public.ledger_events;
drop policy if exists "Ledger admins can delete ledger events" on public.ledger_events;
create policy "Ledger members can read ledger events" on public.ledger_events for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger members can insert ledger events" on public.ledger_events for insert to authenticated with check (public.is_ledger_member(ledger_id));
create policy "Ledger admins can delete ledger events" on public.ledger_events for delete to authenticated using (public.is_ledger_admin(ledger_id));

drop policy if exists "Users can read own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can insert own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can update own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can delete own push subscriptions" on public.push_subscriptions;
create policy "Users can read own push subscriptions" on public.push_subscriptions for select to authenticated using (lower(user_email) = public.current_user_email());
create policy "Users can insert own push subscriptions" on public.push_subscriptions for insert to authenticated with check (lower(user_email) = public.current_user_email());
create policy "Users can update own push subscriptions" on public.push_subscriptions for update to authenticated using (lower(user_email) = public.current_user_email()) with check (lower(user_email) = public.current_user_email());
create policy "Users can delete own push subscriptions" on public.push_subscriptions for delete to authenticated using (lower(user_email) = public.current_user_email());
