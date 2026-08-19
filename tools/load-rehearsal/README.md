# Load rehearsal toolkit (GV-317)

A controlled, ~100-user load rehearsal for GoVehlo/VehloShare, run **before
TestFlight** against a **dedicated throwaway Supabase project** the operator
creates in the EU — **never against production**.

Four plain-Node scripts (no npm packages, no k6):

| Step | Script | npm script | What it does |
|---|---|---|---|
| 1 | `schema-apply.mjs` | `npm run load:schema` | Applies `supabase-schema.sql` to the throwaway project (also validates the fresh install). Run **once** per project. |
| 2 | `seed.mjs` | `npm run load:seed` | Creates ~100 auth users + ~20 workspaces of synthetic Danish fixture data through the real production RPCs, budgeting its sign-ins against the Auth rate limit (GV-494). `--aged` adds one aged workspace. |
| 3 | `load.mjs` | `npm run load:run` | Drives concurrent virtual users against the app's authenticated hot paths; `--realtime` adds the private-channel joins and the "Jeg er på vej" ETA/broadcast load (GV-493); also has an RLS tenant-isolation probe. |
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
  **Node 22+ for `--realtime`**, which needs the global `WebSocket`; it refuses to run
  on an older one rather than skipping the phase.
- **Docker** — `schema-apply` pipes the schema through `postgres:17-alpine psql`.
- A **dedicated throwaway Supabase project in the EU** (see below).

---

## Step 0 — create the throwaway project

1. In the Supabase dashboard, create a **new project** in an **EU region**
   (e.g. `eu-north-1` / `eu-west-1`) — keep processing in the EU (GDPR).
   Give it a name like `vehloshare-load-rehearsal`.
2. From **Project Settings → API**, note:
   - the project **URL** (`https://<ref>.supabase.co`),
   - the **anon** public key,
   - the **service_role** secret key.
3. From **Project Settings → Database → Connection string → Session pooler**,
   copy the connection string and put the project's database password into it.
   This is `DBURL` (host looks like `aws-0-<region>.pooler.supabase.com:5432`).

4. **Realtime settings → turn OFF "Allow public access to channels."** A fresh project
   has it **ON**, and production has had it **OFF** since 2026-08-12 (GVM-575). It matters
   twice: with it on, migrations 202/205/206's policies are never consulted for a public
   join, so the project is not in production's configuration; and
   `npm run probe:realtime-public-access` (step 5) correctly exits **1** against it, so the
   refusal probe cannot be evidence of anything. The `--realtime` load phase itself opens
   only PRIVATE channels and works either way — which is exactly why the switch has to be
   checked deliberately rather than inferred from a green run.

> The throwaway project's ref will differ from production — the guard only ever
> blocks the production ref, so any fresh project is allowed.

---

## Step 1 — the env file (outside the repo, chmod 600)

Create a KEY=VALUE file **outside** the repo and lock it down. Never commit it,
never place it in the repo tree.

```sh
cat > ~/vehloshare-rehearsal.env <<'EOF'
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
DBURL=postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
EOF
chmod 600 ~/vehloshare-rehearsal.env
```

Every script takes `--env <file>`. Required keys per script:

