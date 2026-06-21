(function () {
  const BUILD_INFO = Object.freeze({
    appName: "Fuel Ledger",
    version: "2026.06.18.257",
    buildLabel: "render-admin-report-save-route",
    updatedAt: "2026-06-21T08:45:00.000Z",
    expectedServiceWorkerCache: "fuel-ledger-v360",
    releaseNotes: Object.freeze([
      "Owner activity now treats multi-user and multi-workspace activity as normal global audit data: the app-owner view defaults to current workspace, can switch to all workspaces, groups by workspace/user, and no longer auto-refreshes after normal member actions.",
      "Owner activity is now summarized and manual-refreshable after timeouts: Admin shows grouped server-side activity instead of a long raw wall of rows, hides raw rows behind details, and pauses automatic owner-activity retries after timeout until the app owner asks for a refresh.",
      "Startup loading now separates core workspace load from admin diagnostics, coalesces duplicate workspace-list refreshes, keeps recent healthy admin health when a later check times out, makes workspace switching force-load the selected workspace, and groups Data I/O into readable Core, Workspace, Vehicle/settings, App action, Admin, and Background sections.",
      "Workspace membership refresh now repairs stale locally selected workspaces, so an unavailable workspace such as test1 no longer leaves settings locked behind Loading before settings can be edited.",
      "Owner Activity now backs off after Render timeouts, Admin background refreshes poll less aggressively, and vehicle lookup no longer cascades into extra owner-activity loads when Render is already slow.",
      "Render admin health now uses the shared full-timeout Render API helper, so token/header setup, fetch, and response-body reads all finish with matched Data I/O rows instead of leaving stale loading reports.",
      "Member-facing vehicle lookup, settings, trip, fuel, booking, payment, and settlement actions now group under Member actions in Data I/O, Supabase load reports export a deeper 30-row Data I/O window, and the owner-activity guard matches the helper-based vehicle lookup recorder.",
      "Owner activity refreshes are now serialized and fail closed: duplicate refreshes record a skipped row, stale in-flight refreshes get a timeout finish row, Render API timeouts cover token/header setup too, and vehicle lookup uses a fast membership check plus a guaranteed owner-activity receipt for success, errors, timeouts, and client disconnects.",
      "Vehicle lookup now uses the shared Render API helper with a full request/body timeout, records matched Data I/O start/finish rows, refreshes Owner activity after each attempt, and records server-side owner activity for lookup errors instead of throwing uncaught timeout errors.",
      "Owner activity now fails closed instead of hanging: the shared Render helper times out the full response body, Owner activity shows a clear empty/error state, and Data I/O records selected-vs-loaded workspace IDs when the selector and loaded workspace differ.",
      "Owner activity is now server-owned: Render records safe cross-user/cross-workspace activity rows for state loads, vehicle lookup, settings saves, member management, trips, fuel, bookings, and payment status actions, and the app owner can view recent activity from Admin without relying on browser-local Data I/O.",
      "Workspace identity hardening now cleans duplicate active workspace memberships, enforces one active email membership per workspace, collapses duplicate signed-in member rows without maybeSingle errors, and refuses to treat unconfirmed workspace selector entries as real admin/member roles.",
      "Workspace selector and membership loading now de-duplicate list_my_ledgers rows, prefer admin over duplicate member rows for the same workspace, never reset a signed-in user to the default Fuel Ledger during a timed-out workspace refresh, and disable switching until the authoritative workspace list has loaded.",
      "Workspace switching now uses isolated per-workspace local state, locks edits until the selected workspace is loaded from Render, shows a clear workspace-loading/confirmed status, and labels Data I/O rows with the workspace they belong to.",
      "Render API calls now use a shared frontend helper for fresh Supabase tokens, Authorization headers, timeouts, JSON parsing, and settings-save request handling instead of hand-rolled/stale token fetch code.",
      "Owner-only diagnostics now recognize the configured app-owner email chrjohn94@gmail.com, so the app owner keeps Data I/O/global admin tools while ordinary workspace admins remain limited to workspace settings, members, and invites.",
      "Member management now uses a backend-owned Render /api/members/manage route for listing, adding, editing, deactivating, and reactivating workspace members, while workspace admins stay scoped to their own workspace and technical Data I/O remains app-owner-only.",
      "Data I/O, Render admin health, Security Health, load reports, and advanced diagnostics are now treated as app-owner-only tools; workspace admins keep workspace settings, members, and invites without seeing technical backend diagnostics.",
      "After a verified backend-owned settings save, the app now shows a clear user-facing confirmation such as Settings saved / Vehicle info saved instead of only recording the result in Admin Data I/O.",
      "Settings save now verifies the canonical saved ledger row before reporting success: vehicle columns must exist, vehicle plate/details are read back after write, missing migration 038 fails with SETTINGS_SCHEMA_MISSING, and Data I/O shows which settings actually persisted.",
      "Workspace/car settings now save through a dedicated Render /api/settings/save route that verifies Supabase JWKS auth plus workspace-admin permission, persists ledger fuel and sanitized vehicle fields server-side, and avoids the old broad JSON-to-table reconciliation path for Save settings.",
      "Render backend auth now verifies Supabase ECC/P-256 access tokens locally through the project JWKS/public keys with rotation-aware caching, keeping the Supabase Auth network check as an explicit emergency fallback instead of the normal path.",
      "Render API calls now refresh and reuse a fresh Supabase access token before calling the backend, and auth-not-ready 401s during startup are treated as quiet fallback skips instead of scary backend failures.",
      "IndexedDB local state storage now uses a vendored localForage-compatible runtime asset instead of a CDN script, keeping offline startup inside the service-worker cache and CSP/runtime guardrails.",
      "Vehicle lookup and group settings saves now use local-only staging plus explicit Data I/O finish rows, so Admin shows vehicle-lookup/settings-save operations and Save settings does not leave a stale unsynced-change banner after the backend save completes.",
      "Vehicle lookup summaries now hide placeholder values such as unknown Euro norm/status and show cleaner fuel labels such as Petrol 95 while keeping useful engine, emissions, color, body, and registration facts.",
      "Vehicle lookup, settings saves, trip saves, fuel saves, and entry deletes now leave clearer Data I/O result-code breadcrumbs, while vehicle lookups and group settings also add safe audit-history entries without storing provider secrets or VIN data.",
      "Vehicle lookup now preserves more sanitized Nummerplade Tjek vehicle details including first registration, engine, emissions, Euro norm, and inspection metadata while keeping VIN/raw equipment out of the browser payload.",
      "Vehicle lookup now fails softly when the Render provider is missing or unavailable: /api/vehicle/lookup returns stable lookup result codes instead of browser-visible 5xx responses, and the UI keeps manual fuel settings as the fallback.",
      "Workspace-admin scope is now separated from global app-admin tools: admins of secondary/private workspaces can manage only their workspace settings, members, and invites, while Data tools, Security Health, Render admin health, diagnostics, backups/imports, and Test Lab stay hidden outside the primary app-admin workspace.",
      "Workspace settings now stay scoped to the active workspace: Render state-load returns the current ledger row, new workspaces no longer borrow car/fuel settings from another workspace JSON fallback, and signed-in one-member workspaces can save vehicle settings without the old two-person manual-list blocker.",
      "Vehicle settings now have an optional number-plate lookup foundation: admins can enter a plate, call a Render-only /api/vehicle/lookup proxy, keep provider API keys off the browser, and apply sanitized fuel-type/consumption/tank suggestions with manual fallback.",
      "Workspace creation now records its own member-action Data I/O start/success/error/timeout codes, blocks duplicate create clicks, and verifies after timeouts whether the workspace was actually created before suggesting a retry.",
      "Member-facing onboarding actions now have their own Admin Data I/O flight-recorder group with stable result codes for workspace refresh, create, switch, invite redeem, and profile setup so beta-user failures are visible without DevTools.",
      "Account now has member-facing profile/workspace/invite tools, while service-worker updates activate and reload once automatically when it is safe so users do not have to close/reopen for every deploy.",
      "Regular invited members can now load their workspace through Render state-load after profile setup: the backend verifies active membership, then reads workspace state server-side so member RLS does not force JSON fallback.",
      "Restricted invite links now check the typed email against the invite before sending a Supabase email login code, so a wrong email cannot create/sign in first and only fail after authentication.",
      "Invite onboarding now explains invite codes versus email login codes, restricted invites require the exact login email, returning users are told they only need email + email login code, and invited members can confirm their display name/MobilePay phone through a self-service profile setup RPC.",
      "SQL migrations now have a release-check guardrail that blocks high-risk PL/pgSQL variable names such as actor_email from colliding with table columns, and migration 035 also hardens the payment-status actor-email variable.",
      "Migration 034 fixes invite creation failures caused by an ambiguous actor_email reference in the onboarding rate-limit RPC, and invite onboarding copy now clearly mentions invite links on the login/admin screens.",
      "Data I/O diagnostics now include stable result/status codes such as STARTED, OK, TIMEOUT, INVITE_CREATED, and Supabase error codes, and invite creation has a clearer 15-second pending/success/error flow before refresh can hide the one-time link.",
      "Invite links now use a copyable ?invite=CODE URL that is captured on startup, stored privately for post-login redemption, stripped from browser history, and paired with a clear copy-code fallback for existing users.",
      "Regular member write routes now enforce active-workspace membership server-side: non-admin users can only save their own trip/fuel/booking rows, payment actions must involve the signed-in member, and cross-workspace member IDs are rejected before Supabase RPCs run.",
      "Admin and Test Lab tools now skip duplicate in-flight clicks with a clear skipped Data I/O row instead of starting overlapping admin operations that add stale diagnostic noise.",
      "Debug, load-monitor, and saved Test Lab/Security Health reports now redact more token spellings, auth headers, cookies, Supabase anon/service keys, and camelCase secret names before export or cloud/local storage.",
      "Normal trip, fuel, booking, payment-status, and ledger-directory writes now fail closed through Render instead of falling back to browser-owned Supabase RPC/direct-table writes when proven Render routes are unavailable.",
      "Security Health migration reporting now expects the full shipped Supabase migration set through 032, includes the payment-status action RPC in critical RPC checks, and labels current migrations as current instead of showing later applied IDs as confusing extras.",
      "Ordinary app saves now fail closed away from full-state JSON mirror writes: JSON mirror writes are explicitly classified as manual, safety, or audit-cadence backups, and reasonless forced mirror writes are blocked by validation.",
      "Advanced Admin/Test Lab protections now require the advanced unlock plus typed confirmation and a fresh Render admin-health workspace-admin verification before generated-data, stress, purge, cleanup, cloud-report, Security Health, and production reset actions can run.",
      "Data retention/privacy cleanup now prunes stored Test Lab/Security Health report payloads before local/cloud storage, trims long release-note and diagnostic histories, removes raw browser/Data I/O traces from saved reports, and requires a fresh safety backup before retention cleanup runs.",
      "Destructive admin actions now require a recorded fresh safety backup immediately before continuing, with known backup reasons, a one-minute freshness window, and diagnostics so cleanup/reset/import paths fail closed if the backup step is skipped or stale.",
      "Security Health deep Supabase probes now prefer a Render-owned admin route that verifies the signed-in workspace admin and runs member/RPC checks server-side before falling back to browser probes if the route is unavailable.",
      "Supabase load monitor headline activity now also filters deliberate admin maintenance such as JSON mirror backups, generated Test Lab cleanup, retention preview/cleanup, and local Test Lab bookkeeping so those fast successful safety chores do not raise high-activity warnings.",
      "Supabase load monitor headline activity now filters expected admin diagnostics, Security Health/report-save rows, skip/realtime chatter, and Test Lab bookkeeping so deliberate admin checks do not trigger a scary high-activity warning.",
      "Security Health admin diagnostics now use a longer per-operation stale window and shorter bounded Supabase probes so a healthy Render backend is not shown as a stuck admin-tool timeout while live security checks finish.",
      "Test Lab/Security Health report saves now use a Render /api/admin/reports/save route that verifies workspace admin permission and calls upsert_test_lab_report server-side, removing the browser-owned report RPC save path.",
      "Proven admin paths now fail closed through Render instead of falling back to browser direct writes/RPCs: retention preview/cleanup, generated Test Lab create/cleanup, and report-save JSON mirror fallback are simplified toward one backend-owned path.",
      "Backend path ownership is now documented in a dedicated audit, report-save success clears stale save errors, and report-save failures bubble to the shared admin-tool tracker instead of being silently converted to OK.",
      "Saving Test Lab/Security Health reports to cloud now has a short explicit timeout so a slow Supabase report RPC records a matched finish/error row instead of leaving an admin-tool timeout, and Security Health timeout warnings now explain when Render health is still OK.",
      "Render now applies per-user/per-ledger server-side rate limits to admin, generated Test Lab data, retention, JSON mirror backup, write-context, and trip/fuel/booking/payment write routes so double-clicks or broken clients cannot hammer dangerous backend paths.",
      "Admin diagnostics now has a Render admin health check that verifies signed-in workspace admin permission, Supabase connectivity, an open period, and the mounted backend safety routes before dangerous admin work.",
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
      ? "Update ready — the app will activate it and reload once when safe."
      : cacheMatchesLoadedPage === false
        ? "Update handoff in progress — use Refresh status or reload once if this persists."
        : cacheMatchesLoadedPage === true
          ? "Cache matches this loaded build."
          : "Refresh status; the app can now activate waiting updates automatically.";
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
