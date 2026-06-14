-- Migration 006: restrict realtime use to the narrow ledger_events notification table.

-- Keep Supabase Realtime narrow: only the tiny event stream should be needed
-- for in-app notifications. Broad table Realtime remains off in the app.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'ledger_events'
     ) then
    execute 'alter publication supabase_realtime add table public.ledger_events';
  end if;
exception
  when duplicate_object then null;
  when insufficient_privilege then null;
end $$;