- `load:schema` → `DBURL`
- `load:seed` → `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `load:run` → `SUPABASE_URL`, `SUPABASE_ANON_KEY`

---

## Step 2 — apply the schema (once)

```sh
npm run load:schema -- --env ~/vehloshare-rehearsal.env
```

Applies `supabase-schema.sql` with `ON_ERROR_STOP`. Not idempotent — run it once
on a fresh project. On error it prints psql's stderr; the project may be partially
applied, so delete + recreate it before retrying.

**If the apply deadlocks (SQLSTATE 40P01) — exercise-3 finding T5.** The first apply
against a brand-new project can die on `deadlock detected` (observed on `create trigger
… on booking_handovers`, against a Supabase-side `AccessShareLock`: PostgREST
re-introspects the schema after every DDL, so its introspection query and our DDL take
each other's locks in opposite orders). **This is a race, not a schema error** — the same
file applies cleanly on a settled project, and the tool now says so instead of reporting a
generic failure. Because the apply is not one transaction, `public` is left half-built, so
recover before re-running, either by:

- deleting and recreating the throwaway project (slow but certain), or
- resetting `public` to its stock Supabase state from the dashboard's SQL editor — drop
  and recreate the `public` schema, then restore Supabase's standard grants and default
  privileges on it for `postgres`, `anon`, `authenticated` and `service_role` (Supabase
  documents this snippet as the project-reset SQL) — and then re-running `load:schema`.

Give the project a minute to settle before the retry; the race is much less likely once
the tenant is warm.

---

## Step 3 — seed the fixture

```sh
npm run load:seed -- --env ~/vehloshare-rehearsal.env --seed 42 --workspaces 20
```

Flags: `--seed N` (default 42, deterministic), `--workspaces N` (default 20),
`--concurrency N` (default 4), `--email-domain <domain>` (default
`rehearsal.vehloshare.test`), `--dry-run` (build + print without any network),
`--aged` (append one aged workspace; knobs `--aged-members`, `--aged-periods`,
`--aged-trips`, `--aged-fuel`, `--aged-messages`), `--signin-budget N` (default 30),
`--signin-window S` (default 300), `--state <file>` (default
`~/.vehloshare-rehearsal-seed-state.json`), `--ignore-state`.

**One pass, and it takes as long as it takes (GV-494).** A full 20-workspace seed is
~110 sign-ins. Supabase Auth allows ~30 per 5 minutes per IP regardless of the
dashboard setting (exercise-1 finding **T4** — raising it to 300 and restarting the
project changed nothing), so the seeder **budgets** those sign-ins instead of
discovering the limit: each grant takes a slot from a sliding window of
`--signin-budget` per `--signin-window` seconds, and when the window is empty the run
**pauses with a countdown** rather than firing calls that will 429. It prints the
estimate up front —

```
   sign-in plan: ~110 sign-ins at 30/300 s ≈ 15 min (4 windows)
```

— so **~15–20 minutes of mostly waiting is the expected shape of a healthy run, not a
hang.** If a 429 comes back anyway (a shared IP, another tool on the same project), every
sign-in parks for the response's `Retry-After`, or a full window when it does not say.

**Completed workspaces cost zero sign-ins on a resume.** Each workspace that finishes
cleanly is recorded in a small JSON **state file kept outside the repo** —
`~/.vehloshare-rehearsal-seed-state.json`, move it with `--state <file>` (a path inside
the repo is refused) — and the next pass skips it *before* signing anybody in. Markers are
keyed on project ref + `--seed` + email domain and carry a signature of the workspace's
planned contents, so a different project, a different seed or a changed fixture rebuilds
rather than skips; a workspace that produced any warning is **not** marked, so it is
retried. `--ignore-state` re-verifies everything the old way. The file holds no
credentials and no addresses — a project ref, a seed, workspace names and counts.

Each workspace costs one sign-in per member (one per member per **pass** — sessions are
reused); the aged workspace costs `--aged-members` sign-ins in total, because its
thousands of entries ride on tokens already held.

> This closes exercise-1 findings **T1** (no throttling → the window burnt in the first
> two workspaces, then 429s) and **T3** (every pass re-signed-in already-built workspaces,
> so retries plateaued at 10–12 of 20 across 13+ rounds). **T4 still stands** — it is the
> platform's behaviour, and it is what the default budget is set to.

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
to end. Runs are **resumable**: a workspace a previous pass completed is skipped from the
state file with no sign-in at all, anything else is recovered in place via
`list_my_ledgers`, and every request backs off on HTTP 429 to stay under free-tier limits.

---

## Step 4 — run the load

```sh
# read-only mix
npm run load:run -- --env ~/vehloshare-rehearsal.env --vus 30 --duration 60 --mix read

# read + write mix (log trip / log fuel / post message / file a document)
npm run load:run -- --env ~/vehloshare-rehearsal.env --vus 30 --duration 60 --mix mixed

# the full current-schema run: HTTP mix + private Realtime channels + "Jeg er på vej"
npm run load:run -- --env ~/vehloshare-rehearsal.env --vus 28 --duration 60 --realtime --sharers 0.2

