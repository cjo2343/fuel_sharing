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
