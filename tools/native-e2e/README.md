# Native test environment

Status: setup contract, not a working native test runner yet. The existing
`tools/simulator` drives real SQL in a disposable Postgres container; its dashboard
phone views are not the installed React Native application.

## What the operator needs to create

A hosted project is **optional for local development**. A local Supabase stack can
run Auth, PostgREST, Realtime and Postgres in Docker without production access. A
separate hosted project is useful when a cloud iOS runner must reach those services.

For that hosted environment:

1. Create an **empty** Supabase project named `vehloshare-staging` in an EU region.
   Use the normal project defaults; do not upgrade or enable paid add-ons just for
   this first smoke test. Check your organisation's allowance before creating it.
2. Generate a unique database password and keep it in your password manager.
   Do not paste it into chat, source code, issue descriptions or a PR.
3. Share only the **project URL / project reference** and confirm that the project
   is disposable. No production export, user copy or production credentials.
4. When the runner is ready, use a GitHub Actions environment named `native-e2e`
   on `cjo2343/vehloshare-mobile`, restricted to the selected branch `main`, where
   your GitHub plan supports private-repository environments. Start with manual
   dispatch on trusted `main` only. Required reviewers are not available on
   private repositories on Free/Pro/Team; do not rely on that approval feature.
   If environment protection is unavailable, leave cloud execution disabled until
   a reviewed alternative is in place. Local testing does not need a GitHub upgrade.
5. Once the runner PR defines the exact variable names, store its **test-project
   publishable key** and **secret key** in that environment. Prefer these new key
   types over legacy `anon` and `service_role` keys. A publishable key is client
   configuration, not an admin credential. A secret key bypasses RLS and belongs only in the fixture setup
   process, never the mobile build, screenshots, logs or uploaded artifacts.

Do not change production Auth redirects, Realtime settings, email delivery, push
credentials, Sentry or MobilePay configuration for this setup. No new SMTP, custom
domain, paid plan or manually created personal accounts is needed for the first
booking-completion test. We will create synthetic accounts through the Auth admin
API with test-only addresses and use ordinary password login in the application.

## Implementation acceptance criteria

The native runner is a separate slice; this document does not attest that any of
the following checks have passed:

- Apply the consolidated schema only to the explicitly allowlisted, empty local
  or staging database. Refuse the production reference and any unapproved host.
- Use a distinct app identifier (`app.vehloshare.e2e`), storage namespace and build
  identity. A test build must fail on missing backend configuration instead of
  falling back to production. Disable production OTA updates and integrations.
- Seed only synthetic, run-scoped users/workspaces. Use authenticated product
  RPCs for domain data; use service-role privileges only where fixture setup or
  narrowly scoped cleanup requires them.
- Drive the actual iOS app with Maestro: sign in, open an ended booking from
  Home, enter final odometer, complete it, relaunch and verify persistence.
- Assert database results separately: exactly one linked trip, correct distance
  and odometer, booking completion, and no invented fuel purchase. Later journeys
  cover deferred refuelling, offline recovery and two-user Realtime switching.
- Cleanup must be limited to resources recorded for that run. Never reset an
  arbitrary connected database or erase the user's normal simulator app.
- Upload a sanitised result, tested commit SHAs and failure screenshots. Do not
  upload credentials, sessions, raw Auth responses or unrestricted request logs.
- The admin Health page must distinguish passed, failed, setup failure, skipped,
  stale and never-run tests. A simulation pass must never imply native coverage.

## What remains physical-device testing

Remote push delivery, camera quality/receipt recognition, background behaviour,
MobilePay handoff and release Sentry symbolication need separate device/release
checks. A native simulator pass does not prove production capacity or recovery.

References: [Supabase local development](https://supabase.com/docs/guides/local-development/cli/getting-started),
[API key roles](https://supabase.com/docs/guides/getting-started/api-keys),
[GitHub environment protection availability](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[Expo native E2E testing](https://docs.expo.dev/eas/workflows/examples/e2e-tests/).