# tenant-isolation probe (members reading OUTSIDE their workspaces)
npm run load:run -- --env ~/vehloshare-rehearsal.env --vus 30 --rls-probe
```

Flags: `--vus N` (default 20), `--duration Ns` (default 30), `--mix read|mixed`
(default mixed), `--seed N` (must match the seed used for `load:seed`),
`--realtime` (off by default), `--sharers F` (default 0.2, only with `--realtime`),
`--rls-probe`, `--dry-run`.

VUs sign in with the **same deterministic identities** the seed created (so no
handoff file is needed), then exercise the app's hot paths.

### Hot-path request set (mirrored from `govehlo-mobile`)

Each VU iteration mirrors `LedgerContext` + `ledger-data-gateway.ts`:

1. `rpc list_my_ledgers` — the workspace list (`resolveActiveLedgerId`).
2. The **12-query read fan-out** LedgerContext runs on every workspace load:
   `ledgers`, `ledger_members`, `settlement_periods`, `trips` (+1 truncation
   sentinel, `limit=501`), `fuel_payments` (`limit=501`), `settlement_requests`,
   `car_bookings`, `ledger_events` (reminder-audit types excluded, `limit=50`, GVM-535 feed cap),
   `vehicle_repairs`, `messages` (`limit=50`, GVM-535), `workspace_expenses`,
   `recurring_expenses` — plus the dependent `trip_participants` read.
3. `rpc calculate_period_settlement` — the settlement-balance computation path.
4. **Write mix** (mixed only, ~1 in 5 iterations, a cycle of 20):
   `upsert_trip_with_participants`, `upsert_fuel_payment`, `post_message` (the feed
   write), and — since GV-493 — `create_vehicle_document` + `add_vehicle_document_photo`
   (migration 201's archive; the storage UPLOAD is not rehearsed, because the object goes
   to the Storage API rather than to PostgREST). Each VU has a budget of 5 documents so a
   workspace stays under migration 201's cap of 50 **by construction** — a run that 23514s
   is a broken harness, not a finding.

If the mobile data gateway changes, update `lib/hotpaths.mjs` — the unit tests
lock the mirror (labels, filters, limits, the event-type exclusion).

### The Realtime phase (`--realtime`, GV-493)

Exercises 1 and 2 predate migrations 202–208, so they rehearsed an app that no longer
exists. Since GVM-575 every client holds an authenticated **websocket** open for as long
as a workspace is on screen, joins two **private** channels on it, and — while somebody is
on their way — broadcasts a position every 15 seconds. None of that was in the request
mix, and none of it is free: a private join costs a policy evaluation on
`realtime.messages` before a single row moves.

`--realtime` adds it, opt-in so an existing run is byte-comparable with exercise 1:

- **one websocket per VU** (the shape the client has), multiplexing
  `presence-<ledgerId>` and `ledger-changes-<ledgerId>`, both opened with
  `config.private = true` and the VU's own access token, presence keyed on its member id,
  and the same two `postgres_changes` bindings `use-ledger-realtime.ts` opens (one per
  published table — a filtered binding without a table silently delivers nothing, GVM-137);
- presence `track` plus Phoenix heartbeats for the life of the run;
- **`--sharers 0.2`** of the VUs (chosen deterministically from `--seed`) additionally run
  "Jeg er på vej": `set_on_my_way` once, an `omw-position` broadcast every 15 s with
  five-decimal fake coordinates, an ETA refresh every 5 minutes (`event_title: null`, so it
  writes the audit-only `on_my_way_updated` rather than an eighth feed entry), and
  `clear_on_my_way` at teardown.

**Why the ETA RPCs are not in the default mix.** They are one half of a feature whose
other half is the socket: the event insert IS the cross-client sync (migration 087), so
driving them with nobody subscribed measures the cheap half and rehearses none of the
risk. They also mutate a real `car_bookings.on_my_way` column, and they need a booking the
caller owns that has not ended (migration 202's gate) — per-VU setup, not a request the
loop can just fire. So they ride with `--realtime`, where the sockets that make them
meaningful are open.

**Bookings.** The fixture's bookings are anchored at 2026-07-01 and are all in the past by
now, and migration 202 refuses a share on a booking that has ended. The driver therefore
prefers a live booking the VU owns and otherwise creates one through the app's own
`upsert_car_booking`, on a day derived from the VU index so two sharers in one workspace
never collide with `prevent_overlapping_car_bookings`.

**It fails loud.** Any refused join, dead socket or sharer that could not start prints a
`REALTIME FAILURES` section and the run **exits 1**. Failures are bucketed by the
platform's own words — the same vocabulary `tools/probe-realtime-public-access.mjs` uses,
so the two tools' evidence reads together:

| reason | what it means |
|---|---|
| `Unauthorized` | migrations 202/205/206's policies refused a **member's** private join. Presence and live sync are down for real users. |
| `PrivateOnly` | a join frame lost `private: true`. Every join here sets it, so this means the harness drifted, not the project. |
| `MissingPartition` | *"Realtime was unable to find the expected messages partition"* (finding T6). Realtime's day-partition of `realtime.messages` did not exist yet — on a **fresh** project the first joins race the tenant janitor that creates them; re-run once the tenant is warm. On **production** the same string would mean a partition gap on a day roll-over; presence is cosmetic in the app, but report it. |
| `timeout` | no reply at all — project asleep, wrong URL/key, or network. |
| `other` | an unrecognised refusal, reported **with** its raw text. Never silent. |

Dependency-free like the rest of the toolkit: `node:*` plus the **global WebSocket
(Node ≥ 22)**, the same floor the GV-490 probe states. `--realtime` on an older Node
refuses to run rather than skipping the phase, because a realtime phase that quietly did
nothing is worse than no phase at all — the evidence block would still look complete.

### Interpreting the results

`load:run` prints one **evidence block**:

- **Per-endpoint latency** — `p50 / p95 / p99 / max` (ms) and request count.
  Watch p95/p99 on the reads and on `calculate_period_settlement`.
- **Errors by status** — anything ≥ 400 (or `network` for transport failures).
  A healthy run shows `errors: none`. A burst of `429` means rate limiting — lower
  `--vus`. `401` means a VU's token expired/sign-in failed. `5xx` is a server-side
  problem worth investigating.
- **RLS probe** — prints `leaked rows`. **Any leaked row fails the run loudly
  (exit 1).** A pass proves cross-workspace reads return zero rows. It covers the HTTP
  half only; the Realtime half of tenant isolation is
  `npm run probe:realtime-public-access` (GV-490), which is a different tool answering a
  different question.
- **Realtime section** (`--realtime` only) — join latency p50/p95/p99/max **per channel**,
  join failures **by reason**, presence syncs, `postgres_changes` deliveries, and
  broadcasts sent/received. `rpc:set_on_my_way` and `rpc:clear_on_my_way` are in the
  ordinary per-endpoint table, because that is what they are.

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
npm run load:run  -- --dry-run --vus 28 --realtime --sharers 0.2
npm run load:run  -- --dry-run --rls-probe
npm run load:aged -- --dry-run
```

