export const STAGING_PROJECT_REF = "lbtvjkeyofhbuvgwywdo";
export const STAGING_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
// Verified in this project's Connect -> Session pooler panel.
export const STAGING_POOLER_HOST = "aws-1-eu-west-1.pooler.supabase.com";

export const STAGING_STATUS_SQL = `select json_build_object(
  'public_tables', (select count(*) from pg_tables where schemaname = 'public'),
  'auth_users', (select count(*) from auth.users),
  'migration_tracker', to_regclass('public.fuel_ledger_schema_migrations')::text
);`;

export const STAGING_INSTALLED_SQL = `select json_build_object(
  'public_tables', (select count(*) from pg_tables where schemaname = 'public'),
  'migration_count', (select count(*) from public.fuel_ledger_schema_migrations),
  'latest_migration', (select max(migration_id) from public.fuel_ledger_schema_migrations),
  'auth_users', (select count(*) from auth.users)
);`;

export function assertStagingUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid staging URL."); }
  if (url.origin !== STAGING_URL || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Refusing to target anything except the approved VehloShare staging project.");
  }
  return STAGING_URL;
}

export function buildStagingInstall(schema, projectUrl) {
  assertStagingUrl(projectUrl);
  return `-- VehloShare staging only: ${STAGING_PROJECT_REF}
-- Execute only through the staging-targeted installer, never against production.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';
do $preflight$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('vehloshare-staging-bootstrap', 0)) then
    raise exception 'Another staging install is running.' using errcode = '55P03';
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public')
     or exists (select 1 from auth.users) then
    raise exception 'Refusing schema install: this must be an empty staging database.' using errcode = '55000';
  end if;
end;
$preflight$;

${schema}

commit;
${STAGING_INSTALLED_SQL}
`;
}
