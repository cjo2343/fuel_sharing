# Release verification - 2026-09-05

This is partial evidence, not a release approval. No attestation was signed, no
production settings were changed, and no production data was exported or modified.

## Baseline

Fetched mains: platform `9a94995`, mobile `8e33333`, web `06795fd`.
The owner confirmed migration 210 was applied. The post-merge umbrella run also
read the live migration tracker and reported mobile generation 210 <= applied 210.
Cross-repo migration versions, generated types and the role matrix passed.
The remaining red release gates are controller identity, backup evidence and
external attestations, not a missing migration.

## Checks performed

| Check | Observed result | What remains |
| --- | --- | --- |
| Production public Realtime join | Hardened `probe:realtime-public-access` returned `PrivateOnly: This project only allows private channels`, exit 0 | Authenticated member join on a selected real workspace, dashboard observation, field-build confirmation |
| Apple association URL | `https://vehloshare.app/.well-known/apple-app-site-association` returned HTTP 404, text/plain, at 17:17 UTC | Verify `APPLE_TEAM_ID` against the signed app, configure the Pages deployment and verify HTTP 200 JSON and on-device invite opening |
| Android association URL | `https://vehloshare.app/.well-known/assetlinks.json` returned HTTP 404, text/plain, at 17:17 UTC | Production signing fingerprints, Pages configuration, HTTP 200 JSON and Android device verification |
| New native build | Owner reports the latest changes are not yet installed; using Xcode, not TestFlight | Build/install, then run the device checklist below |
| Supabase dashboard | Sign-in completed, but computer-use stopped returning readable dashboard content | Confirm current plan, backup window, latest successful backup and PITR status directly; the July Free-plan record is not a new account observation |
| Controller identity | Not supplied during this verification | Exact public controller name, business identifier if applicable, and contact address; never infer these from a GitHub profile |

The Realtime run used a generated topic and the application's public anonymous
key. It sent only a join request, no presence payload or broadcast, and did not
query workspace rows. Member phase was explicitly skipped. The full
`realtime_public_access_closed` attestation therefore remains unverified.

The two 404s match the association functions' intentionally unconfigured response,
but do not alone prove which production environment variables are absent. Do not
invent Team IDs or signing fingerprints to make the endpoints return 200.

There is also a contract discrepancy to resolve before signing the app-link
attestation: it asks for `/auth/*`, while the current AASA function claims only
`/join/*` and mobile auth uses `vehloshare://auth/callback`. Configuring a Team ID
alone will not satisfy that full attestation. Decide and test the supported auth
redirect contract; do not simply sign the current note or add an untested route.

## Verification-tool correction

The old probe returned exit 0 for any refused public join, including Unauthorized
and rate limiting. The revised probe requires the documented `PrivateOnly` reason;
other refusals return exit 2 (inconclusive). It also requires a selected workspace
for the member phase, validates inputs, waits for the matching join reply, redacts
credentials from errors, and does not diagnose all member connections as broken
from one failed token. Socket behavior is covered by 28 offline CLI tests wired
into `npm run validate`; validation itself never probes production.

All 28 tests and the full `npm run validate` suite passed for this change, along
with JavaScript syntax checks and `git diff --check`.

Reference: [Supabase Realtime settings](https://supabase.com/docs/guides/realtime/settings)
and [operational error codes](https://supabase.com/docs/guides/realtime/error_codes).

## Xcode device pass

Use a test workspace and willing test members. Do not broadcast a real person's
location without their consent. Record the app version, build number and commit.

1. Start sharing, then Stop while an ETA refresh or GPS read is pending. Sharing
   must stay stopped, with no late position appearing on the second device.
2. Stop and explicitly start a replacement session. A delayed old stop must not
   remove the replacement.
3. Opt out of map sharing, restart the app and verify that loading the saved
   preference does not temporarily enable map sharing.
4. Background the app during a pending foreground GPS read, then return. Verify
   foreground cancellation and the separately consented background behavior.
5. Switch workspaces while re-keying is pending. No position or accepted key may
   attach to the wrong workspace.
6. Open a real invite link after the association URL is configured. Confirm the
   intended screen in both cold-start and already-running states.
7. In the exact release build, send a non-personal test error with diagnostics
   consent enabled and confirm Sentry maps it to the expected TypeScript file and
   line, with matching release/dist. Do not count a server-side Sentry issue or a
   locally generated sourcemap as proof of native symbolication.

Only after the relevant checks are actually performed should the operator update
`docs/release-attestations.json`, using their own verification date and identity.
