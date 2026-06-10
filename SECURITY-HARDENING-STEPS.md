# Security hardening notes

For a fresh Supabase project, run `supabase-schema.sql`. It now creates the normalized tables and member-restricted RLS policies used by the table-primary app.

For an older project that was upgraded through the Phase 2 migration patches, the historical `phase2*.sql` files in this repo show the migration path. They do not need to be rerun on a database that is already hardened and working.

Before relying on the app with real users, confirm:

1. Every active real member has the correct login email in `ledger_members.email`.
2. At least one active member has `role = 'admin'`.
3. Test/generated members are inactive or removed.
4. Non-admin users can add trips/fuel but cannot access Admin tools.
5. Settlement request, paid status, and period closing still work after refresh.

Useful check:

```sql
select name, email, role, is_active
from ledger_members
where ledger_id = 'main-car'
order by is_active desc, role, name;
```
