(function () {
  const BUILD_INFO = Object.freeze({
    appName: "Fuel Ledger",
    version: "2026.06.18.201",
    buildLabel: "admin-cleanup-diagnostics-finish",
    updatedAt: "2026-06-18T11:25:00.000Z",
    expectedServiceWorkerCache: "fuel-ledger-v301",
    releaseNotes: Object.freeze([
      "Retention preview and cleanup now prefer Render admin routes that verify the signed-in workspace admin and call the Supabase retention RPCs server-side, with browser RPCs kept only as fallback.",
      "Signed-in startup now shows a calm Loading workspace state while Render hydrates workspace/member data, and suppresses invite/phone/setup panels plus premature Cloud delayed banners until startup load settles.",
      "Admin/Test Lab tools now batch their Data I/O and full UI refreshes while a button action is running, so rapid generated-data and report-save flows repaint once at the end instead of flickering through start/ok status churn.",
      "Cleanup now uses the active ledger helper instead of an out-of-scope currentLedger variable, and Security Health plus cloud report saves confirm before opening admin Data I/O rows so cancelled prompts cannot leave timeout rows.",
      "Generated Test Lab cleanup now prefers a Render /api/admin/test-data/cleanup route that verifies workspace admin permission and soft-deletes generated trip, fuel, and booking rows server-side before the JSON mirror backup runs.",
      "Generated test trip/fuel admin buttons now create normalized rows through a Render /api/admin/test-data/create route, so Add generated test fuel no longer depends on browser-side normalized write-context setup before the backend save can start.",
      "Clean generated Test Lab data now also soft-deletes generated trip, fuel, and booking rows from normalized Supabase tables before saving the Render JSON mirror backup, so normalized health no longer sees old generated rows after cleanup.",
      "Admin cleanup and advanced-stress paths now finish their admin-tool Data I/O rows and use the Render JSON mirror backup path without waking the old browser full-state save, preventing stale cleanup/stress timeout rows after backend backup succeeds.",
      "Admin tools that trigger cloud work now wrap their action in a Data I/O operation row, so the load monitor shows start/success/error/timeout status for buttons such as generated test data, Test Lab scenarios, Security Health, JSON backups, member/workspace invite tools, and admin diagnostics.",
      "After a successful Render JSON mirror backup, generated-test cleanup now saves the cleaned local state and Render mirror without waking the old browser full-state save queue, preventing stale saveSupabaseState timeouts after the backend backup already succeeded.",
      "JSON mirror safety backups now prefer a Render /api/backups/json-mirror route that verifies workspace admin permission and writes car_share_ledgers through the signed-in Supabase session, with the browser direct-table mirror kept only as fallback.",
      "Ledger/workspace directory sync now prefers a Render /api/ledgers/sync route that verifies workspace admin permission and upserts ledgers plus ledger_members through the signed-in Supabase session, with browser direct-table sync kept only as fallback.",
      "Admin diagnostics/manual-admin refreshes now use the Render state-load fast path before the legacy JSON mirror load, preventing admin-only timeouts after a healthy Render sync.",
      "Startup and manual normalized-table state loads now prefer a Render /api/state/load route that verifies the signed-in user and returns normalized rows, while keeping browser Supabase table reads as a safe fallback.",
      "Advanced stress/full JSON-to-table reconciliation now includes the required ledger slug before touching ledgers, preventing the guarded ledger-directory-sync failure during admin stress diagnostics.",
      "Security Health now uses per-probe timeouts so a slow backend health RPC cannot make the button appear idle, and saving a Test Lab/Security Health report to cloud now awaits the normalized report row and shows explicit success or failure.",
      "Booking saves no longer pre-record or report browser Supabase RPC activity after a successful Render booking save; the browser RPC path is now only diagnosed when the fallback actually runs.",
      "Trip, fuel, booking, and payment write setup now prefers a Render write-context route before falling back to browser direct Supabase lookups, reducing ledger_members reads while keeping the proven v281 save path safe.",
      "Hotfix: trip, fuel, and booking saves now use the proven v279 normalized context setup again so Render-backed saves can start reliably; the v280 context-cache/fanout optimization is backed out for the save path.",
      "Booking saves and booking deletes now prefer Render backend routes that call Supabase booking RPCs with the signed-in user session, with a documented Render migration path and validation guardrail.",
      "Trip and fuel saves now time-bound the pre-backend normalized write context step, record a timeout diagnostic if setup hangs, and clear the visible Saving state instead of waiting for the stale-operation failsafe.",
      "Fuel saves now prefer a Render backend route, record matched start/finish data I/O diagnostics, time out with Promise.race, clear the foreground fuel-save operation in finally, and only log fuel-table-write after the backend/normalized save succeeds.",
      "Trip Render saves now record a matched finish diagnostic, time out with Promise.race even if fetch abort does not resolve, clear the foreground trip-save operation in finally, and only log trip-table-write after the backend save succeeds.",
      "Trip saves now prefer a Render backend route that calls upsert_trip_with_participants with the signed-in Supabase session, so trip logging no longer hangs on the browser-owned direct Supabase RPC path and direct RPC is only a fallback when the Render route is unavailable.",
      "Fuel price warning, suggestion, and validation calculations now live in a dedicated helper module with focused unit coverage, reducing app.js while preserving fuel-log behavior.",
      "Payment actions now start from a cached/backend-first normalized context and do not record a local settlement-table write before the Render/Supabase backend write has actually succeeded, so pre-backend hangs cannot leave local-only payment state behind.",
      "Payment actions now time-bound the pre-backend session/context step and explicitly report backend-not-started or backend-skipped instead of leaving the foreground Saving operation to be cleared by the 20-second failsafe.",
      "Payment actions now use one visible foreground operation, skip the duplicate settlement-save latch, record when the backend write path starts, and reset immediately on Render API timeout instead of falling through to a second fallback that can keep Saving active.",
      "Payment status saves now keep the short Render/API abort but give the outer normalized save enough time to fall back cleanly, preventing stale 15-second payment timeout warnings after the foreground operation already finished.",
      "The Supabase load monitor now counts only real app-side load/save activity for the headline activity number, while diagnostic breadcrumbs remain visible below without inflating the scary high-activity warning.",
      "Visible Saving is now driven by a central foreground operation tracker shared by trips, fuel, bookings, payments, server saves, and Supabase saves; if Saving appears, Admin shows the active operation and stale operations auto-clear after 20 seconds.",
      "Debounced remote saves now serialize while a previous save is still running, coalescing follow-up saves instead of overlapping cloud writes that can make sync appear stuck.",
      "Visible Saving status now has its own failsafe and payment-action finally cleanup, so a timed-out payment confirmation cannot leave the top bar stuck on Saving changes after Cloud Load and Data I/O are idle.",
      "Skipped/guarded data I/O diagnostics now render as skipped/instant instead of OK/active, so ledger-directory skip breadcrumbs no longer look like stuck writes.",
      "Admin activity severity now cools down when the last minute is quiet even if the previous five-minute window still contains an old burst.",
      "Visible Saving/Syncing status is now source-gated: background focus, realtime, admin diagnostics, and service-worker paths are blocked from setting the top-bar badge and instead record a diagnostic with the attempted source.",
      "Payment actions now apply the local requested/paid/reopened status and audit breadcrumb before waiting on the local backend merge, so smoke tests and users see the persisted result immediately while keeping the full-state save fanout reduction.",
      "Successful Supabase/Render payment actions now update local UI state without queuing the generic full-state remote save stack, reducing duplicate Supabase saves, reconciliation skips, JSON mirror checks, and ledger event attempts after one payment click.",
      "Service-worker version handoff is now stricter: build-info.js is network-first, core runtime assets stay stable within one cache, and update-ready states tell users to close/reopen instead of showing random cache mismatches.",
      "Admin diagnostics now uses a full-width readable layout for Supabase activity and data I/O operation rows, preventing long technical labels from collapsing into vertical letter stacks.",
      "Background window-focus and realtime-triggered cloud loads now defer while foreground writes or recent healthy syncs exist, preventing user actions from competing with automatic refreshes.",
      "Active data I/O operations now age into timeout status in Admin diagnostics instead of appearing active forever when a finish event is missing.",
      "Data I/O operation pairing now uses unique operation IDs, so simultaneous Render payment starts and finishes cannot leave orphaned active rows in Admin diagnostics.",
      "Admin diagnostics now separates admin/manual diagnostic timeouts from core cloud sync warnings and presents load activity in wide dashboard cards with grouped operations.",
      "Data I/O diagnostics now pair start/success/error events into operation rows with status and duration, so an old start entry no longer looks like a stuck write when a matching ok event exists.",
      "Data I/O flight recorder now records each normalized read/write source, route, table/RPC/API endpoint, result, and Supabase error so stuck Saving/Syncing states show the real failing operation instead of a generic status.",
      "Ledger upserts are now blocked before Supabase when slug is missing, and the block is recorded as a data I/O diagnostic so the old ledgers.slug failure path is easy to identify.",
      "Payment request buttons now have a guaranteed timeout/finally cleanup, so Requesting/Saving cannot stay stuck if the Render/Supabase payment path hangs or falls back.",
      "Settlement/payment status saves now skip admin ledger-directory reconciliation, so requesting or reopening a payment cannot upsert ledgers without the required slug and force JSON fallback.",
      "Admin ledger directory reconciliation now includes a slug whenever it does upsert ledgers, preventing the not-null slug constraint from failing on settings/member syncs.",
      "Payment status changes now prefer the existing Render web service API, which verifies the signed-in Supabase session and calls the backend payment action RPC before the browser falls back to direct Supabase RPC.",
      "Payment status changes now prefer a backend-owned Supabase RPC that saves the normalized settlement status, stale-row cleanup, and lightweight ledger event in one database transaction, with fallback for databases that have not applied migration 031 yet.",
      "Visible Syncing status now has a central failsafe and diagnostics, so skipped/background sync paths cannot leave the top bar stuck until manual Sync now is clicked.",
      "Recoverable focus/manual sync delay warnings are now suppressed after a recent healthy normalized-table sync, so stale timeout banners do not reappear after the app has already loaded successfully.",
      "Admin database diagnostics now show a clear timeout/error message instead of staying on Loading forever when a Supabase diagnostics read hangs.",
      "The Admin follow-up database card now labels normalized database-table health separately from the JSON backup snapshot so an old JSON backup timestamp no longer looks like a primary database failure.",
      "Payment request audit entries now include the visible Payment requested/marked paid/reopened wording in their stored summary, so local/server-backed smoke tests and history views agree on the audit breadcrumb.",
      "Manual Sync now clears stale background/focus delay state before starting and records manual-specific start, success, timeout, skipped-existing-load, and incomplete diagnostics.",
      "Manual sync timeouts after a recent healthy cloud load are now diagnostic-only instead of reusing an old background timeout as a red Cloud delayed banner.",
      "Core app-shell files now use a cache-first service-worker response with background refresh, reducing repeated static asset downloads and app restart churn during normal use.",
      "Service-worker controller changes are now logged instead of forcing an immediate page reload, preventing deploy/update handoffs from triggering avoidable Supabase reconnect storms.",
      "Live fuel-price lookup now has a short timeout and in-flight guard so a slow public price API cannot stall startup or repeated renders; the app keeps using the configured fallback price.",
      "Window-focus cloud refreshes now have explicit attempt/load cooldowns and diagnostics, so skipped background refreshes after a healthy sync do not become false Cloud delayed banners.",
      "Realtime subscriptions are now reused for the active ledger instead of being recreated on repeated auth/visibility events, reducing Supabase realtime.list_changes churn.",
      "Background syncs that return without a fresh load after a recent healthy cloud sync are recorded as diagnostics instead of switching the visible sync status to delayed.",
      "Background cloud refresh timeouts now allow a recent healthy sync grace window, preventing a window-focus timeout minutes after a successful load from showing a false Sync delayed banner.",
      "Window-focus cloud refreshes now run as background syncs, so a slow focus refresh after a healthy load no longer raises a scary Sync delayed banner unless the app has no healthy cloud state.",
      "Successful Supabase loads and saves now clear stale Sync delayed warnings immediately, so a load-success diagnostic no longer leaves the red banner stuck on-screen.",
      "Sync delayed warnings now include an expandable in-app diagnostic trail with the failing step, timeout/error detail, session state, ledger id, and network status so phone/PWA issues are visible without opening the console.",
      "The Supabase load monitor now surfaces the latest sync diagnostic alongside recent app-side Supabase activity.",
      "Onboarding abuse/rate-limit foundation now throttles private workspace creation, invite creation, and invite redemption through Supabase migration 030.",
      "Private workspace creation UI lets signed-in users create invite-only workspaces, become admin, switch into them, and invite others.",
      "Workspace-triggered cloud refreshes now always clear the Syncing badge on success, failure, or timeout so private workspace switching and creation do not leave stale syncing UI.",
      "Period close now takes the same admin safety backup path before archiving current activity.",
      "Destructive admin backup reasons are listed in code and checked by validation.",
      "Deployment and hardening docs now explain the backup-before-destructive-action rule.",
      "JSON mirror writes remain manual, safety, or audit-cadence only.",
      "Local/server-backed trip submits now flush immediately so booking-to-trip smoke tests and payment actions read the exact saved participants.",
      "Startup cloud sync now times out cleanly and unlocks manual Sync now retries instead of leaving the app stuck in Syncing.",
      "CSP style rules now use style-src self without unsafe-inline; helper positioning moved to stylesheet classes and header tests block regressions.",
      "Cloud sync timeout recovery now covers manual Sync now, login/auth refresh, focus refresh, member/admin refreshes, and ledger-event auto-sync, and successful loads clear their timeout timer.",
      "Auth token refresh events now skip redundant forced cloud loads for the same user during a short cooldown, preventing refresh loops from showing false Cloud delayed warnings.",
      "Background auth refresh syncs no longer overwrite a healthy synced state with Cloud delayed; duplicate signed-in/auth-change events are cooldown-skipped.",
      "Generated Test Data writes/removals now require the advanced admin unlock plus typed confirmation, and cleanup uses strict auto-test id matching.",
      "Retention cleanup now prunes old cloud Test Lab report history while keeping the newest reports and never touching ledger accounting history.",
      "Diagnostic report redaction now covers JWTs, Authorization values, API keys, passwords, cookies, and sensitive URL query parameters without hiding build versions or timestamps.",
      "Booking-to-trip conversion now preserves planned estimate participants even if the trip form briefly re-renders to the default all-member selection before submit.",
      "Settlement request status updates now use a transaction RPC when available so payment status saves and stale payment-line cleanup succeed or fail together.",
      "Security Health now reports Fuel Ledger schema migration tracking so missing Supabase migration IDs are visible after deployment.",
      "Security Health now detects schema drift across expected tables, columns, and key RLS policies.",
      "Admin diagnostics now include a plain-language overall health summary plus dedicated migration and schema-shape cards.",
      "Admin diagnostics now includes a public launch readiness card that warns against broad advertising until workspace isolation and invite onboarding exist.",
      "Private workspace foundation adds ledger slugs, private-by-default signup flags, membership lookup indexes, and safe list/create workspace RPCs without enabling public onboarding.",
      "Admin now has an Invites & workspaces section for creating/revoking private invite codes and reviewing linked workspaces without using SQL.",
      "Insights and dashboard labels now make clear that statistics are scoped to the currently configured workspace/car, with workspace switching still disabled.",
      "Admin Invites & workspaces now uses a cleaner responsive layout so invite forms, workspace rows, and invite rows do not overlap.",
      "Invite creation now uses schema-qualified Supabase pgcrypto random bytes and shows a clear migration message if the database helper is missing.",
      "Invite code hashing now also uses schema-qualified Supabase pgcrypto digest and shows a clear migration message if the hash helper is missing.",
      "Private-beta workspace switching now lets signed-in users select among ledgers returned by list_my_ledgers(), with trips, bookings, fuel, settlements, insights, and admin tools reloaded for the active workspace.",
      "Runtime utility loading now exposes formatMoney from utils.js before app.js and validation checks the Playwright critical-module contract.",
      "Signed-in users can now redeem workspace invite codes in the app, refresh linked workspaces, and switch into the joined workspace.",
      "New users can paste a workspace invite code on the login screen and the app auto-redeems it immediately after email-code sign-in.",
      "Signed-in workspace identity is now bound to the authenticated ledger member row so invitees cannot inherit the first local admin profile from JSON fallback state.",
      "Login invite auto-redeem now has a defined pending-code storage key and member workspace loads avoid direct ledgers reads that regular-member RLS can reject.",
      "Invite/login runtime now avoids optional chaining bracket syntax so older Safari engines do not stop on a parse error during create-invite and auto-redeem flows.",
      "Admin invite refresh now has a fail-safe timeout and always leaves the Refresh button usable instead of staying on Loading workspaces.",
      "Admin invite tools now auto-refresh when the Admin tab opens or auth/workspace readiness changes, and invite creation no longer waits on invite-list refresh before showing the one-time code.",
      "Invite redemption now fixes the Supabase ledger_id return-column ambiguity so login auto-redeem works without pasting the workspace code again on the dashboard.",
      "Invite redemption now treats the Supabase session as the signed-in source of truth, clears stale sign-in prompts, and keeps pending invitees from inheriting the old local admin identity while membership loads.",
      "Supabase workspace sessions now ignore stale JSON member-profile authority until workspace membership confirms the signed-in user, preventing invitees from appearing as the first local admin and avoiding regular-member ledger reconciliation writes.",
      "Admin invite creation now labels the exact current workspace, and created codes state that they join only that workspace so invite codes do not feel global.",
      "Runtime JavaScript now avoids optional catch binding syntax so older Safari/WebKit engines do not stop on a parse error, and Admin guardrails handle missing Security Health rows without crashing."
    ])
  });

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || "Unknown";
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  window.FUEL_LEDGER_BUILD = BUILD_INFO;

  function serviceWorkerStatus() {
    if (!("serviceWorker" in navigator)) return "Not supported in this browser";
    if (!navigator.serviceWorker.controller) return "Installed or waiting for next reload";
    return "Active on this page";
  }

  function requestServiceWorkerInfo(timeoutMs = 1200) {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller || typeof MessageChannel === "undefined") {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => resolve(null), timeoutMs);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve(event.data || null);
      };
      navigator.serviceWorker.controller.postMessage({ type: "GET_BUILD_INFO" }, [channel.port2]);
    });
  }

  function parseBuildInfoSource(source) {
    if (!source) return null;
    const version = source.match(/version:\s*["']([^"']+)["']/)?.[1] || null;
    const buildLabel = source.match(/buildLabel:\s*["']([^"']+)["']/)?.[1] || null;
    const updatedAt = source.match(/updatedAt:\s*["']([^"']+)["']/)?.[1] || null;
    const expectedServiceWorkerCache = source.match(/expectedServiceWorkerCache:\s*["']([^"']+)["']/)?.[1] || null;
    if (!version && !buildLabel && !expectedServiceWorkerCache) return null;
    return { version, buildLabel, updatedAt, expectedServiceWorkerCache };
  }

  async function requestLatestDeployedBuildInfo(timeoutMs = 1600) {
    if (typeof fetch !== "function" || typeof AbortController === "undefined") return null;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`/build-info.js?version-check=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) return null;
      return parseBuildInfoSource(await response.text());
    } catch (error) {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function escapeBuildInfoText(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderBuildInfoPanel(target, serviceWorkerInfo = null, deployedInfo = null) {
    if (!target) return;
    const serviceWorkerCache = serviceWorkerInfo?.cacheName || "Not reported yet";
    const deployedCache = deployedInfo?.expectedServiceWorkerCache || BUILD_INFO.expectedServiceWorkerCache;
    const pageIsOlderThanDeploy = Boolean(deployedInfo?.expectedServiceWorkerCache && deployedInfo.expectedServiceWorkerCache !== BUILD_INFO.expectedServiceWorkerCache);
    const cacheMatchesLoadedPage = serviceWorkerInfo?.cacheName
      ? serviceWorkerInfo.cacheName === BUILD_INFO.expectedServiceWorkerCache
      : null;
    const cacheMatchesDeploy = serviceWorkerInfo?.cacheName && deployedCache
      ? serviceWorkerInfo.cacheName === deployedCache
      : null;
    const updatePending = pageIsOlderThanDeploy || (cacheMatchesLoadedPage === false && cacheMatchesDeploy === true);
    const cacheClass = updatePending ? "warning" : cacheMatchesLoadedPage === false ? "warning" : "ok";
    const cacheNote = updatePending
      ? "Update ready — close/reopen once so page files and the service worker use the same build."
      : cacheMatchesLoadedPage === false
        ? "Update handoff in progress — close/reopen once if this persists."
        : cacheMatchesLoadedPage === true
          ? "Cache matches this loaded build."
          : "Reload once if this looks stale.";
    const latestDeployLabel = deployedInfo?.buildLabel || BUILD_INFO.buildLabel;
    const latestDeployCache = deployedInfo?.expectedServiceWorkerCache || BUILD_INFO.expectedServiceWorkerCache;
    const latestDeployVersion = deployedInfo?.version || BUILD_INFO.version;
    const releaseNotes = (BUILD_INFO.releaseNotes || [])
      .map((note) => `<li>${escapeBuildInfoText(note)}</li>`)
      .join("");

    target.innerHTML = `
      <div class="build-info-grid">
        <article class="diagnostic-card ok">
          <strong>App version</strong>
          <p>${BUILD_INFO.version}</p>
        </article>
        <article class="diagnostic-card ok">
          <strong>Build label</strong>
          <p>${BUILD_INFO.buildLabel}</p>
        </article>
        <article class="diagnostic-card ok">
          <strong>Updated</strong>
          <p>${formatDateTime(BUILD_INFO.updatedAt)}</p>
        </article>
        <article class="diagnostic-card ${cacheClass}">
          <strong>Update status</strong>
          <p>${updatePending ? "Update ready" : cacheMatchesLoadedPage === false ? "Handoff" : "Current"}</p>
          <small>${cacheNote}</small>
        </article>
        <article class="diagnostic-card ok">
          <strong>Loaded page cache</strong>
          <p>${BUILD_INFO.expectedServiceWorkerCache}</p>
        </article>
        <article class="diagnostic-card ok">
          <strong>Latest deployed</strong>
          <p>${escapeBuildInfoText(latestDeployLabel)}</p>
          <small>${escapeBuildInfoText(latestDeployVersion)} · ${escapeBuildInfoText(latestDeployCache)}</small>
        </article>
        <article class="diagnostic-card ${cacheClass}">
          <strong>Service worker cache</strong>
          <p>${serviceWorkerCache}</p>
          <small>${cacheMatchesDeploy ? "Matches latest deployed cache." : serviceWorkerStatus()}</small>
        </article>
        <article class="diagnostic-card ok release-note-card">
          <strong>Latest notes</strong>
          <ul>${releaseNotes}</ul>
        </article>
      </div>
    `;
  }

  function renderBuildInfo(serviceWorkerInfo = null, deployedInfo = null) {
    document.querySelectorAll("#buildInfoPanel, #aboutBuildInfoPanel").forEach((target) => {
      renderBuildInfoPanel(target, serviceWorkerInfo, deployedInfo);
    });
  }

  async function refreshBuildInfo() {
    renderBuildInfo(null, null);
    const [serviceWorkerInfo, deployedInfo] = await Promise.all([
      requestServiceWorkerInfo(),
      requestLatestDeployedBuildInfo()
    ]);
    renderBuildInfo(serviceWorkerInfo, deployedInfo);
    return { serviceWorkerInfo, deployedInfo };
  }

  window.FuelBuildInfo = {
    BUILD_INFO,
    renderBuildInfo,
    refreshBuildInfo,
    serviceWorkerStatus
  };

  refreshBuildInfo();
  window.addEventListener("load", () => refreshBuildInfo());
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("controllerchange", () => refreshBuildInfo());
  }
})();
