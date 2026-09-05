# VehloShare review and hardening - 2026-09-05

## Review baseline and scope

Fetched mobile 9563d07, platform 24379da, and web fe62798 into separate clean worktrees.
The existing website screenshot work was preserved in its original checkout.
This pass concentrated on the newly merged live-location flow, database authorization,
cross-repo RPC wiring, shared API failure handling, dependencies, and release evidence.
The full automated suites cover considerably more surface than the changed files.
This is not a claim that every screen was exercised on a physical device or that
production configuration and load capacity have been verified.

## Fixes prepared

- P1: An automatic ETA refresh used the same command as an explicit start. If a stop
  won the race, the delayed refresh could recreate the share. Migration 210 introduces
  refresh_on_my_way, which checks the observed start timestamp and public key under
  the same transaction lock as the existing command.
- P1: A delayed stop could clear a replacement share. clear_on_my_way_if_current
  checks the observed start timestamp under that lock. Admins keep their existing
  permission to stop a stuck share; ordinary bystanders do not gain it.
- P1: A pending GPS read could broadcast after map opt-out, a stop, or backgrounding.
  The sender now checks current consent/session/foreground state again after the read.
- P1: Startup could re-key before the saved map preference loaded. Automatic map
  sharing now requires loaded, acknowledged consent.
- P1: A stopped share or a workspace switch could be followed by a late key response.
  Local stops silence sending immediately; late responses are checked against the
  current context. A realtime update for our own accepted key remains valid.
- P2: Two devices could repeatedly replace each other's signing keys. A device that
  already holds a different key for the booking no longer automatically competes.
- P1: A workspace member could replay an already signed position within the same
  session to move the dot backwards or extend its freshness. Accepted timestamps must
  advance within the same key/session; senders allocate monotonic timestamps even if
  their device clock is adjusted.
- P1: Shared server fetch deadlines ended at response headers. Stalled JSON/error
  bodies could hang authentication, rate checks, service-role reads and push processing.
  The shared timeout now accepts a body consumer that runs within the original budget;
  the common auth and push helpers use it.
- P2: Malformed schema-floor strings such as "200oops" were partially parsed into a
  real minimum-version requirement. Only complete integer strings are now accepted.
- Patched both vulnerable xmldom resolutions to 0.8.15 and 0.9.12. Preserved the rest
  of the dependency lock, including optional packages needed by Linux CI.
- Regenerated the canonical database types and vendored identical copies into both
  clients; updated the mobile generation digest and the web migration expectation.

## Validation and deployment

Regression coverage includes stopped/old-key/old-session refreshes, stale stops,
admin/bystander permissions, pending GPS cancellation, consent loading, late key
registration, workspace changes, replayed packets, and response bodies that stall
after headers have arrived. Native background delivery still needs a device pass.

Merge/deploy order:
1. Web companion PR (declares migration 210; existing clients remain compatible).
2. Platform PR, then manually apply 210_on_my_way_refresh_fence.sql in Supabase.
3. Mobile PR and a new app build/update after the SQL is confirmed applied.

The old commands remain for existing builds. The new app must use the conditional
commands to receive the race protection. No production migration was applied here.
Reproduce checks with mobile typecheck/test/lint, web node:test and Wrangler builds,
and platform validate/check:role-matrix/check:schema-equivalence.

Recorded results: mobile 4,936 tests passed; web 1,161 tests passed; database role
matrix 389 cases passed; schema replay 762 objects identical. Mobile typecheck/lint
and an iOS production JavaScript export passed. Web syntax, admin lint, Pages bundle
and scheduler dry-run bundle passed. Full platform validation passed.

## Still requires work or evidence

- Release checks still find the public controller-identity placeholder, a documented
  Free-plan backup posture, and unverified app-link/Sentry/Realtime attestations.
  These are missing release evidence, not proof of a currently exploitable Realtime
  configuration. Confirm the actual settings before changing the records.
- npm audit still reports decode-uri-component through navigation and image-size
  through Metro tooling. decode-uri-component 0.5.0 is patched but ESM-only, while
  the installed query-string 7 uses its CommonJS API; it needs a tested compatibility
  change rather than a blind override. No patched image-size release is published.
  The XML issues are fixed; an audit-clean claim would be false.
- Some provider-specific fetch consumers remain outside the common auth/push helpers.
  Extend the body-deadline pattern when hardening those integrations.
- This pass did not perform a new production restore drill, native background test,
  penetration test against live customer workspaces, or a 100-concurrent-user load test.
- Jira credentials were not available in these checkouts. Follow-ups below are recorded
  here for triage; no Jira tickets were created.

## Product suggestions

The app already has handover capture, vehicle documents, fuel provenance, forecasting,
and month/year reports. Build on those rather than adding competing summary screens.

1. Booking waitlist: ask to be notified when a conflicting booking is cancelled or
   shortened. Start with notifications; automatic reservations need a separate,
   explicit acceptance and expiry flow.
2. Temporary driver access: a scoped invitation for a date range, with automatic
   expiry enforced by the database. Keep financial history and member administration
   outside guest permissions.
3. Next-driver readiness: combine existing handover, unresolved damage, missing fuel
   receipts and upcoming booking data into one task tied to the next booking. Show
   who needs to act and what is still unknown, with direct links to finish each task.

The next refactor worth doing is extracting the live-sharing lifecycle into a small
tested coordinator. It now spans keys, consent, GPS, background sessions and database
state; tests should specify event ordering before moving the hook code.
