# Fuel Ledger — architecture & flow map

> Living overview of how the app is wired. **Maintenance rule:** whenever a task
> changes how parts connect (a route, a load/sync path, a panel, an auth step), update
> the relevant diagram/section here in the same PR. Haiku/Sonnet can do incremental
> edits; keep it accurate over pretty. Cross-reference open work in `LAUNCH-BACKLOG.md`.

## Component map

```mermaid
flowchart TD
  subgraph Client["Browser PWA"]
    HTML["index.html<br/>panels by data-view:<br/>log · book · settle · payments ·<br/>history · insights · about · account · admin"]
    APP["app.js (~22k lines)<br/>render + state + sync lanes"]
    SW["service-worker.js<br/>cache-first core, network-first build-info<br/>update handoff (#1)"]
    BUILD["build-info.js<br/>version / cache / release notes"]
    IDB[("IndexedDB<br/>local cached state")]
  end

  subgraph Render["Render service (server.py)"]
    API["ThreadingHTTPServer routes<br/>/api/state/load · /api/*/upsert<br/>/api/admin/* · /api/owner/*<br/>/api/vehicle/lookup"]
  end

  subgraph Supabase["Supabase"]
    DB[("Postgres + RLS<br/>ledgers · members · trips · fuel ·<br/>bookings · settlements · invites · ledger_events")]
    RPC["SECURITY DEFINER RPCs<br/>+ healthcheck"]
    RT["Realtime<br/>(ledger_events only)"]
  end

  EXT["Vehicle provider<br/>(Nummerplade Tjek)"]

  APP <--> SW
  APP --> IDB
  APP -->|REST, bearer user token| API
  API -->|service role| DB
  API --> RPC
  API --> EXT
  RT -. postgres_changes .-> APP
  BUILD -. version mismatch .-> SW
```

Key principle: **Render is the state authority.** The client reads/writes through the
Render API; Supabase is never hit directly from the browser for app state. IndexedDB +
a JSON mirror are local fallbacks.

## Load / sync lane (where most "feels unstable" bugs live)

```mermaid
sequenceDiagram
  participant U as User
  participant APP as app.js
  participant R as Render (cold on free tier)
  participant SB as Supabase
  U->>APP: open / return after idle
  APP->>APP: ensureAppStartupWakeGate()
  APP->>R: getRenderNormalizedStateRows(ledgerId)
  alt Render awake
    R->>SB: read normalized tables
    SB-->>R: rows
    R-->>APP: state rows
    APP->>APP: clearSyncDelay("load-success") + render
  else Render cold / slow (30–50s)
    R-->>APP: null
    APP->>APP: throw "Render state load is required…"
    APP->>APP: setSyncDelay → red "Cloud delayed" banner (#3)
    Note over APP: cached IDB state still shown → app usable,<br/>banner overstates severity (backlog #3)
  end
```

Auth note: `onAuthStateChange` defers work to `handleAuthStateChange` via `setTimeout(0)`
to avoid the supabase-js auth-lock deadlock (the original "stuck after idle" root cause).

## Subsystems & where to look

| Area | Entry points | Open items |
|------|--------------|------------|
| Service-worker update handoff | `activateReadyAppUpdate`, build-update event | #1 (done, PR #19) |
| Cold-start banners | `loadSupabaseState`, `renderSyncHealthBanner`, startup gate | #3 |
| Predictions / fuel intelligence | `buildSmartPredictions`, `buildFuelIntelligence`, `calculateHistoricalFuelStats` | #4 |
| Onboarding / invites | `renderWorkspaceInvitesPanel`, server invite RPCs | #5, #10 |
| Admin role separation | `canUseGlobalAdminTools`, `#dataToolsPanel` | #6, #8 |
| Admin observability (tiles/tools/health) | `renderAdminGuardrailOverview`, `renderSupabaseLoadMonitor`, `renderSystemHealth`, `build_render_admin_health` | #11, #13, #14, #15, #16 |
| Layout "go wide" | `.settings-form`, `.workspace-invites-grid`, `.admin-diagnostics-*` | #7, #10, #14 |
| Booking | `#bookingForm`, calendar card | #17 |

> See `LAUNCH-BACKLOG.md` for the full task list, categories, and the
> "Admin observability" design principle.
