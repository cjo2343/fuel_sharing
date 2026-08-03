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
(GVM-535) with this run as its baseline, not a launch blocker.

## Tooling findings (for the next rehearsal)

- **T1 — seeder needs sign-in throttling/backoff.** Workspace building signs in
  ~5 members per workspace; a full pass needs ~110 sign-ins against a 30/5 min
  per-IP Auth limit. Rounds 429 out mid-pass.
- **T2 — seed close-period flow predates migration 141.** Period close now
  requires all settlements requested at current amounts (42501). The seeder's
  close step always fails; harmless for load evidence, wrong as a fixture claim
  (`periods closed: 0`).
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
