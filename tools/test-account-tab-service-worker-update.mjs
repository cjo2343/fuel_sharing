import fs from "node:fs";

const index = fs.readFileSync("index.html", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const serviceWorker = fs.readFileSync("service-worker.js", "utf8");
const buildInfo = fs.readFileSync("build-info.js", "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

assert(index.includes('data-view-tab="account">Account</button>'), "Account tab is present in the main section navigation.");
assert(index.includes('id="memberProfileSetupPanel" data-view="account"'), "Member profile setup is scoped to Account view.");
assert(index.includes('id="inviteRedemptionPanel" data-view="account"'), "Invite redemption is scoped to Account view.");
assert(index.includes('id="pwaPanel" data-view="account"'), "PWA/phone setup is scoped to Account view.");
assert(index.includes('workspace-invites-panel hidden" data-view="account"'), "Workspace/invite tools are scoped to Account view.");
assert(index.includes("account-current-workspace-invite-card"), "Current-workspace invite card has a toggleable Account class.");
assert(index.includes("account-active-invites-card"), "Active invites card has a toggleable Account class.");
assert(app.includes('button.classList.toggle("hidden", (isAdminTab && !canManageSettings()) || (isAccountTab && !currentSession));'), "Account tab hides when signed out while Admin remains admin-only.");
assert(app.includes('els.workspaceInvitesPanel.classList.toggle("hidden", !currentSession)'), "Workspace/invite panel is member-facing for signed-in users.");
assert(app.includes('document.querySelectorAll(".account-current-workspace-invite-card, .account-active-invites-card")'), "Admin-only invite cards are toggled inside Account.");
assert(app.includes('card.classList.toggle("hidden", !isCurrentWorkspaceAdmin)'), "Current workspace invite management remains admin-only.");
assert(app.includes('return Boolean(currentSession);'), "Workspace list refresh can run for signed-in regular members through Render.");
assert(app.includes('includeInvites: canManageSettings()') && app.includes('workspaceInviteStatus.invites = Array.isArray(result?.invites) ? result.invites : [];'), "Invite list loads only through the Render workspace-tools lane while regular members still get workspace list.");
assert(serviceWorker.includes('Do not call skipWaiting here'), "Service worker waits for explicit user update instead of activating on install.");
assert(serviceWorker.includes('self.clients.claim()'), "Service worker claims clients after activation.");
assert(app.includes('activateReadyAppUpdate') && app.includes('appUpdateWaitingWorker.postMessage({ type: "SKIP_WAITING" });'), "App activates waiting service worker only after Update now is clicked.");
assert(app.includes('User-requested service-worker update activated; reloading page.') && app.includes('window.location.reload()'), "App performs one controlled reload only after user-requested controllerchange.");
assert(buildInfo.includes('New version available') || buildInfo.includes('manual update prompt') || buildInfo.includes('Update prompt'), "Build-info copy describes manual update prompt behavior.");

console.log("Account tab and service-worker update guardrails passed.");
