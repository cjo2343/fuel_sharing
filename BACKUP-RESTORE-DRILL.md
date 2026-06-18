# Backup and restore drill

Use this checklist as a low-risk maintenance drill. Run it after larger hardening changes, before a migration-heavy release, and at least once per quarter.

## Goal

Verify that a real backup can be exported, inspected, imported into a safe environment, and used without damaging production data.

## Rules

- Never test a restore directly against the production ledger unless you are intentionally performing an emergency restore.
- Prefer a local server or a separate Supabase test ledger/project.
- Keep exported backups out of Git.
- Treat backups as private data because they can include member names, emails, trips, fuel logs, bookings, audit history, and settings.

## Pre-drill checks

1. Confirm the current release is healthy:

   ```sh
   npm run release:check
   ```

2. Open the app and confirm the About/Admin version panel shows the expected current build label and cache.
3. In Admin diagnostics, confirm normalized tables are healthy and pending local changes are clear.
4. Confirm you know whether you are testing locally, in a staging Supabase project, or in production read-only/export mode.

## Export drill

1. In the app, open Admin -> Data tools.
2. Run the normal JSON backup/export action.
3. Save the backup file somewhere outside the repository.
4. Check the filename includes a useful timestamp or release context.
5. Open the JSON file in a text editor and verify it is valid JSON. Do not paste private backup content into chats or issues.

Optional command-line validation:

```sh
python3 -m json.tool path/to/backup.json > /dev/null
```

## Restore drill in a safe environment

1. Start the app locally or open a staging/test deployment.
2. Ensure the environment is not pointed at the production ledger unless this is an intentional emergency restore.
3. Import the backup through the app import flow.
4. Confirm the import flow exports/backs up the current state before replacement.
5. Confirm the app reloads or rerenders cleanly.

## Functional verification after restore

Check these items after importing the backup into the safe environment:

- People/member list is present.
- Group settings match expectations.
- Current trips and fuel logs are visible.
- Settlement balances look reasonable.
- Bookings are visible and linked trip/fuel status still makes sense.
- Closed periods are visible in History.
- Closed-period audit logs still appear.
- Admin diagnostics show no obvious table or sync failures.

For a stronger test, run the local browser smoke suite after restoring into a local environment:

```sh
npm run test:e2e
```

## Emergency restore outline

Use this only when production data is known to be bad and a restore is intentional.

1. Stop and document ongoing user activity if possible.
2. Export the current broken production state first.
3. Verify the backup you intend to restore is valid JSON.
4. Apply any required Supabase migrations before restoring app files or data.
5. Import the selected backup.
6. Confirm members, trips, fuel, bookings, settlements, closed periods, and audit history.
7. Run a small real-world sanity check in the app.
8. Record the restore date, backup filename, app version, and reason in `MAINTENANCE-NOTES.md` or a private operations note.

## Pass criteria

A drill passes when:

- A backup can be exported.
- The backup validates as JSON.
- The backup can be imported in a safe environment.
- Core ledger data, closed periods, bookings, and audit logs are visible after restore.
- Admin diagnostics remain healthy after the restore.

## Common failures and fixes:

- **Import rejected:** use the app validation message to identify malformed or unsupported backup shape.
- **Data appears stale after restore:** refresh once, then check Admin diagnostics and pending sync state.
- **Closed periods missing:** confirm the backup contains `closedPeriods` and was not an old partial export.
- **PWA shows old build after restore/deploy:** fully close and reopen the installed app, then check About/Admin version and cache status.
