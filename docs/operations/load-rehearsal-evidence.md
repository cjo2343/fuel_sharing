# Load rehearsal evidence — 2026-08-03 (GVM-533 / GV-317)

One controlled load rehearsal against a **throwaway EU Supabase project** (deleted
after the run, together with the credentials file). Fresh install of all 166
migrations validated cleanly before seeding. Never rehearse against production;
`tools/load-rehearsal/` hard-guards the production project ref.

## Fixture

- Seeder: `npm run load:seed` (seed=42, concurrency=4, resumable), 103 auth users.
- **12 of 20 workspaces fully built** (~60 members joined, 121 trips, 57 fuel
  payments, expenses/recurring/bookings/messages per workspace). The remaining 8
  never completed — see finding T1/T3 below; the blocker was the Auth sign-in rate
  limit, not the database.

## Load run (mixed read/write)

`npm run load:run -- --vus 28 --duration 60` → 27 VUs signed in (one lost to the
sign-in rate limit), 60.5 s sustained:

- **19,741 requests, 326 req/s, zero errors** (all responses < 400).
- Reads (13 endpoints, unbounded per-workspace selects): p50 ≈ 180–240 ms,
  **p95 ≈ 550–670 ms, p99 ≈ 1.0–1.2 s**, max ≈ 2.5 s.
- `rpc:calculate_period_settlement`: p50 193 ms / p95 521 ms / p99 1176 ms at
  1,298 calls — the settlement engine holds under full mixed load.
- Writes (`upsert_trip_with_participants`, `upsert_fuel_payment`, `post_message`):
  p95 ≈ 380–580 ms, max < 760 ms.

27 concurrent virtual users is far above the realistic concurrency of ~100 real
users spread across small groups, so this run brackets launch scale with margin.

## RLS tenant-isolation probe

`node tools/load-rehearsal/load.mjs --rls-probe`: 20 members × 6 foreign tables =
**120 cross-workspace checks, 0 leaked rows.** PASSED.

## Verdict: the unbounded workspace loads (GVM-533's question)

The mobile client's workspace reads are unbounded selects, but they are bounded in
practice by workspace size, and at 27 VUs they held p95 < 700 ms with zero errors.
**No pagination is needed before launch.** The one surface that is unbounded over
*time* rather than by workspace size is the activity feed (`ledger_events` +
`messages`), which only grows; a fetch cap/pagination there is ticketed separately
(GVM-535) with this run as its baseline, not a launch blocker. **Exercise 2 below
measured exactly that surface against an aged workspace and the answer moved:** the
feed is not the read that degrades — `trips` is.

## Tooling findings (for the next rehearsal)

- **T1 — seeder needs sign-in throttling/backoff.** Workspace building signs in
  ~5 members per workspace; a full pass needs ~110 sign-ins against a 30/5 min
  per-IP Auth limit. Rounds 429 out mid-pass.
- **T2 — seed close-period flow predates migration 141.** Period close now
  requires all settlements requested at current amounts (42501). The seeder's
  close step always fails; harmless for load evidence, wrong as a fixture claim
  (`periods closed: 0`). **FIXED in GV-438** — see exercise 2 below.
- **T3 — resumable seed re-signs-in already-built workspaces.** Each retry pass
  spends most of the rate budget re-verifying built workspaces before reaching
  unbuilt ones, so retry loops plateau (observed: stuck at 10–12 of 20 across 13+
  rounds). Skipping sign-ins for complete workspaces fixes T1's plateau half.
- **T4 — operational gotcha, not ours:** raising "Rate limit for sign-ups and
  sign-ins" in the Supabase dashboard (30 → 300) did **not** take effect, even
  after saving (helper text updated) and a full project restart. Probed
  empirically at exactly ~30/5 min throughout. Plan-level cap or platform bug;
  budget rehearsals around the default limit rather than assuming the dashboard
  value.

## Cleanup (owner)

1. Delete the throwaway Supabase project.
2. `rm ~/govehlo-rehearsal.env`.

---

# Load exercise 2 — 2026-08-08 (GV-438): the AGED workspace

Follow-up to the external review of exercise 1. That run proved throughput but its
fixture was 12 **small** workspaces, ~10 trips each, and **zero closed periods**, so
it could not answer the question GVM-535 inherited: the mobile client's workspace
load is a fan-out of unbounded selects, and the feed and history reads grow with
**time** rather than with group size. At what history size does that hurt, what
fetch limit makes sense, and would an index help?

## What was fixed first: the seeder's period close (T2)

`close_settlement_period` (migration 141, off the 117/098 lineage) refuses to close
a period unless **every settlement pair that moves money already has a
`settlement_requests` row for that period**, in a requested-or-later status, at
**exactly** the snapshot amount:

> All settlements must be requested at their current amounts before this period can
> be closed. — 42501

