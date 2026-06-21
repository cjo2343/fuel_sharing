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
assert(app.includes('return Boolean(supabaseClient && currentSession);'), "Workspace list refresh can run for signed-in regular members.");
assert(app.includes('if (canManageSettings()) {') && app.includes('workspaceInviteStatus.invites = [];'), "Invite list loads only for admins while regular members still get workspace list.");
assert(serviceWorker.includes('self.skipWaiting();'), "Service worker requests immediate activation.");
assert(serviceWorker.includes('self.clients.claim()'), "Service worker claims clients after activation.");
assert(app.includes('newWorker.postMessage({ type: "SKIP_WAITING" });'), "App tells waiting service worker to activate.");
assert(app.includes('window.location.reload()'), "App performs one controlled reload after controllerchange.");
assert(buildInfo.includes('Automatic update handoff in progress') || buildInfo.includes('waiting service workers activate themselves'), "Build-info copy describes automatic update handoff without manual refresh buttons.");

console.log("Account tab and service-worker update guardrails passed.");
