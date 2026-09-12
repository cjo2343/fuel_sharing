# Hosted staging bootstrap

Approved disposable project: `vehloshare-staging`,
`https://lbtvjkeyofhbuvgwywdo.supabase.co`, West EU (Ireland).
Production is a different project and is never a valid target for these tools.

## Credentials

Create an owner-only (`chmod 600`) env file **outside every Git checkout**:

```dotenv
SUPABASE_URL=https://lbtvjkeyofhbuvgwywdo.supabase.co
STAGING_DB_PASSWORD=
```

Use the raw staging database password, not a connection URL. The installer pins
the session-pooler host, database and project-qualified username verified in the
staging Connect panel. The password is passed to the disposable psql container
through its environment, never in command-line arguments or logs. Trusted local
Docker administrators can inspect container environments while they run.

The project publishable key may be used by a future isolated QA app. Add
`SUPABASE_PUBLISHABLE_KEY=sb_publishable_...` and the server-only
`STAGING_SECRET_KEY=sb_secret_...` for creating synthetic Auth users.
The secret key is **not used by the schema installer** and must never enter a native build, logs or
artifacts. Do not post credentials in chat or a PR. No GitHub secrets or schedules
are configured by these tools.

## Verify, Then Install

Docker must be running. These commands use the repo's Postgres 17 image.

```sh
npm run staging:schema -- --env /absolute/private/staging.env
npm run staging:schema -- --env /absolute/private/staging.env --apply
npm run staging:schema -- --env /absolute/private/staging.env
```

Without `--apply`, the tool only reads table/user counts and migration status.
Installation refuses existing public tables or Auth users, and rechecks inside
the transaction. An advisory lock prevents concurrent installers. The canonical
schema runs with `ON_ERROR_STOP`, a 10-second lock timeout and a 120-second
per-statement timeout. An error before commit rolls back the schema; the tool
never resets a project or retries an uncertain result automatically.

TLS uses `verify-full` against the fixed session-pooler hostname, with the
Supabase Root 2021 CA mounted read-only into this client container. The public
certificate was downloaded through the staging dashboard's Database Settings >
Download certificate on 2026-09-12, from
<https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt>.
SHA-256 fingerprint:
`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
It expires 2031-04-26. System trust alone was insufficient for this pooler.
This does not modify the host trust store. If verification fails, investigate
certificate rotation; never disable certificate or hostname verification.
See [Supabase SSL documentation](https://supabase.com/docs/guides/platform/ssl-enforcement).

If an operation times out or fails around commit, **verify without `--apply` before
retrying**. A populated project needs reviewed migrations, not another bootstrap.
The resulting schema includes the canonical demo ledger/member records but no
real users or copied production data.

The SQL Editor rejects this consolidated schema for size. `prepare-schema.mjs`
can produce an owner-only SQL file for inspection, but the hosted install should
use the direct-connection command above. Do not break it into nontransactional
chunks to fit the editor.

## Verification Record: 2026-09-12

- User confirmed this is an empty disposable test project and approved schema
  installation and synthetic account creation.
- SQL Editor preflight: 0 public tables, 0 Auth users, no migration tracker.
- SQL Editor rejected the guarded canonical script as too large.
- Subsequent read-only query confirmed the same empty state.
- Canonical source at preparation: `origin/main` commit
  `9caf77d1de7e1cb71ee6ccc93a3154ea7ed2da21`, migration 211.
- Source SHA-256:
  `0fdfd788e43c2bb15f0885e0be17e54b937148207559917aedfaed9ebe58abe0`.
- Disposable local Postgres replay passed: 36 public tables, 211 migration
  records, latest `211_booking_edit_realtime_events`, 0 Auth users. The local
  replay stubs Supabase Auth and does not exercise hosted Storage/Realtime.
- The user supplied staging credentials through the owner-only local file.
  The initial read-only connection failed CA validation; adding the certificate
  obtained from the staging dashboard fixed this without weakening TLS.
- Direct hosted installation then succeeded. An independent read-only check
  confirmed 36 public tables, 211 migrations and zero Auth users before seeding.
- Hosted access-control inspection: no public tables without RLS; three private
  buckets (`incident-photos`, `fuel-receipts`, `vehicle-documents`), nine Storage
  policies, four workspace-scoped Realtime policies and two publication tables.
  These are schema checks, not proof of runtime Realtime delivery.
- Two synthetic Auth users were created through the admin API, then signed in
  normally. Workspace creation, invitation redemption and fixture writes used
  their authenticated RPCs, not privileged table writes.
- `Native QA - Main`: QA Rikke (admin), QA Andreas (member), one ended booking.
  `Native QA - Isolation`: QA Rikke only. Both have a manual 1,000 km / half-full
  baseline, 50 L capacity and a configured 5 L/100 km estimate. No purchases,
  real receipts, telemetry or routes were fabricated.
- QA Andreas can read the shared booking and cannot read the isolation ledger.
  A complete repeat run returned the same workspace/member/period/booking IDs.
- Final read-only check at approximately 2026-09-12 11:15 UTC: 2 Auth users;
  schema remains at migration 211. No production changes; these tools did not
  request push delivery or send confirmation emails.

Native Maestro flows and isolated app configuration remain separate work. The
normal Xcode app still targets production and must **not** use these credentials.
Neither the local replay nor the hosted fixture checks prove native UI,
multi-device Realtime, push, camera or MobilePay behaviour.

## Seed or Reconcile the Native QA Fixture

```sh
npm run staging:seed -- --env /absolute/private/staging.env --state-dir /absolute/private/native-qa
npm run staging:seed -- --env /absolute/private/staging.env --state-dir /absolute/private/native-qa --apply
```

Without `--apply` this only prints the plan and makes no requests. The first apply
creates a mode-700 directory and a mode-600 `accounts.json` with random passwords
before any user creation. Keep this file for resuming and for the future native
runner. It is never committed; tokens are held only in memory. The `sb_secret_`
key is sent only to the staging Auth admin endpoints, using the `apikey` header,
not a bearer header. All domain RPCs use the publishable key plus the signed-in
user JWT. Redirects and automatic write retries are disabled.

A rerun reuses accounts/workspaces and does not reset an existing tank baseline,
recreate a deleted booking, change account passwords or overwrite tester trips.
It also refuses account-email collisions outside its own fixture marker. If
interrupted after a successful write but before its response, rerun with the same
state file to reconcile. Do not delete the state file as a reset mechanism. A
stale `seed.lock` after a killed process needs inspection before manual removal.

The initial ended booking has no route and is a one-time smoke fixture, not the
per-run data reset needed by a future repeatable Maestro journey.

## Tests

`npm run validate` includes the dependency-free target/private-file guards and
API credential-boundary, no-write resume, collision and isolation tests.
`npm run test:staging-install` uses disposable local Postgres to check failed DDL
rollback, populated-target refusal, repeated-install refusal and full canonical
schema replay inside the wrapper. It also runs in the existing functional-smoke
CI job. It does not contact hosted Supabase.