The seeder never requested anything, so its close step failed on every workspace and
the fixture always reported `periods closed: 0`. `buildCloseProgram()`
(`tools/load-rehearsal/lib/fixtures.mjs`) now expresses the required sequence as
data — the snapshot, the ordered list of `upsert_settlement_request_status` calls,
then the close — and both the hosted seeder (`seed.mjs`, over HTTP) and the local
harness walk the same program. Amounts come from the server's own nets via the same
greedy pairing migration 117's trigger recomputes, so they agree to the cent, and a
failed request aborts the close instead of falling through to it. Unit tests pin the
ordering in both drivers (`npm run test:load-rehearsal`, in `npm run validate`).

Result: **11 closed periods and 55 settlement requests** in this run's aged
workspace, all through the real RPCs. `periods closed: 0` is gone.

## Harness — and why the numbers are not comparable to exercise 1

`npm run load:aged` (`tools/load-rehearsal/aged-local.mjs`). Building an aged
workspace over HTTP costs ~5,000 authenticated writes and a fresh throwaway project,
and the question is a database question that per-request network noise hides. So
exercise 2 runs on a **disposable Postgres 17 container** (the canonical replay
image): `supabase-schema.sql` applied fresh (0.5 s, clean), seeded through the SAME
production RPCs with members impersonated via `request.jwt.claims`, and measured as
role **`authenticated` with RLS applied**.

**Error rate: zero.** Every statement runs under `ON_ERROR_STOP=1` and every psql
exit code is checked, so a single failed RPC, read or close aborts the whole run —
the numbers below only exist because ~4,700 seeding RPC calls, 11 period closes and
~1,400 measured reads all succeeded.

What is measured is therefore **server-side execution time** — no PostgREST, no
network, no TLS. Exercise 1's 180–240 ms p50 reads included all of that; these
single-digit-millisecond numbers do not. **Do not compare the absolutes.** The
evidence here is the *scaling curve* and the *query plans*, both of which exercise 1
could not produce at all. The reads themselves are translated from
`lib/hotpaths.mjs` (the mobile-gateway mirror) by `lib/hotpaths-sql.mjs`, which
throws rather than guess on any filter shape it does not recognise.

## Fixture

`npm run load:aged -- --small 3 --iters 30`, seed 42, deterministic:

- 3 small workspaces (as before) **+ 1 aged workspace**, seeded in 30 s;
- aged: 6 members, **12 periods (11 closed), 2,400 trips, 2,955 `ledger_events`,
  1,800 messages, 360 fuel payments, 72 bookings, 48 expenses, 55 settlement
  requests** — roughly two years of a busy shared car.

## Per-read latency at full aged size (30 iterations, RLS applied, ms)

| read | rows | p50 | p95 | capped variant | p95 |
|---|---|---|---|---|---|
| `read:trips` | 501 | 27.35 | **27.93** | `@100` | **28.84** (cap does not help) |
| `read:participants` | 703 | 56.85 | **60.66** | `@100 ids` | **61.04** (cap does not help) |
| `read:fuel` | 360 | 4.24 | 4.51 | — | — |
| `read:messages` | 200 | 2.36 | 2.40 | `@50` | 0.68 |
| `read:events` (feed) | 100 | 1.25 | **1.31** | `@30` | 0.47 |
| `read:bookings` | 72 | 1.00 | 1.01 | `@50` | 1.35 |
| `read:settlements` | 55 | 0.74 | 0.75 | `@50` | 1.01 |
| `read:periods` (history) | 12 | 0.22 | 0.24 | `@6` | 0.35 |
| `read:expenses` | 48 | 0.66 | 0.68 | — | — |
| `read:members` / `read:ledger` / `read:recurring` / `read:repairs` | ≤6 | ≤0.18 | ≤0.35 | — | — |
| **proposed shape** `read:trips` scoped to the open period | 200 | 2.67 | **2.80** | — | — |

## Growth curve (one closed period per checkpoint)

| events | messages | trips | closed | feed p95 | trips p95 | history p95 |
|---:|---:|---:|---:|---:|---:|---:|
| 246 | 150 | 200 | 1 | 2.88 | 2.66 | 0.12 |
| 726 | 450 | 600 | 3 | 1.29 | 8.18 | 0.14 |
| 1,206 | 750 | 1,000 | 5 | 1.30 | 13.99 | 0.42 |
| 1,686 | 1,050 | 1,400 | 7 | 1.35 | 19.18 | 0.21 |
| 2,166 | 1,350 | 1,800 | 9 | 1.32 | 21.12 | 0.60 |
| 2,646 | 1,650 | 2,200 | 11 | 1.27 | 32.44 | 0.25 |
| 2,880 | 1,800 | 2,400 | 11 | 1.31 | 34.14 | 0.27 |

**The feed is flat. The trips read is linear in workspace history** — ~13× from 200
to 2,400 trips — and it drags the dependent `trip_participants` read with it.

