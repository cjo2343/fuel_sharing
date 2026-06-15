-- Migration 018: narrow Supabase Realtime publication to lightweight ledger events.

-- The app now uses public.ledger_events for lightweight cross-tab/cloud sync. Keeping the
-- broad public.car_share_ledgers JSON table in Supabase Realtime can make
-- realtime.list_changes dominate database time, especially when old tabs or Live Sync are open.
-- This migration removes only that broad legacy table from the Supabase Realtime publication
-- and leaves/adds public.ledger_events as the recommended Realtime table.
do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    if exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'car_share_ledgers'
    ) then
      execute 'alter publication supabase_realtime drop table public.car_share_ledgers';
    end if;

    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'ledger_events'
    ) and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'ledger_events'
    ) then
      execute 'alter publication supabase_realtime add table public.ledger_events';
    end if;
  end if;
end $$;
