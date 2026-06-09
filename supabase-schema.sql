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

-- Optional: browser push notification subscriptions for installed/PWA users.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  endpoint text not null unique,
  subscription jsonb not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_email_idx on push_subscriptions (lower(email));

alter table push_subscriptions enable row level security;

drop policy if exists "Users can read their own push subscriptions" on push_subscriptions;
drop policy if exists "Users can insert their own push subscriptions" on push_subscriptions;
drop policy if exists "Users can update their own push subscriptions" on push_subscriptions;
drop policy if exists "Users can delete their own push subscriptions" on push_subscriptions;

create policy "Users can read their own push subscriptions"
on push_subscriptions
for select
to authenticated
using (lower(email) = lower(auth.jwt() ->> 'email'));

create policy "Users can insert their own push subscriptions"
on push_subscriptions
for insert
to authenticated
with check (lower(email) = lower(auth.jwt() ->> 'email'));

create policy "Users can update their own push subscriptions"
on push_subscriptions
for update
to authenticated
using (lower(email) = lower(auth.jwt() ->> 'email'))
with check (lower(email) = lower(auth.jwt() ->> 'email'));

create policy "Users can delete their own push subscriptions"
on push_subscriptions
for delete
to authenticated
using (lower(email) = lower(auth.jwt() ->> 'email'));