## What the plans say

- **`read:events` (the feed) is fine.** `ledger_events_ledger_created_idx` serves the
  ordering, so the plan is an ordered Index Scan that stops at the limit: cost tracks
  the LIMIT, not the workspace's history. This is why `@30` saves only 0.8 ms.
- **`read:trips` is the problem.** `trips` has no `(ledger_id, trip_date)` index — the
  only ledger-scoped index is `trips_ledger_id_legacy_id_key`, whose second column is
  the wrong one — so the plan Seq Scans every trip, evaluates the RLS predicate on
  each, then top-N sorts (36,422 shared buffer hits for 501 returned rows). The LIMIT
  is applied last, which is exactly why capping it changes nothing.
- **`read:participants` is the most expensive single read and no index fixes it.** Its
  RLS policy (`exists (select 1 from trips t where t.id = trip_participants.trip_id
  and is_ledger_member(t.ledger_id))`) plans as a **hashed SubPlan that Seq Scans the
  whole `trips` table** evaluating `is_ledger_member` per row (72,465 buffers). Its
  cost therefore grows with the number of trips **across all workspaces**, not with
  this workspace, and shortening the id list is irrelevant (703 ids → 60.66 ms, 353
  ids → 61.04 ms).
- **`read:periods` (history) is a Seq Scan** — `settlement_periods` has no `ledger_id`
  index at all — but the table holds 17 rows here, so it costs 0.24 ms and the planner
  correctly ignores a candidate index. Same platform-wide caveat as above: the RLS
  predicate is evaluated per row of the whole table.
- **Stale statistics flip the feed to the bad plan.** Before the harness started
  running `analyze` after each seeding phase, the feed read planned as a Bitmap Heap
  Scan over *every* event plus a top-N sort and measured **25–75 ms**, growing
  linearly — the exact degradation GVM-535 fears. Production autovacuum makes that a
  transient state, but it is real after a bulk import or a restore.

## Candidate indexes — measured, PROPOSED, **not applied**

Created **inside the container only**, after the baseline numbers, then re-measured.
No migration was written and `supabase/migrations/` + `supabase-schema.sql` are
untouched by GV-438.

| candidate | Δ p95 |
|---|---|
| `create index trips_ledger_trip_date_idx on public.trips (ledger_id, trip_date desc) where deleted_at is null;` | `read:trips` **27.93 → 6.08 ms**; `read:trips@100` **28.84 → 1.66 ms** |
| `create index ledger_events_feed_idx on public.ledger_events (ledger_id, created_at desc) where event_type not in ('payment_reminder_sent','close_reminder_sent','booking_completion_reminder_sent','weekly_digest_sent','booking_fuel_reminder_sent','confirm_reminder_sent');` | 1.31 → 1.33 ms (no gain today; it is insurance against the stale-stats plan flip, and its predicate must be kept in step with `EVENT_TYPE_EXCLUDE`) |
| `create index fuel_payments_ledger_payment_date_idx on public.fuel_payments (ledger_id, payment_date desc) where deleted_at is null;` | 4.51 → 4.63 ms (not chosen at 360 rows; same shape as the trips fix, and the same fate awaits it at 2,000+ fuel rows) |
| `create index settlement_periods_ledger_opened_idx on public.settlement_periods (ledger_id, opened_at desc);` | 0.24 → 0.24 ms (not chosen; 17-row table) |

## Recommendation for GVM-535

1. **A feed cap is not the scaling fix — the feed is already index-served and flat**
   (1.3 ms at 2,955 events, unchanged across the whole curve). Cap it anyway if the
   client wants a smaller first paint: **50 events + 50 messages**, with "load more",
   costs 0.47 + 0.68 ms instead of 1.31 + 2.40 and cuts the payload by roughly 4×.
   That is a render/payload decision, not a database one, and **not a launch
   blocker**.
2. **The read that actually degrades is `trips`, and the fix is the index, not a
   limit.** It crosses 10 ms at ~800 trips and 30 ms at ~2,200, and a `limit 100`
   changes nothing because the LIMIT is applied after the scan and the sort. Adopt
   `trips_ledger_trip_date_idx` (exact DDL above) — 4.6× on the current read, 17× once
   a cap is added on top. A workspace reaches ~1,000 trips after roughly a year of
   daily driving, so this is worth a migration before the first cohort gets there,
   not urgently today.
3. **Scope the trips fetch to the open period.** `period_id=eq.<open period>` measures
   **2.80 ms with no index at all** versus 27.93, because it is the only period the
   settlement split needs. Keep the 501-row `SETTLE_ROW_CAP` sentinel for that read
   and paginate the *history* list separately — that split is the single biggest win
   available to the client, and it needs no schema change.
