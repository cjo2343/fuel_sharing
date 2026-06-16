(function () {
  const BUILD_INFO = Object.freeze({
    appName: "Fuel Ledger",
    version: "2026.06.16.155",
    buildLabel: "payment-action-stuck-state-guard",
    updatedAt: "2026-06-16T22:05:00.000Z",
    expectedServiceWorkerCache: "fuel-ledger-v254",
    releaseNotes: Object.freeze([
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

  function escapeBuildInfoText(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderBuildInfoPanel(target, serviceWorkerInfo = null) {
    if (!target) return;
    const serviceWorkerCache = serviceWorkerInfo?.cacheName || "Not reported yet";
    const cacheMatches = serviceWorkerInfo?.cacheName
      ? serviceWorkerInfo.cacheName === BUILD_INFO.expectedServiceWorkerCache
      : null;
    const cacheClass = cacheMatches === false ? "warning" : "ok";
    const cacheNote = cacheMatches === false
      ? "Cache mismatch — close/reopen the app or refresh once."
      : cacheMatches === true
        ? "Cache matches this build."
        : "Reload once if this looks stale.";
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
          <strong>Service worker cache</strong>
          <p>${serviceWorkerCache}</p>
          <small>${cacheNote}</small>
        </article>
        <article class="diagnostic-card ok">
          <strong>Expected cache</strong>
          <p>${BUILD_INFO.expectedServiceWorkerCache}</p>
        </article>
        <article class="diagnostic-card ok">
          <strong>PWA status</strong>
          <p>${serviceWorkerStatus()}</p>
        </article>
        <article class="diagnostic-card ok release-note-card">
          <strong>Latest notes</strong>
          <ul>${releaseNotes}</ul>
        </article>
      </div>
    `;
  }

  function renderBuildInfo(serviceWorkerInfo = null) {
    document.querySelectorAll("#buildInfoPanel, #aboutBuildInfoPanel").forEach((target) => {
      renderBuildInfoPanel(target, serviceWorkerInfo);
    });
  }

  async function refreshBuildInfo() {
    renderBuildInfo(null);
    const serviceWorkerInfo = await requestServiceWorkerInfo();
    renderBuildInfo(serviceWorkerInfo);
    return serviceWorkerInfo;
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
