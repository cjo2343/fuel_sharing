---
name: ship
description: >
  Ship the current change the GoVehlo way: branch, PR for the user to merge, then
  post-merge sync and Jira transition. Use when work is ready for review, when the
  user says "open a PR", "ship it", or "merged", or runs /ship.
user-invocable: true
---

# Ship a change (fuel_sharing → Jira project GV)

The user merges every PR themselves. Never merge, never push to main.

## 1. Before the PR

- Run the repo checks: `npm run validate` (always); `npm run test:e2e` if the change
  touches trips/fuel/payments/permissions logic.
- If the change includes a migration: confirm the `/new-migration` checklist is
  complete, and remember the SQL is applied manually by the user after merge.

## 2. Branch + PR

- Branch naming: `feat/short-slug-gv-NN`, `fix/…`, or `chore/…` matching the Jira key.
- Commit message: conventional prefix + `(GV-NN)`.
- `gh` must run with inherited tokens stripped:
  `env -u GH_TOKEN -u GITHUB_TOKEN gh pr create --title "…" --body "…"`.
- PR body: what/why, verification evidence, and — if SQL is included — a bold
  **"Apply manually in the Supabase SQL Editor after merge"** note.

## 3. Move the Jira ticket to In Progress (if not already)

Jira: govehlo.atlassian.net, user `jira@chrjohn.dk`. The API token is the `ATATT…`
string inside `.claude/settings.local.json` (gitignored — never commit or print it):

```sh
TOKEN=$(grep -oE 'ATATT[A-Za-z0-9._=-]+' .claude/settings.local.json | head -1)
curl -s -u "jira@chrjohn.dk:$TOKEN" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"transition":{"id":"31"}}' \
  https://govehlo.atlassian.net/rest/api/3/issue/GV-NN/transitions
```

Transition ids — **GV: 31 = I gang, 51 = Færdig. GVM: 21 = In Progress, 31 = Done.**
(Issue creation, if needed: GV issuetype `10004` "Opgave", GVM issuetype `10041`;
POST `/rest/api/3/issue` with an ADF description.)

## 4. After the user says "merged"

1. `git checkout main && git pull` (stash any intentional local-only edits first,
   pop after).
2. Delete the feature branch (local + remote).
3. Transition the ticket to done (GV: id 51; GVM: id 31) — expect HTTP 204.
4. If the PR contained SQL: remind the user to apply it in the Supabase SQL Editor,
   and don't build on it until they confirm.

## Cross-repo note

govehlo-mobile uses project **GVM** and has its own copy of this skill; govehlo-web
uses **GV**. The Jira token lives only in THIS repo's `.claude/settings.local.json` —
run Jira curl commands from the fuel_sharing directory.