4. **`trip_participants` needs a policy fix, not a cap** — 60 ms, unaffected by both
   the index probe and a halved id list, because its RLS subplan scans all trips
   platform-wide. Worth its own ticket; it will be the top cost on the workspace load
   once (2) and (3) land.
   *Shipped as GV-465 / migration 192*: `ledger_id` denormalized onto the table (the
   138/169 pattern) so the policy is `is_ledger_member(trip_participants.ledger_id)`.
   Re-measured on this harness: p95 **58.49 → 8.81 ms** (703 rows; the 353-id probe
   61.04 → 4.68 ms), buffers 72,594 → 11,087, and cost now tracks the workspace's own
   rows. A `can_read_trip(trip_id)` helper shape was measured first and rejected — it
   killed the platform scan but kept ~80 µs/row of function overhead (58 ms).
5. **`settlement_periods` and `fuel_payments` ledger-scoped indexes are not warranted
   by measurement today.** Both plans are cheap at current row counts. Revisit
   `settlement_periods` when the platform passes a few thousand periods — its Seq Scan
   cost is shared across every workspace's history read.

## Reproducing

```sh
npm run load:aged                 # ~90 s, Docker only, deletes its own container
npm run load:aged -- --dry-run    # the fixture + the exact SQL, no Docker
npm run load:aged -- --aged-periods 24 --aged-trips 300 --iters 40 --out /tmp/ex3.json
```

The hosted rehearsal is unchanged and still the right harness for end-to-end latency
and the RLS tenant-isolation probe; `npm run load:seed -- --aged` now seeds the same
aged workspace there when a throwaway project is available. Budget the sign-in limit
(~30 per 5 min per IP, whatever the dashboard says — finding T4 stands).

---

# Load exercise 3 — 2026-08-18 (GV-493), part A: local aged workspace at migration 208

Exercises 1 (2026-08-03, hosted) and 2 (2026-08-08, local) both predate migrations
**202–208**, and the external review of 2026-08-12 asked for the rehearsal to be re-run
at the current schema with the things those migrations added: private Realtime channels,
the "Jeg er på vej" ETA writes, the GVM-587 position broadcast, and the vehicle document
archive.

That is two exercises, not one, and they need different harnesses:

- **Part A (this section)** — the schema half, on the local Docker harness. It re-runs
  exercise 2's measurement at migration 208 and answers "did anything the last six
  migrations added move the reads?".
- **Part B (below)** — the hosted half: end-to-end latency, the private-channel joins,
  the ETA/broadcast load and the two probes. It needs a throwaway Supabase project the
  owner creates. **It has not been run. There are no numbers for it in this document and
  none may be invented.**

## Harness — unchanged, which is itself a finding

`npm run load:aged -- --small 3 --iters 30`, seed 42, same knobs exercise 2 used. **No
change to `aged-local.mjs` was needed**: `supabase-schema.sql` applied cleanly in 1.0 s
(fresh-install validation in passing), and all ~4,700 seeding RPC calls, the 11 period
closes and ~1,400 measured reads succeeded under `ON_ERROR_STOP=1`. **Error rate: zero.**

Two things could plausibly have broken it and did not:

