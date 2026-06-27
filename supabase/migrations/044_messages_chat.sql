-- Migration 044: In-app messages / chat (GVM-12).
-- DRAFT — review before applying. Backs the Activity-screen chat prototype
-- (sent/received bubbles + input). Reuses the same member-scoped RLS as the
-- rest of the schema; realtime so the chat updates live (LedgerContext already
-- subscribes via Supabase channels).

-- ── Messages ──────────────────────────────────────────────────────
create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  ledger_id        text not null references public.ledgers(id) on delete cascade,
  sender_member_id uuid not null references public.ledger_members(id) on delete cascade,
  body             text not null,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create index if not exists messages_ledger_created_idx
  on public.messages (ledger_id, created_at desc)
  where deleted_at is null;

alter table public.messages enable row level security;

create policy "Ledger members can read messages" on public.messages
  for select to authenticated
  using (public.is_ledger_member(ledger_id));

-- Members may only post as themselves.
create policy "Members can send messages" on public.messages
  for insert to authenticated
  with check (
    public.is_ledger_member(ledger_id)
    and sender_member_id = public.current_ledger_member_id(ledger_id)
  );

-- Senders (and admins) may soft-delete their own messages.
create policy "Senders and admins can update messages" on public.messages
  for update to authenticated
  using (
    public.is_ledger_member(ledger_id)
    and (public.is_ledger_admin(ledger_id)
         or sender_member_id = public.current_ledger_member_id(ledger_id))
  )
  with check (
    public.is_ledger_member(ledger_id)
    and (public.is_ledger_admin(ledger_id)
         or sender_member_id = public.current_ledger_member_id(ledger_id))
  );

-- ── Per-member read state (for unread counts / the notification bell) ──
create table if not exists public.message_read_state (
  ledger_id    text not null references public.ledgers(id) on delete cascade,
  member_id    uuid not null references public.ledger_members(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (ledger_id, member_id)
);

alter table public.message_read_state enable row level security;

create policy "Members read own read-state" on public.message_read_state
  for select to authenticated
  using (
    public.is_ledger_member(ledger_id)
    and member_id = public.current_ledger_member_id(ledger_id)
  );

create policy "Members upsert own read-state" on public.message_read_state
  for insert to authenticated
  with check (
    public.is_ledger_member(ledger_id)
    and member_id = public.current_ledger_member_id(ledger_id)
  );

create policy "Members update own read-state" on public.message_read_state
  for update to authenticated
  using (
    public.is_ledger_member(ledger_id)
    and member_id = public.current_ledger_member_id(ledger_id)
  )
  with check (
    public.is_ledger_member(ledger_id)
    and member_id = public.current_ledger_member_id(ledger_id)
  );

-- ── Realtime ──────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'messages'
    ) then
      execute 'alter publication supabase_realtime add table public.messages';
    end if;
  end if;
end $$;

-- ── Register migration ────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('044_messages_chat',
        'Add messages + message_read_state tables with member-scoped RLS and realtime (GVM-12).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
