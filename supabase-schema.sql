create table if not exists public.car_share_ledgers (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.car_share_ledgers enable row level security;

create policy "Authenticated friends can read ledgers"
on public.car_share_ledgers
for select
to authenticated
using (true);

create policy "Authenticated friends can insert ledgers"
on public.car_share_ledgers
for insert
to authenticated
with check (true);

create policy "Authenticated friends can update ledgers"
on public.car_share_ledgers
for update
to authenticated
using (true)
with check (true);

insert into public.car_share_ledgers (id, state)
values (
  'main-car',
  '{
    "currency": "DKK",
    "members": ["Christian", "Alex", "Sam"],
    "memberProfiles": {
      "Christian": { "email": "", "role": "admin" },
      "Alex": { "email": "", "role": "member" },
      "Sam": { "email": "", "role": "member" }
    },
    "trips": [],
    "fuel": [],
    "paymentStatuses": {},
    "closedPeriods": [],
    "lastOdometer": ""
  }'::jsonb
)
on conflict (id) do nothing;

-- Required for browser live updates through Supabase Realtime.
-- If this errors because the table is already in the publication, you can ignore it.
alter publication supabase_realtime add table public.car_share_ledgers;