- **Migration 207's `enforce_on_my_way_rpc_only_trg`** fires `before insert or update of
  on_my_way on car_bookings`, so **every booking INSERT reaches it** — a column list
  narrows UPDATE only. The seeder creates 72 bookings through `upsert_car_booking` and
  none was refused, because the trigger's first branch returns early for
  `tg_op = 'INSERT' and new.on_my_way is null`, which is exactly what a booking RPC
  writes.
- **Migration 201's storage half** is inside the
  `information_schema.schemata where schema_name = 'storage'` guard, so the plain-Postgres
  replay skips it (the migration-138 lesson holding, as designed).

Same caveat as exercise 2 and for the same reason: these are **server-side execution
times** with no PostgREST, no network and no TLS. Do not compare them with exercise 1's
end-to-end numbers.

## Fixture (identical to exercise 2)

3 small workspaces + 1 aged workspace: 6 members, **12 periods (11 closed), 2,400 trips,
2,955 `ledger_events`, 1,800 messages, 360 fuel payments, 72 bookings, 48 expenses, 55
settlement requests.**

## Per-read latency at full aged size (30 iterations, RLS applied, ms)

| read | rows | p50 | p95 | exercise 2 p95 | moved? |
|---|---|---|---|---|---|
| `read:participants` | 703 | 14.74 | **15.22** | 8.81 *(post-192 re-measure)* | host offset — see below |
| `read:trips` | 501 | 10.89 | **11.13** | 27.93 | **YES — migration 190's index** |
| `read:fuel` | 360 | 8.03 | 8.22 | 4.51 | host offset |
| `read:messages` | 50 | 3.06 | 3.18 | 2.40 | host offset |
| `read:events` (feed) | 50 | 1.76 | **1.78** | 1.31 | host offset; still flat |
| `read:bookings` | 72 | 1.71 | 1.83 | 1.01 | host offset |
| `read:settlements` | 55 | 1.36 | 1.39 | 0.75 | host offset |
| `read:expenses` | 48 | 1.10 | 1.11 | 0.68 | host offset |
| `read:periods` (history) | 12 | 0.39 | 0.41 | 0.24 | host offset |
| `read:ledger` / `read:members` / `read:recurring` / `read:repairs` | ≤6 | ≤0.30 | ≤0.32 | ≤0.35 | — |
| `read:trips@100` | 100 | 2.39 | **2.44** | 28.84 | **YES — same index** |
| `read:participants@100` | 353 | 8.02 | 8.11 | 4.68 | host offset |
| `read:trips@period` (proposed shape) | 200 | 4.53 | 4.57 | 2.80 | host offset |

### Which numbers moved, and why

**One read moved for a schema reason, and it is `trips`.**

- `read:trips` **27.93 → 11.13 ms p95**, and `read:trips@100` **28.84 → 2.44 ms**. This is
  exercise 2's recommendation (2) landing: `trips_ledger_trip_date_idx` graduated from
  candidate to schema in **migration 190**, and the plan changed with it — exercise 2 saw
  a Seq Scan over every trip plus a top-N sort (36,422 buffers for 501 rows), this run
  sees `Index Scan using trips_ledger_trip_date_idx` + an Incremental Sort (8,243
  buffers). The cap now works, too: capping at 100 is a 4.6× saving where in exercise 2 it
  was worth nothing, because the LIMIT is no longer applied after a full scan and sort.
- **Everything else is a HOST OFFSET, not a schema effect.** Every other read moved up by
  a similar factor (1.4×–1.8×) and **no plan changed**: `read:events` is still an ordered
  Index Scan on `ledger_events_ledger_created_idx` stopping at the limit, `read:periods` is
  still a Seq Scan of a 17-row table, and `read:participants` still plans as a Bitmap Heap
  Scan on `trip_participants_pkey` with `is_ledger_member(trip_participants.ledger_id)` as
  a cheap per-row filter — **11,101 shared buffers against the 11,087 exercise 2 recorded
  after migration 192**. Identical work, different wall clock: this run booted Docker cold
  on a different machine state. The doc's standing rule applies to itself — compare the
  curve and the plans, not the absolutes.
- **The feed is still flat**, now with a longer exclusion list: migration 202 appended
  `on_my_way_updated` and `on_my_way_stopped` to `EVENT_TYPE_EXCLUDE` (8 types, not 6), and
  the read still costs 1.78 ms at 2,955 events. The extra predicate is free.
- **No new index is warranted.** All three candidates were re-measured in-container after
  the baseline and none earned a migration: `ledger_events_feed_idx` 1.78 → 1.83,
  `fuel_payments_ledger_payment_date_idx` 8.22 → 8.26,
  `settlement_periods_ledger_opened_idx` 0.41 → 0.42. The feed index IS chosen by the
  planner once it exists (the EXPLAIN switches to it) and still buys nothing — exactly
  exercise 2's finding, and its value remains insurance against the stale-statistics plan
  flip rather than throughput.

## Growth curve (one closed period per checkpoint)

| events | messages | trips | closed | feed p95 | trips p95 | history p95 | msgs p95 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 246 | 150 | 200 | 1 | 4.78 | 4.53 | 0.23 | 3.07 |
| 486 | 300 | 400 | 2 | 10.07 | 10.67 | 0.32 | 5.81 |
| 726 | 450 | 600 | 3 | 5.56 | 19.40 | 0.37 | 3.64 |
| 966 | 600 | 800 | 4 | 5.54 | 18.59 | 0.31 | 4.53 |
| 1,206 | 750 | 1,000 | 5 | 5.39 | 22.60 | 0.30 | 3.46 |
| 1,446 | 900 | 1,200 | 6 | 5.40 | 25.70 | 1.06 | 3.52 |
| 1,686 | 1,050 | 1,400 | 7 | 5.74 | 40.50 | 0.80 | 3.91 |
| 1,926 | 1,200 | 1,600 | 8 | 5.96 | 43.28 | 0.45 | 3.81 |
| 2,166 | 1,350 | 1,800 | 9 | 5.15 | **10.63** | 0.38 | 3.16 |
| 2,406 | 1,500 | 2,000 | 10 | 5.15 | 11.13 | 0.40 | 3.18 |
| 2,646 | 1,650 | 2,200 | 11 | 5.08 | 11.74 | 0.43 | 3.16 |
| 2,880 | 1,800 | 2,400 | 11 | 5.36 | 11.07 | 0.42 | 3.08 |

**The trips curve no longer diverges.** In exercise 2 it climbed monotonically to 34 ms at
2,400 trips; here it climbs to 43 ms at 1,600 and then **falls back to ~11 ms and stays
there** as the workspace doubles again. That shape is a **planner flip** — below ~1,800
trips the planner still prefers the scan-and-sort, above it the new index — not a data
effect. Caveat, stated rather than glossed: the harness only EXPLAINs at the END of the
run, so the checkpoint plans were not captured and the flip point is inferred from the
final plan plus the discontinuity. If the exact crossover ever matters, `--out` the
evidence and add per-checkpoint EXPLAINs; nothing about the launch verdict depends on it.

## Verdict for part A

**Nothing migrations 201–208 added shows up in the workspace read fan-out, and the one
read exercise 2 flagged as degrading has been fixed by the migration exercise 2 asked
for.** The remaining top cost is `read:participants` at ~15 ms, whose plan is already the
cheap one (migration 192) and whose absolute number here is a host artefact. No new index
is warranted by measurement. **No schema work falls out of part A.**

What part A cannot see, by construction: PostgREST, TLS, connection setup, the Realtime
service, RLS on `realtime.messages`, and every per-connection cost of a member holding a
socket open. That is entirely part B's job.

---

# Load exercise 3, part B: the HOSTED run — procedure

**RESULTS: recorded 2026-08-19 — see [§ RESULTS](#results) at the end of this section.**
Run against a throwaway EU project (`eu-west-1`, Postgres 17.6) created for the purpose
and deleted afterwards with its credentials file. Steps 0–5 below are the procedure that
was followed; the numbers live only under RESULTS.

## Step 0 — the project, and the ONE switch that must be flipped

Create a throwaway project in an **EU region** (GDPR) and follow
`tools/load-rehearsal/README.md` steps 0–1 for the env file.

Then, before anything else: **Realtime settings → turn OFF "Allow public access to
channels."**

This is not optional and it is not the same as the RLS policies. A **fresh Supabase
project has public access ON by default.** With it on, migrations 202/205/206's policies
are never consulted for a public join, so:

- the **private** joins the load phase makes still succeed, and the load numbers are still
  valid — but they are measuring a project in a configuration production is not in; and
- the **refusal probe is not evidence at all**. `npm run probe:realtime-public-access`
  exists to prove that a PUBLIC join is refused (GV-490). Against a project with the
  switch on, it exits **1** and reports the hole — correctly. A green probe requires the
  switch off first.

Production had this switched off on 2026-08-12 (GVM-575) and it is attested in
`docs/release-attestations.json` → `realtime_public_access_closed`. The throwaway must
match it or the rehearsal is not rehearsing production.

## Step 1 — schema

```sh
npm run load:schema -- --env ~/vehloshare-rehearsal.env
```

Applies `supabase-schema.sql` once, with `ON_ERROR_STOP`. Doubles as a fresh-install
validation of the consolidated schema at migration 208.

## Step 2 — seed

```sh
npm run load:seed -- --env ~/vehloshare-rehearsal.env --seed 42 --workspaces 20
```

**Budget the sign-in limit before starting — findings T1/T3 are still OPEN.** Exercise 1
recorded three seeder findings; only T2 (the close step) was fixed, in GV-438. T1 and T3
were **not**:

- `seedWorkspace()` signs the owner in and then signs in **every other member** on every
  pass, including for workspaces a previous pass already completed, because it recovers
  state through `list_my_ledgers` — which needs a token. So a resumed run still spends
  most of its rate budget re-verifying built workspaces (T3), and a full 20-workspace pass
  still needs ~110 sign-ins against a **~30 per 5 minutes per IP** limit (T1).
- T4 stands as an operational fact: raising the dashboard's sign-in limit did **not** take
  effect in exercise 1, even after a project restart. Plan around the default, whatever the
  dashboard says.

Practical shape: seed in rounds, expect the run to plateau, and re-run it until
`workspaces: N ok` stops moving. Exercise 1 completed 12 of 20 this way, which was enough
for 27 VUs; exercise 3 completed 10 of 20 in one pass and did not retry (a retry pass
spends its whole window re-verifying the ten built ones first, T3). **Fixing T1/T3
properly is GV-494** (sign-in token bucket + resume that skips complete workspaces).

Add `--aged` if the hosted run should also carry the aged workspace; it costs
`--aged-members` further sign-ins and nothing else, since its volume rides on tokens
already held.

## Step 3 — the load run, WITH the realtime phase

```sh
npm run load:run -- --env ~/vehloshare-rehearsal.env \
  --vus 28 --duration 60 --mix mixed --seed 42 --realtime --sharers 0.2
