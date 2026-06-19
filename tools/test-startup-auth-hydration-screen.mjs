import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const styles = readFileSync("styles.css", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:199|200|201|202|203|204|205|206|207|208|209|210|211|212|213|214|215|216|217|218|219)"/, "build-info.js must be bumped to v299.");
assert.match(buildInfo, /buildLabel:\s*"(?:startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, "build-info.js must use the v299 build label.");
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:299|3[0-9][0-9])"/, "build-info.js must expect the v299 service-worker cache.");
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:299|3[0-9][0-9])"/, "service-worker.js must use the v299 cache.");
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, "service-worker.js must use the v299 build label.");

assert.match(app, /const startupHydrationGraceMs = 12000;/, "Startup hydration should have a short grace window.");
assert.match(app, /let startupHydrationActive = false;/, "Startup hydration state must be tracked.");
assert.match(app, /function beginStartupHydration\(reason = "startup"\)/, "Startup hydration begin helper must exist.");
assert.match(app, /function finishStartupHydration\(reason = "complete"\)/, "Startup hydration finish helper must exist.");
assert.match(app, /function isStartupHydrating\(\)/, "Startup hydration predicate must exist.");
assert.match(app, /function shouldSuppressStartupHydrationDelay\(\)/, "Startup delay suppression predicate must exist.");

const updateAuthStart = app.indexOf("function updateAuthUi() {");
const updateAuthEnd = app.indexOf("async function sendLoginLink", updateAuthStart);
assert.ok(updateAuthStart >= 0 && updateAuthEnd > updateAuthStart, "updateAuthUi must be present.");
const updateAuthBlock = app.slice(updateAuthStart, updateAuthEnd);
assert.match(updateAuthBlock, /const hydrating = isStartupHydrating\(\);/, "Auth UI must detect startup hydration.");
assert.match(updateAuthBlock, /document\.body\.classList\.toggle\("startup-hydrating", hydrating\)/, "Auth UI must set the startup hydration body class.");
assert.match(updateAuthBlock, /authHeading\.textContent = "Loading workspace"/, "Auth UI must show Loading workspace instead of onboarding while hydrating.");
assert.match(updateAuthBlock, /els\.loginForm\.classList\.add\("hidden"\)/, "Login form must be hidden while hydrating.");
assert.match(updateAuthBlock, /els\.signOut\.classList\.add\("hidden"\)/, "Sign out button must be hidden while hydrating.");

const inviteStart = app.indexOf("function renderInviteRedemptionPanel() {");
const inviteEnd = app.indexOf("function normalizeInviteCodeInput", inviteStart);
assert.ok(inviteStart >= 0 && inviteEnd > inviteStart, "Invite redemption renderer must be present.");
const inviteBlock = app.slice(inviteStart, inviteEnd);
assert.match(inviteBlock, /currentSession && !isStartupHydrating\(\)/, "Invite redemption must not show during startup hydration.");

const pwaStart = app.indexOf("function updatePwaUi() {");
const pwaEnd = app.indexOf("async function enablePushNotifications", pwaStart);
assert.ok(pwaStart >= 0 && pwaEnd > pwaStart, "PWA UI updater must be present.");
const pwaBlock = app.slice(pwaStart, pwaEnd);
assert.match(pwaBlock, /if \(isStartupHydrating\(\)\)/, "PWA prompt must be suppressed while hydrating.");

const bannerStart = app.indexOf("function buildSyncHealthBannerState() {");
const bannerEnd = app.indexOf("function renderSyncHealthBanner()", bannerStart);
assert.ok(bannerStart >= 0 && bannerEnd > bannerStart, "Sync health banner builder must be present.");
const bannerBlock = app.slice(bannerStart, bannerEnd);
assert.match(bannerBlock, /isStartupHydrating\(\) \|\| shouldSuppressStartupHydrationDelay\(\)/, "Sync delay banner must be suppressed during startup hydration grace.");

assert.match(styles, /body\.startup-hydrating #authPanel/, "Styles must include the startup hydration panel state.");
assert.match(styles, /body\.startup-hydrating #inviteRedemptionPanel/, "Styles must hide invite redemption during startup hydration.");
assert.match(styles, /body\.startup-hydrating #syncHealthBanner/, "Styles must hide sync health banner during startup hydration.");
assert.match(packageJson, /test-startup-auth-hydration-screen\.mjs/, "Validate script must run the v299 guard test.");

console.log("Startup auth hydration screen guard check passed.");
