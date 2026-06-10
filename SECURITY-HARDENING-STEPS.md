# Fuel Ledger security hardening steps

Run `phase2f-security-hardening.sql` in Supabase SQL Editor only after confirming the real member emails in `ledger_members`.

## Checklist

1. In Supabase, run:

```sql
select id, ledger_id, name, email, role, is_active
from ledger_members
order by is_active desc, name;
```

2. Make sure every real member has the same email they use to log in.
3. Make sure Christian is `admin`.
4. Run `phase2f-security-hardening.sql`.
5. Log out and log in again.
6. Test:
   - add trip
   - add fuel
   - request settlement
   - close period
   - system health

## What the hardening SQL does

- Deactivates unused generated/test members.
- Adds helper functions to check whether the logged-in user is an active ledger member/admin.
- Replaces broad authenticated-user policies with member-only policies.
- Keeps roster/settings changes admin-only.
- Keeps trip/fuel/settlement-period actions available to active ledger members so the current app continues to work.
- Restricts push subscriptions to the logged-in user's own email.

## Important rollback note

If you lock yourself out, run this in Supabase SQL Editor to temporarily reopen access while fixing member emails:

```sql
drop policy if exists "Ledger members can read JSON ledger" on car_share_ledgers;
drop policy if exists "Ledger members can insert JSON ledger" on car_share_ledgers;
drop policy if exists "Ledger members can update JSON ledger" on car_share_ledgers;

create policy "Temporary authenticated read JSON ledger"
on car_share_ledgers for select to authenticated using (true);

create policy "Temporary authenticated insert JSON ledger"
on car_share_ledgers for insert to authenticated with check (true);

create policy "Temporary authenticated update JSON ledger"
on car_share_ledgers for update to authenticated using (true) with check (true);
```

Then fix `ledger_members.email` and rerun the hardening script.