```

`--vus 28` is exercise 1's setting (27 signed in; one was lost to the sign-in limit), which
brackets ~100 real users spread over small groups with margin. What `--realtime` adds:

- one websocket per VU — the same one-socket-per-client shape the app has — joining
  `presence-<ledgerId>` **and** `ledger-changes-<ledgerId>` as **private** channels with
  the VU's own JWT, presence keyed on its member id, and the two `postgres_changes`
  bindings `use-ledger-realtime.ts` opens;
- presence `track` plus Phoenix heartbeats for the whole run;
- `--sharers 0.2` of the VUs running "Jeg er på vej": `set_on_my_way` once, an
  `omw-position` broadcast every 15 s, an ETA refresh every 5 minutes (only reached by
  runs longer than that), and `clear_on_my_way` at teardown.

The sharers need a booking they own that has **not ended** (migration 202's gate). The
fixture's bookings are anchored at **2026-07-01** and are all in the past by now, so the
driver prefers a live one and otherwise creates one through the app's own
`upsert_car_booking`, on a day derived from the VU index so two sharers in one workspace
never collide with `prevent_overlapping_car_bookings`.

**Read the evidence block for:** per-endpoint p50/p95/p99 (including
`rpc:set_on_my_way` / `rpc:clear_on_my_way`, which sit in the ordinary table because that
is what they are), errors by status, and the Realtime section — join latency per channel,
join failures **by reason**, presence syncs, `postgres_changes` deliveries and broadcast
counts.

**A refused join is a launch finding, not noise.** The run exits **1** on any of them and
prints which:

| reason | what it means |
|---|---|
| `Unauthorized` | migrations 202/205/206's policies refused a **member's** private join. Presence and live sync are down for real users. Check the migrations are applied to the throwaway project. |
| `PrivateOnly` | a join frame lost `private: true`. Every join the harness sends sets it, so this means the harness drifted, not the project. |
| `timeout` | no reply at all — project asleep, wrong URL/key, or network. |

Also run the read-only mix (`--mix read`) if a clean read baseline is wanted; that half is
unchanged from exercise 1 and directly comparable to it.

## Step 4 — the two probes

```sh
# tenant isolation over HTTP (now including vehicle_documents)
npm run load:run -- --env ~/vehloshare-rehearsal.env --vus 28 --rls-probe

