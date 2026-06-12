# Security hardening notes

For a fresh Supabase project, run `supabase-schema.sql`. It creates the normalized tables, helper functions, and member-restricted RLS policies used by the table-primary app.

For an existing Supabase project, run the current `supabase-schema.sql` in the SQL Editor before deploying matching app files. If Postgres reports that it cannot remove parameter defaults from `production_activity_reset(text)`, run:

```sql
drop function if exists public.production_activity_reset(text);
```

Then rerun the full schema.

## What the hardened RLS is intended to enforce

- Only active ledger members can read ledger data.
- Only ledger admins can manage members, roles, group settings, and settlement periods.
- Trips can be inserted/updated by admins, the trip creator, or the driver.
- Trip participants can be changed by admins or users who can manage the parent trip.
- Fuel payments can be inserted/updated by admins, the fuel-log creator, or the payer.
- Settlement requests can be inserted/updated by admins or the involved payer/receiver.
- Push subscriptions are scoped to the signed-in user.

## Checks before relying on real users

1. Every active real member has the correct login email in `ledger_members.email`.
2. At least one active member has `role = 'admin'`.
3. Test/generated members are inactive or removed.
4. Non-admin users can add their own trips/fuel but cannot access Admin tools.
5. Normal users cannot edit another member's trip/fuel log through the UI.
6. Settlement request, paid status, and period closing still work after refresh.
7. Browser console and Supabase logs show no RLS errors during normal flows.

Useful check:

```sql
select name, email, role, is_active
from ledger_members
where ledger_id = 'main-car'
order by is_active desc, role, name;
```

## Known remaining limitation

`car_share_ledgers` is still a compatibility JSON state table. It is broader than the normalized table RLS because the current app still relies on it for shared state/backups. The safest long-term hardening step is to complete the move to normalized-table-primary reads/writes and then restrict or retire broad JSON updates.


### Request-before-close settlement rule

Closing a settlement period now requires every calculated final payment to be requested first. Payments do not need to be marked paid before close; requested-but-unpaid payments remain visible in Payments and can be marked paid after the period is archived.


### Secure scheduled reminder endpoint

The `/api/run-reminders` endpoint now fails closed. `REMINDER_CRON_SECRET` must be configured for HTTP cron calls. If it is missing, the endpoint returns `503 Service Unavailable`; if the header/token is missing or wrong, it returns `401 Unauthorized`. Local CLI runs such as `npm run reminders:dry-run` continue to work without the HTTP secret.

Required production headers for cron calls:

```txt
X-Reminder-Secret: <same value as REMINDER_CRON_SECRET>
```

Never commit the cron secret or Supabase service role key. Store them only in Render and the cron provider.


## 2026-06-12 - Stable closed payment reminder identity

- Version `2026.06.12.21` / cache `fuel-ledger-v58` / build `booking-calendar-actions`.
- Closed-period reminders now prefer the preserved settlement `paymentKey` before generating a closed-period fallback key.
- Requested payments that are reminded while the period is open keep their repeat-window metadata after the period is closed, preventing an immediate duplicate reminder.
- Closed-period requested/unpaid payments remain eligible for future reminders after the configured repeat window.
