# Load rehearsal toolkit (GV-317)

A controlled, ~100-user load rehearsal for GoVehlo/VehloShare, run **before
TestFlight** against a **dedicated throwaway Supabase project** the operator
creates in the EU — **never against production**.

Four plain-Node scripts (no npm packages, no k6):

| Step | Script | npm script | What it does |
|---|---|---|---|
| 1 | `schema-apply.mjs` | `npm run load:schema` | Applies `supabase-schema.sql` to the throwaway project (also validates the fresh install). Run **once** per project. |
| 2 | `seed.mjs` | `npm run load:seed` | Creates ~100 auth users + ~20 workspaces of synthetic Danish fixture data through the real production RPCs. `--aged` adds one aged workspace. |
| 3 | `load.mjs` | `npm run load:run` | Drives concurrent virtual users against the app's authenticated hot paths; also has an RLS tenant-isolation probe. |
| — | `aged-local.mjs` | `npm run load:aged` | **Local, no Supabase project** (GV-438): seeds ONE aged workspace on a disposable Postgres 17 and measures how the unbounded reads scale with history. See [Aged-workspace scaling](#aged-workspace-scaling-gv-438). |

Steps 1–3 are **manual tooling** — they need a live project and are deliberately
**not** wired into `npm run validate` or CI. Live execution is done **with the
operator** once the throwaway project exists. `load:aged` needs only Docker, but
it is not in `validate` either: it takes ~90 s and it is an investigation tool,
not a per-commit gate.

---

## Why a throwaway project

The repo is the schema source of truth, and this rehearsal doubles as a
**fresh-install validation**: applying the consolidated `supabase-schema.sql` to
an empty Supabase project must succeed cleanly. It also generates real load and
real (synthetic) rows — none of which belongs anywhere near production data.

Every script runs a **hard production guard**: if the env references the
production project ref (`kdudfqzglhydmzntqosb`) in either `SUPABASE_URL` or
`DBURL`, the script refuses to run.

---

## Prerequisites

- **Node 18+** (uses global `fetch`) — the repo already targets modern Node.
- **Docker** — `schema-apply` pipes the schema through `postgres:17-alpine psql`.
- A **dedicated throwaway Supabase project in the EU** (see below).

---

## Step 0 — create the throwaway project

1. In the Supabase dashboard, create a **new project** in an **EU region**
   (e.g. `eu-north-1` / `eu-west-1`) — keep processing in the EU (GDPR).
   Give it a name like `govehlo-load-rehearsal`.
2. From **Project Settings → API**, note:
   - the project **URL** (`https://<ref>.supabase.co`),
   - the **anon** public key,
   - the **service_role** secret key.
3. From **Project Settings → Database → Connection string → Session pooler**,
   copy the connection string and put the project's database password into it.
   This is `DBURL` (host looks like `aws-0-<region>.pooler.supabase.com:5432`).

> The throwaway project's ref will differ from production — the guard only ever
> blocks the production ref, so any fresh project is allowed.

---

## Step 1 — the env file (outside the repo, chmod 600)

Create a KEY=VALUE file **outside** the repo and lock it down. Never commit it,
never place it in the repo tree.

```sh
cat > ~/govehlo-rehearsal.env <<'EOF'
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
DBURL=postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
EOF
chmod 600 ~/govehlo-rehearsal.env
```

Every script takes `--env <file>`. Required keys per script:

- `load:schema` → `DBURL`
- `load:seed` → `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `load:run` → `SUPABASE_URL`, `SUPABASE_ANON_KEY`

---

## Step 2 — apply the schema (once)

```sh
npm run load:schema -- --env ~/govehlo-rehearsal.env
```

Applies `supabase-schema.sql` with `ON_ERROR_STOP`. Not idempotent — run it once
on a fresh project. On error it prints psql's stderr; the project may be partially
applied, so delete + recreate it before retrying.

---

## Step 3 — seed the fixture

```sh
npm run load:seed -- --env ~/govehlo-rehearsal.env --seed 42 --workspaces 20
```

Flags: `--seed N` (default 42, deterministic), `--workspaces N` (default 20),
`--concurrency N` (default 4), `--email-domain <domain>` (default
`rehearsal.vehloshare.test`), `--dry-run` (build + print without any network),
`--aged` (append one aged workspace; knobs `--aged-members`, `--aged-periods`,
`--aged-trips`, `--aged-fuel`, `--aged-messages`).

**Sign-in budget.** Supabase Auth allows ~30 sign-ins per 5 minutes per IP
regardless of the dashboard setting (GVM-533 finding T4 — raising it to 300 and
restarting the project changed nothing). Each workspace costs one sign-in per
member; the aged workspace costs `--aged-members` sign-ins in total, because its
thousands of entries ride on tokens already held. Plan the run around ~30 sign-ins
per five minutes and resume rather than fight the limit.

**Seeding strategy — which write path per object:**

| Object | Path |
|---|---|
| ~100 auth users | Auth admin REST API (service role) — the only way to mint users; no production equivalent. |
| Workspace creation | **Production flow** — owner signs in (password grant) and calls `create_private_ledger_workspace`. |
| Memberships | **Production flow** — each member signs in and calls `redeem_ledger_invite` with the owner's join code (exactly like onboarding). |
| Trips, fuel, bookings, expenses, recurring, messages | **Production flow** — the acting member calls the same transactional RPCs the app uses. |
| Closed periods | **Production flow** — `calculate_period_settlement` (server) → build the matching snapshot → **request every outstanding pair at its current amount** (`upsert_settlement_request_status`) → `close_settlement_period`. |

**The request step is not optional (GV-438).** `close_settlement_period` raises
42501 — *"All settlements must be requested at their current amounts before this
period can be closed"* — unless every pair that moves money already has a
`settlement_requests` row for the period, in a requested-or-later status, at
exactly the snapshot amount. Migration 117's trigger independently recomputes that
amount server-side, so it must match to the cent. `buildCloseProgram()`
(`lib/fixtures.mjs`) is the single description of the sequence and both the hosted
seeder and the local harness walk it; the unit tests pin the ordering in both.
Before this fix the seeder reported `periods closed: 0` on every run — the GVM-533
rehearsal's T2 finding.

No service-role table inserts were needed for domain data — everything except
auth users goes through the real RPCs, so RLS + business rules are exercised end
to end. Runs are **resumable** (already-created users/workspaces are recovered via
`list_my_ledgers`) and back off on HTTP 429 to stay under free-tier rate limits.

---

## Step 4 — run the load

```sh
# read-only mix
npm run load:run -- --env ~/govehlo-rehearsal.env --vus 30 --duration 60 --mix read

# read + write mix (log trip / log fuel / post message)
npm run load:run -- --env ~/govehlo-rehearsal.env --vus 30 --duration 60 --mix mixed

# tenant-isolation probe (members reading OUTSIDE their workspaces)
npm run load:run -- --env ~/govehlo-rehearsal.env --vus 30 --rls-probe
```

Flags: `--vus N` (default 20), `--duration Ns` (default 30), `--mix read|mixed`
(default mixed), `--seed N` (must match the seed used for `load:seed`),
`--rls-probe`, `--dry-run`.

VUs sign in with the **same deterministic identities** the seed created (so no
handoff file is needed), then exercise the app's hot paths.

### Hot-path request set (mirrored from `govehlo-mobile`)

Each VU iteration mirrors `LedgerContext` + `ledger-data-gateway.ts`:

1. `rpc list_my_ledgers` — the workspace list (`resolveActiveLedgerId`).
2. The **12-query read fan-out** LedgerContext runs on every workspace load:
   `ledgers`, `ledger_members`, `settlement_periods`, `trips` (+1 truncation
   sentinel, `limit=501`), `fuel_payments` (`limit=501`), `settlement_requests`,
   `car_bookings`, `ledger_events` (reminder-audit types excluded, `limit=100`),
   `vehicle_repairs`, `messages` (`limit=200`), `workspace_expenses`,
   `recurring_expenses` — plus the dependent `trip_participants` read.
3. `rpc calculate_period_settlement` — the settlement-balance computation path.
4. **Write mix** (mixed only, ~1 in 5 iterations): `upsert_trip_with_participants`,
   `upsert_fuel_payment`, `post_message` (the feed write).

If the mobile data gateway changes, update `lib/hotpaths.mjs` — the unit tests
lock the mirror (labels, filters, limits, the event-type exclusion).

### Interpreting the results

`load:run` prints one **evidence block**:

- **Per-endpoint latency** — `p50 / p95 / p99 / max` (ms) and request count.
  Watch p95/p99 on the reads and on `calculate_period_settlement`.
- **Errors by status** — anything ≥ 400 (or `network` for transport failures).
  A healthy run shows `errors: none`. A burst of `429` means rate limiting — lower
  `--vus`. `401` means a VU's token expired/sign-in failed. `5xx` is a server-side
  problem worth investigating.
- **RLS probe** — prints `leaked rows`. **Any leaked row fails the run loudly
  (exit 1).** A pass proves cross-workspace reads return zero rows.

---

## Aged-workspace scaling (GV-438)

```sh
npm run load:aged                      # ~90 s: boot, seed, measure, probe indexes
npm run load:aged -- --dry-run         # the fixture + the exact SQL, no Docker
npm run load:aged -- --aged-periods 24 --aged-trips 300 --iters 40 --out /tmp/ex3.json
```

Exercise 1 (GVM-533) proved throughput but only ever held ~10 trips and zero closed
periods per workspace, so it could not answer GVM-535's question: the gateway's
workspace load is a fan-out of unbounded selects, and the feed and history reads
grow with **time**. `aged-local.mjs` answers it locally:

1. boots the canonical disposable Postgres 17 and applies `supabase-schema.sql`
   (a fresh-install validation in passing);
2. seeds a few small workspaces plus ONE aged workspace — 2,400 trips, ~3,000
   `ledger_events`, 1,800 messages, 11 closed periods — through the same RPCs,
   impersonating members with `request.jwt.claims` the way
   `tools/test-functional-smoke.sh` does;
3. measures the gateway's reads **as role `authenticated`, so RLS is included**, at
   a checkpoint per closed period, and again at the end with capped variants;
4. EXPLAINs the interesting plans and then creates **candidate indexes inside the
   container only** and re-measures, so "would an index help?" is answered with a
   number instead of an opinion.

It never touches `supabase/migrations/` or `supabase-schema.sql`; any index it
likes is a PROPOSAL in `docs/operations/load-rehearsal-evidence.md`. The reads it
runs are translated from `lib/hotpaths.mjs` by `lib/hotpaths-sql.mjs`, so they stay
the mirror of the mobile gateway rather than a second copy of it — the translator
throws on any filter shape it does not recognise rather than measuring something
subtly different.

Numbers are **server-side execution time**: no PostgREST, no network, so they are
not comparable with the hosted run's end-to-end latency. The scaling curve is the
evidence. Results: `docs/operations/load-rehearsal-evidence.md`.

## Dry runs (no network)

Both `seed` and `load` support `--dry-run`, which builds the fixture plan and
request payloads and prints them **without touching the network** — useful for
reviewing the request shapes and the deterministic identities before a live run.

```sh
npm run load:seed -- --dry-run --seed 42 --workspaces 20
npm run load:seed -- --dry-run --aged
npm run load:run  -- --dry-run --vus 20 --mix mixed
npm run load:run  -- --dry-run --rls-probe
npm run load:aged -- --dry-run
```

---

## Tests

Pure-logic unit tests (env parsing, prod-ref guard, deterministic fixtures, the
aged profile, the settlement-close math AND its request-then-close ordering, the
PostgREST→SQL translation, hot-path shape) — dependency-free, no Docker, no
network. Wired into `npm run validate`:

```sh
npm run test:load-rehearsal
```

---

## GDPR + teardown

- **Fixture data is entirely synthetic** — generated Danish names on a throwaway
  email domain. **No real personal data** is used at any point.
- Processing stays in the **EU** (create the throwaway project in an EU region).
- **Slet projektet, når du er færdig.** Delete the throwaway Supabase project
  from the dashboard once the rehearsal is done — that removes every synthetic
  user and row in one action. Also delete the local `--env` file.