# tenant isolation over REALTIME (GV-490) — needs the Step 0 switch OFF
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon key> \
  npm run probe:realtime-public-access
```

The two answer different halves and neither substitutes for the other: the RLS probe
proves a member cannot READ another workspace's rows; the realtime probe proves a public
channel open is refused by the platform before any policy is consulted. Optionally set
`SUPABASE_ACCESS_TOKEN` (a seeded member's JWT) and `LEDGER_ID` to add the probe's phase 2
— the same topic joined WITH `private: true` must still reach SUBSCRIBED, i.e. the switch
closed the hole without taking presence down.

Probe exit codes: **0 = closed, 1 = open (launch blocker), 2 = inconclusive.** Two is
never a pass.

## Step 5 — record and tear down

Replace the placeholder below with the real evidence block, then **delete the throwaway
project** from the dashboard and `rm` the env file (GDPR teardown — one action removes
every synthetic user and row).

### RESULTS

Hosted run performed **2026-08-19** at migration **208** against a throwaway project
(`afsadukfqmvqwfvcmmyd`, `eu-west-1`, Postgres 17.6, "Allow public access to channels"
switched OFF before any step). Project and `~/vehloshare-rehearsal.env` deleted afterwards.

**Step 1 — schema.** First `load:schema` attempt failed at line 47939 with a **deadlock**
between our `create trigger … on booking_handovers` and a Supabase-side process holding
an `AccessShareLock` (PostgREST re-introspects the schema after every DDL event, and the
consolidated file issues thousands). The apply is not single-transaction, so the project
was left half-built; `drop schema public cascade` + recreate with Supabase's standard
grants, then a second `load:schema`: **applied cleanly — fresh install of all 208
migrations validated.** Tooling finding **T5** (→ GV-494): `schema-apply` should retry
once on SQLSTATE 40P01 after wiping `public`; the deadlock is transient.

**Step 2 — seed** (`--seed 42 --workspaces 20`): 103 auth users created; **10 of 20
workspaces built** before every further sign-in got HTTP 429 (T1/T3, ~30 per 5 min per IP,
T4 unchanged) — 51 memberships, 106 trips, 53 fuel payments, 17 expenses, 14 recurring, 24
bookings, 39 messages, 11 settlement requests, **3 periods closed** through the real
close program. Not retried; 10 workspaces spanned the 28 VUs. → GV-494.

**Step 3 — full run** `--vus 28 --duration 60 --mix mixed --seed 42 --realtime --sharers 0.2`
(28/28 VUs signed in; the login window had been rested for 4 min after seeding):

```
requests:    24493 total  (404.3 req/s)     errors: none (all responses < 400)