---

## Tests

Pure-logic unit tests (env parsing, prod-ref guard, deterministic fixtures, the
aged profile, the settlement-close math AND its request-then-close ordering, the
PostgREST→SQL translation, hot-path shape, since GV-493 the Phoenix frame
vocabulary, the refusal buckets, deterministic sharer selection, the fake-position
rounding, the stats aggregation and the socket itself against an in-memory fake, and
since GV-494 the sign-in budget's timing against an injected clock, the 429 backoff,
the resume state and the `--dry-run` output) — dependency-free, no Docker, no
network. Wired into `npm run validate`:

```sh
npm run test:load-rehearsal
```

---

## The hosted run (exercise 3, part B)

`docs/operations/load-rehearsal-evidence.md` carries the full step-by-step procedure for
the next hosted run at migration 208 — including the Realtime switch above, the exact
`load:run --realtime` invocation and both probes. Its step-2 warning about budgeting around
seeder findings T1/T3 predates GV-494: **both are fixed** (see Step 3 above), so a single
seed pass should now reach all 20 workspaces — it just spends ~15–20 minutes doing it.
T4 (the dashboard's sign-in limit not taking effect) still stands. **It has not been performed and the doc's RESULTS section is a placeholder.**

## GDPR + teardown

- **Fixture data is entirely synthetic** — generated Danish names on a throwaway
  email domain. **No real personal data** is used at any point. The `omw-position`
  broadcasts carry INVENTED coordinates for invented members, rounded to five decimals in
  the same place the client rounds them; no real location is read, sent or stored, and a
  Realtime broadcast is not persisted by Supabase at all.
- Processing stays in the **EU** (create the throwaway project in an EU region).
- **Slet projektet, når du er færdig.** Delete the throwaway Supabase project
  from the dashboard once the rehearsal is done — that removes every synthetic
  user and row in one action. Also delete the local `--env` file and the seeder's
  state file (`~/.vehloshare-rehearsal-seed-state.json`) — its completion markers
  refer to a project that no longer exists.
