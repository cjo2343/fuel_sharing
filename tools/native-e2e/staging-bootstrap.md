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

The project publishable key may be used by a future isolated QA app. A server-only
`STAGING_SECRET_KEY=sb_secret_...` will be needed for creating synthetic Auth users;
it is **not used by this installer** and must never enter a native build, logs or
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

TLS uses `verify-full` with system trust against the fixed session-pooler hostname.
If certificate verification fails, fix the trust configuration; do not disable
certificate verification to make the install pass.

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
- Subsequent read-only query confirmed the same empty state. **No hosted schema
  or synthetic accounts have been installed yet.**
- Canonical source at preparation: `origin/main` commit
  `9caf77d1de7e1cb71ee6ccc93a3154ea7ed2da21`, migration 211.
- Source SHA-256:
  `0fdfd788e43c2bb15f0885e0be17e54b937148207559917aedfaed9ebe58abe0`.
- Disposable local Postgres replay passed: 36 public tables, 211 migration
  records, latest `211_booking_edit_realtime_events`, 0 Auth users. The local
  replay stubs Supabase Auth and does not exercise hosted Storage/Realtime.

Update this record after the direct installation, with returned counts, latest
migration and source hash. Native Maestro flows, isolated app configuration and
test-user seeding remain separate work. A passing local replay is not evidence
that the hosted app or Realtime works.

## Tests

`npm run validate` includes the dependency-free target/private-file guards.
`npm run test:staging-install` uses disposable local Postgres to check failed DDL
rollback, populated-target refusal, repeated-install refusal and full canonical
schema replay inside the wrapper. It also runs in the existing functional-smoke
CI job. It does not contact hosted Supabase.