endpoint                          count      p50      p95      p99      max   (ms)
read:bookings                      1604      159      489     1221     4470
read:events                        1604      175      505      975     4026
read:expenses                      1604      161      487     1090     4506
read:fuel                          1604      163      493     1157     4572
read:ledger                        1604      157      456     1186     5620
read:members                       1604      158      463      996     4199
read:messages                      1604      162      499     1004     4137
read:participants                  1603      157      413      670     2541
read:periods                       1604      158      499     1107     4198
read:recurring                     1604      160      465     1057     4457
read:repairs                       1604      157      522      962     4600
read:settlements                   1604      155      469      946     4570
read:trips                         1604      166      498     1123     3801
rpc:add_vehicle_document_photo       82      156      361      439      439
rpc:calculate_period_settlement    1604      152      445     2299     5702
rpc:clear_on_my_way                   6      103      121      121      121
rpc:create_vehicle_document          82      141      436     1137     1137
rpc:list_my_ledgers                1604      140      393      791     5599
rpc:post_message                     84      145      412     2513     2513
rpc:set_on_my_way                     6       48       53       53       53
rpc:upsert_car_booking                6       52      124      124      124
rpc:upsert_fuel_payment              84      201      408      494      494
rpc:upsert_trip_with_participants     84      275      519      714      714

Realtime: sockets 28 opened, 0 failed · sharers 6
channel (private join)            count      p50      p95      p99      max
ledger-changes                       28       53       72       73       73
presence                             20       45       60       72       72
presence syncs 88 · postgres_changes 1460 · omw-position sent 16 / received 56
join failures: presence × 8 — "MissingPartition: Realtime was unable to find the
               expected messages partition"   → run exited 1
```

**Versus exercise 1** (same VU count, same mix, migration 166): 326 → **404 req/s**,
read p95 550–670 → **410–520 ms**, `calculate_period_settlement` p95 521 → 445 ms, still
zero HTTP errors — with a websocket, two private channels, presence heartbeats and
postgres_changes fan-out per VU that exercise 1 did not carry. The two new write
families sit at the cheap end of the table (`set_on_my_way` p95 53 ms,
`create_vehicle_document` 436 ms).

**The 8 refused presence joins are a fresh-tenant artefact, not an authorization
finding — and it was proven, not assumed.** The reason string is neither `Unauthorized`
nor `PrivateOnly`; it is Realtime reporting that the day-partition of `realtime.messages`
its authorization test-insert needs did not exist yet. Realtime's tenant janitor creates
those partitions when the tenant first spins up, and this tenant had never had a client
before this run; the driver joins presence first, the first 8 raced the janitor, and
every join after them (20 presence, all 28 ledger-changes) succeeded. Two checks:

- inspected afterwards, `realtime.messages` carried exactly the janitor's three
  partitions (`messages_2026_08_18/19/20`) and nothing else;
- **re-run on the now-warm tenant** (`--vus 28 --duration 20 --realtime --sharers 0.2`,
  27/28 VUs — one lost to the sign-in limit, as in exercise 1): **27/27 presence and 27/27
  ledger-changes joins reached SUBSCRIBED, 0 refused** (presence p50 49 / p95 187 ms,
  ledger-changes p50 57 / p95 93 ms; 107 presence syncs, 198 postgres_changes, 5 sharers,
  24 broadcasts received; 5,227 requests, 255 req/s over 20 s, zero errors); run exited 0.

Production has had live clients since GVM-575 shipped, so its partitions exist; the residual
worth knowing is that **this exact string is what a partition gap would surface as** on a
day roll-over, and the mobile hook already treats a refused presence subscribe as
cosmetic (grey dots, live sync on its own channel unaffected). Tooling finding **T6** (→ GV-494):
the harness should bucket `MissingPartition` separately from `other` and say this.

**Step 4 — probes.**

- RLS tenant isolation (`--vus 30 --rls-probe`, 29/30 signed in, 6 ledgers): **203
  cross-workspace checks, 0 leaked rows — PASSED.**
- Realtime public access (`npm run probe:realtime-public-access`, topic
  `presence-<first ledger>`): **phase 1 public join REFUSED — `PrivateOnly: This project
  only allows private channels`, exit 0.** Phase 2 (member private join) is evidenced by
  the load run itself: 27/27 private presence joins SUBSCRIBED on the same project.

**Verdict for the reviewer's question (GV-493).** At migration 208, with private
Realtime, ETA sharing/broadcast, the document archive and the trigger-guarded
`on_my_way` column all in the path, the platform holds 28 concurrent VUs — bracketing
~100 real users spread over small groups — at 404 req/s with zero HTTP errors, every
private channel join for a member succeeding on a warm tenant, and no cross-workspace
leak over HTTP or over a public channel. No schema work falls out of this run.
Follow-ups: GV-494 (seeder T1/T3 + harness T5/T6).

**Step 5 — teardown:** the owner deletes the throwaway project and `rm`s the env file once
this record is merged; nothing synthetic outlives the run.
