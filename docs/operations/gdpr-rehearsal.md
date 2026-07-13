# GDPR rehearsal runbook

Run this rehearsal quarterly and before a release that changes authentication,
exports, account deletion, retention, backups, or shared accounting data.

## Safety boundary

- Use an isolated Supabase project or a local Docker replay. Never rehearse with
  production users or production credentials.
- Seed only fictional people and disposable email addresses.
- Record counts and pass/fail evidence, not exported personal data or tokens.
- Account deletion is implemented by `delete_my_account()`. Full shared-workspace
  deletion is not implemented and must not be represented as available.
- Keep accounting records needed by remaining members anonymized. Do not assert
  that deletion removes shared trips, fuel, settlements, or closed-period history.

## Owners and evidence

Assign one operator and one reviewer. Save the following in the release ticket:

| Field | Value |
|---|---|
| Date and environment | |
| Mobile, web, and backend commit SHAs | |
| Operator and reviewer | |
| Export result | |
| Account-deletion result | |
| Retention preview/apply result | |
| Restore result and recovery time | |
| Follow-up issues | |

Do not attach exported JSON, access tokens, email addresses, or database dumps to
the ticket.

## 1. Establish the test environment

1. Apply every migration to the isolated project.
2. Run the repository guards:

   ```sh
   npm run validate
   npm run check:schema-equivalence
   npm run check:db-types
   npm run check:role-matrix
   npm run test:functional-smoke
   ```

3. Create two workspaces. Add the deletion subject to both, with another admin
   remaining in each workspace.
4. Seed bookings, trips, fuel, a shared expense, an open payment request, a paid
   settlement, a closed period, and an Expo push token for the deletion subject.
5. Record table row counts and the synthetic subject's identifiers. Do not place
   credentials or raw records in the evidence log.

## 2. Rehearse data portability

1. Sign in as the synthetic subject in the mobile app.
2. Open `Bilen -> Konto -> Eksporter mine data` and complete the device share
   sheet without uploading the file to a third-party service.
3. Inspect the JSON locally and verify that it is valid, identifies its schema
   version, includes both workspaces and the subject's portable records, and does
   not expose another member's email, push token, scheduler claim token, or auth
   token.
4. Verify pagination with a dataset larger than one export page.
5. Delete the local export after recording the result.

## 3. Rehearse account deletion

1. From the same account screen, complete the confirmation flow for account
   deletion.
2. Verify that the auth user can no longer sign in and that the current device is
   signed out.
3. Verify that push tokens and user-owned private profile data are removed.
4. Verify that shared accounting rows still reconcile for remaining members and
   no longer expose the deleted person's identifying profile values.
5. Verify that both workspaces remain usable by their remaining admins.
6. Verify that app-local keys prefixed with `govehlo_` or `vehloshare_` no longer
   expose the deleted session or cached personal data.
7. Run `npm run test:functional-smoke`; it is the executable regression for the
   two-workspace deletion and push-token scrub contract.

Any surviving direct identifier, usable session, push token, or broken shared
balance is a release blocker.

## 4. Rehearse retention cleanup

1. Seed expired notification events, stale push subscriptions, and old Test Lab
   reports alongside recent control rows.
2. As a ledger admin, run `preview_retention_cleanup(...)`. Record only the
   returned counts and verify that recent and accounting-critical rows are not in
   scope.
3. Run `run_retention_cleanup(...)` with the same retention values.
4. Run the preview again and verify zero remaining due rows.
5. Confirm that trips, fuel, bookings, expenses, settlement requests, closed
   periods, and audit-critical history are unchanged.

## 5. Rehearse backup restore

1. Take a backup of the isolated rehearsal project using the normal production
   backup procedure.
2. Restore it into a new isolated project, never over the source environment.
3. Record recovery time and verify the expected migration inventory.
4. Point no production client at the restored project. Use temporary local
   credentials only.
5. Run all five commands from step 1 against the restored state.
6. Verify representative balances, closed periods, memberships, and RLS access
   for an admin, a member, a non-member, and an anonymous client.
7. Destroy the restored project and all local exports after review.

## Release decision

The reviewer signs off only when all sections pass and evidence names the exact
three repository SHAs. Failed deletion, leaked identifiers, failed restore, RLS
regression, or accounting drift blocks release until fixed and rehearsed again.
