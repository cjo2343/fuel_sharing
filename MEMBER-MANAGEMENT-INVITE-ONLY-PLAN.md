# Plan: members join via invites, not direct add-by-email

## Intent
Normal workspace admins should add people only through the **invite flow** (Account →
Workspace invites: create a code, the invitee redeems it by proving they own the
email). The "Member management" panel's **Add member** form lets an admin create a
`ledger_members` row by typing a name/email directly — a parallel onboarding path
that bypasses invite consent, expiry, max-uses, and rate limits. Remove that form
for normal admins; keep editing/deactivating existing members (legitimate admin work).

## Current behaviour
- Panel: `renderMemberManagementPanel()` (app.js ~16032), markup in `index.html`
  (`.member-management-panel`, `#memberManagementForm`, `#memberManagementList`).
  Shown whenever `canManageSettings()` (any workspace admin).
- Add form submit: app.js ~4806 → `/api/members/manage` → `manage_members_backend`
  (server.py ~3533) → `upsert_ledger_member_admin` RPC, which upserts a member row
  by `(ledger_id, name)` — i.e. creates brand-new members.
- Invite path already exists: `createWorkspaceInvite` / `renderWorkspaceInvitesPanel`
  (app.js), gated to workspace admins, backed by the audited `create_ledger_invite` /
  `redeem_ledger_invite` RPCs.

## Changes

DECISION (confirmed): **remove direct add-by-email entirely** — for everyone,
including the app owner. All members join via invite codes. Single onboarding path.

### 1. UI — remove the "Add member" form (Sonnet)
- In `index.html`, remove the add-member inputs + "Add member" button (the
  `#memberManagementForm` row). Keep the member **list** (`#memberManagementList`)
  with edit (name/email/role/MobilePay) and Deactivate — that's managing existing
  members and stays for all admins.
- In `renderMemberManagementPanel()`: drop any add-form rendering/handlers; add a
  one-line note: "To add people, create an invite in Account → Workspace and share
  the code/link. Members join by redeeming it." Link/scroll to the invites panel.
- Remove the now-unused add submit handler (app.js ~4806) and update the panel intro
  copy ("Add invited members, update emails and roles…") to drop the "add" framing.

### 2. Server — reject new-member CREATION via manage-members (Opus, defense-in-depth)
So the rule holds even if someone calls the API directly:
- In `manage_members_backend` / `upsert_ledger_member_admin`, allow workspace admins
  to **update/deactivate existing** members only. Reject creating a brand-new member
  row (a name/email not already active in the workspace) for **everyone** — no app-
  owner exception. New members must come through `redeem_ledger_invite`.
- Keep edit/deactivate working for all admins.
- Auth-sensitive; pair with a guard test asserting a manage-members "create" call for
  a not-yet-existing member is rejected.

## Validation
`npm run validate`, release-readiness, `npm run test:e2e`. Manual: as a normal
workspace admin, confirm the add form is gone and the invite section is the path;
edit/deactivate still work; (if #2 done) a direct manage-members "create" call as a
non-owner admin is rejected. Runtime files change → version bump (build-info +
service-worker + checklist; remember: no embedded double-quotes in the top release
note, or the readiness regex truncates it).

## Notes
- Ties into backlog #2 (sign-in/sign-up flow): invites are the single onboarding
  path; this removes the competing one.
- No data migration needed; existing members are unaffected.
