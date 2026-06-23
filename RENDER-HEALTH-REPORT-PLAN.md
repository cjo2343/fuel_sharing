# Plan: make the Render health report actually report health

## Finding
`/api/admin/health` → `build_render_admin_health` (server.py ~1584) returns 28 checks;
`renderRenderAdminHealthCard` (app.js ~6582) lists them all as green rows. But:
- **20/28 are hardcoded `ok: True`** — the whole route list (`build_render_admin_route_health`,
  server.py ~1549) is a static constant ("Route is mounted in this Render service");
  it probes nothing and can never fail. Misleading.
- **4/28 are tautological** — `render`, `supabase-config`, `supabase-session`,
  `workspace-member` are all just "the authed request got here."
- **4/28 are real:** `workspace-admin`, `open-period`, `server-rate-limits`,
  `vehicle-provider-config`.
So a broken downstream (Supabase down, vehicle proxy 500ing, a route throwing) would
still render an all-green report.

## Server changes — Opus (server.py, auth + external-call discipline)
1. **Add real, timeout-bounded reachability probes:**
   - **Supabase**: one lightweight call (the existing healthcheck RPC, or a
     `select 1`/`limit 1` against a known table) with a short timeout; report ok +
     latency. On failure/timeout report `ok: false` with the error class (not the raw
     error).
   - **Vehicle provider**: do NOT call the external provider on every health check
     (cost/abuse/latency). Report from a **cached last-known result** (last successful
     lookup time / last error) plus the existing config check. Optionally an explicit
     "deep" probe only when the owner asks.
2. **Add Render runtime signals:** server build/version (tie to build-info if exposed),
   process start time / uptime (surfaces cold-start + crash-loops), and the probe
   latency above. These are what's actually useful for a free-tier Render service.
3. **Fix the route list:** drop the 20 static always-green rows, OR make them
   meaningful — for each route, verify the handler is registered AND its required
   env/deps are present, and only include a row when it has real signal. Prefer a small
   honest set over 20 decorative ones.
4. Keep the 4 real checks. Keep `assert_user_can_admin_ledger` gating. Ensure the whole
   handler is bounded (no probe can hang the health route) and adds no new unauthenticated
   surface or way to hammer Supabase/the provider.

## Client changes — Sonnet (renderRenderAdminHealthCard, app.js ~6582)
- Apply the Admin observability principle (see backlog): summary tile + **only non-OK
  rows by default**, collapse the passing ones; surface latency/uptime compactly.
- Fix the shared mid-word wrap: this card uses `readable-activity-list` inside an
  `admin-diagnostics-section` (same issue as #14) — pick up that fix.

## Validation
`npm run validate`, `npm run test:e2e`, and server-side: with Supabase reachable the
report is honest-green incl. latency/uptime; simulate a Supabase failure/timeout → the
Supabase probe row goes red and overall `ok` is false (no more all-green-on-failure);
confirm the provider is NOT called on every health check. Runtime files change →
version bump (build-info + service-worker + checklist; no embedded double-quotes in the
top release note). Add/extend a server guard test for the new probe behavior.

## Category
**Mixed** — server probe rework → **Opus** (security/auth-sensitive, external-call &
timeout discipline; the substantive part). Client presentation → **Sonnet** (observability
+ shares the #14 wrap fix).
