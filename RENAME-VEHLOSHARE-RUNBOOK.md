# Rename runbook: GoVehlo → VehloShare (vehloshare.app)

Decision (2026-07-09): rebrand **GoVehlo → VehloShare**, primary domain **vehloshare.app**.
The **"Vehlo" brand root survives** — this is a `Go`-prefix → `Share`-suffix swap plus a
domain move, not a new identity. The Vehlo mark/icon barely changes; the churn is in the
wordmark and every `govehlo.*` identifier.

**Hard constraint:** land this **before the first TestFlight / App Store submission.**
Changing the app's bundle id after submission means a *new app* (lost reviews/history).
We are pre-launch (DEMO_MODE gated, GVM-117 TestFlight pass still open), so this is the
cheapest this will ever be. Every week of new infra on `govehlo.*` raises the cost.

Legend: **[YOU]** = operator/dashboard/DNS action · **[CLAUDE]** = code/config change I do.

---

## Good news up front (things that DON'T have to change)

- **The Supabase database does not move.** Project ref stays `kdudfqzglhydmzntqosb`. No
  data migration — only the project *display name*, the auth redirect allowlist, and the
  SMTP sender address change.
- **Jira keys stay `GV` / `GVM`.** Renaming keys breaks every commit/PR/issue reference.
  Rename only the project *display names*. (Not worth the churn.)
- **The bundle id is invisible to users** — see Decision 1. You are not *forced* to change it.

---

## Decisions to lock before starting

### Decision 1 — Bundle id
**LOCKED (2026-07-09): change to `app.vehloshare`** (iOS `ios.bundleIdentifier` + Android
`android.package`). Cheap now — no App Store record or EAS build exists yet, so EAS provisions
the new id from the first build with nothing to migrate; and it's the only free window (locked
after first submission). The Associated-Domains appID becomes `TEAMID.app.vehloshare`.
**[YOU]** register the new App ID in the Apple Developer portal with the **Associated Domains**
capability enabled before the first EAS build.

### Decision 2 — App scheme `govehlo://` → `vehloshare://`?
**LOCKED (2026-07-09): yes → `vehloshare://`.** Pre-launch, low risk; installed-app deep links
only, no external dependency.

### Decision 3 — Keep `govehlo.dk` alive during transition?
**LOCKED (2026-07-09): yes.** 301-redirect `govehlo.dk` → `vehloshare.app` and keep it in the
Supabase auth allowlist for a while — confirmation emails/join links already sent point at the
old host. Retire only once nothing references it.

---

## Phase 0 — Availability (before committing)

1. **[YOU] App Store name** — check "VehloShare" is free (see the dedicated section below).
   If free, **reserve it** by creating the app record in App Store Connect (no need to submit).
2. **[YOU] Domain** — register `vehloshare.app` (Cloudflare Registrar is ideal — DNS lands in
   the same place as the Pages project).
3. **[YOU] Trademark sanity** — quick search on EUIPO (EU) and DKPTO (Denmark) for
   "VehloShare" / "Vehlo" in the relevant classes. Not a legal opinion, just a collision check.
4. **[YOU] Socials/handles** — grab the obvious handles so they're not sniped mid-rename.

---

## Phase 1 — Stand up the domain  [YOU]

1. Add `vehloshare.app` to Cloudflare (nameservers / zone).
2. Add `vehloshare.app` (and `www`) as **custom domains on the govehlo-web Pages project**.
3. Decide canonical = `vehloshare.app`. Leave `govehlo.dk` serving for now (redirect comes at
   cutover, Phase 6).
4. If admin is renamed too: plan `admin.vehloshare.app` (mirrors `admin.govehlo.dk`), Cloudflare
   Access rule updated. (Can defer — admin can stay on govehlo.dk longer than the app domain.)

---

## Phase 2 — Email (Sweego + Supabase SMTP)  [YOU]

Mirrors the setup we did for `govehlo.dk`:
1. **[YOU]** Add `vehloshare.app` as a sending domain in **Sweego**. Set the CNAMEs it gives you:
   SPF/bounce (`swg.vehloshare.app`), DKIM (`sweego1._domainkey.vehloshare.app` → the DKIM id
   **for this domain** — don't reuse the govehlo.dk id), and **one** DMARC record on
   `_dmarc.vehloshare.app`.
2. **[YOU]** New sender `no-reply@vehloshare.app`; alias `services@vehloshare.app` for alerts.
3. **[YOU]** Supabase → Auth → Emails (SMTP): change the **sender address** to
   `no-reply@vehloshare.app` once the domain verifies in Sweego. Keep the old sender working
   until then.

> Gotchas we already hit: DKIM CNAME must point at *this* domain's DKIM id (id mismatch = 550
> "Unknown domain"); only **one** DMARC record per name or it's ignored.

---

## Phase 3 — App identity (mobile)  [CLAUDE + YOU]

1. **[CLAUDE]** `app.json`: `name` → "VehloShare", `slug`, `scheme` → `vehloshare` (Decision 2),
   `ios.associatedDomains` → `applinks:vehloshare.app`, `android.intentFilters` host →
   `vehloshare.app`, and `ios.bundleIdentifier` / `android.package` **only if** Decision 1 = change.
2. **[CLAUDE]** Propagate into the **committed native projects** (they're currently stale — the
   GVM-18 app.json config was never prebuilt in): add the Associated Domains entitlement to
   `ios/GoVehlo/*.entitlements`, the intent filter to `AndroidManifest.xml`, and update the
   URL scheme in `Info.plist`. (Or run `expo prebuild` and commit the result.)
3. **[YOU]** Apple Developer portal: if Decision 1 = change bundle id, register the new App ID
   **with the Associated Domains capability enabled**, and update provisioning/signing.

---

## Phase 4 — Universal links (the parked GVM-88 / GVM-23, now on vehloshare.app)

Do this *after* the domain resolves on Pages.
1. **[YOU]** Provide the **Apple Team ID** (10-char, from the Developer account) and — for
   Android, later — the **release signing-key SHA-256 fingerprint** (from the EAS/Play keystore).
2. **[CLAUDE]** Host on `vehloshare.app` via the Pages project:
   - `/.well-known/apple-app-site-association` — JSON, no extension, `appID`
     `TEAMID.<bundleid>`, `paths` `["/join/*", "/auth/*"]`.
   - `/.well-known/assetlinks.json` — package `<bundleid>` + the SHA-256 fingerprint.
   - `_headers`: serve AASA as `application/json`; make sure `_middleware.js` / `_redirects`
     do **not** intercept `/.well-known/*` (must be a plain 200, no redirect).
3. **[CLAUDE]** Switch auth `redirect_to` + join links to `https://vehloshare.app/...`, keeping
   `vehloshare://` as a fallback. Add a lightweight web fallback page for no-app / wrong-device.
4. **[YOU]** Supabase → Auth → URL config: add the `https://vehloshare.app/...` redirect URLs to
   the allowlist (keep the old ones during transition).
5. **Verify:** `curl -I https://vehloshare.app/.well-known/apple-app-site-association` → 200 +
   `content-type: application/json`, no redirect; Apple's AASA validator; then the real
   end-to-end "email link opens the app" test **on TestFlight** (not the simulator — Apple's
   CDN caches AASA; ties into GVM-117).

---

## Phase 5 — Repos, services, and code strings  [CLAUDE + YOU]

1. **[YOU]** Rename GitHub repos `govehlo-web`/`govehlo-mobile`/`fuel_sharing` →
   `vehloshare-*` (GitHub keeps redirects, but update: local remotes, Cloudflare Pages git
   integration, EAS project link, any CI secrets/URLs).
2. **[YOU]** Sentry: rename the `govehlo` org/project (or create new) and update DSNs.
3. **[YOU]** Supabase: rename the project *display name* (ref/URL unchanged).
4. **[YOU]** Better Stack monitors + `/api/health` targets → new domain.
5. **[CLAUDE]** Code sweep across all three repos: user-facing "GoVehlo" → "VehloShare",
   scheme, deep-link hosts, email templates, `manifest.json`, `CLAUDE.md`s, and any hardcoded
   `govehlo.dk` / `govehlo.app` URLs. Jira project *keys* stay `GV`/`GVM`.

---

## Phase 6 — Cutover & cleanup  [YOU]

1. Flip canonical to `vehloshare.app`; add 301 `govehlo.dk` → `vehloshare.app`.
2. Keep `govehlo.dk` in the Supabase auth allowlist + the old email sender alive until nothing
   references them, then retire.
3. Update landing/admin copy, App Store metadata, screenshots.
4. Final end-to-end pass on a TestFlight build: signup email from `@vehloshare.app`, link on
   `vehloshare.app`, opens the app, join-by-link works.

---

## Rollback / safety

- Nothing is destructive if `govehlo.dk` + the old sender stay alive through the transition.
- The Supabase DB never moves, so there is **no data-loss path** in this rename.
- If a step misbehaves, the app keeps working on `govehlo.*` until you cut over.

---

## How to check the App Store name is free

The **authoritative** check is in **App Store Connect** (needs a paid Apple Developer account):

1. Go to **App Store Connect → Apps → the blue "+" → New App**.
2. In the **Name** field, type **VehloShare**. Apple enforces **global uniqueness** on app
   names — if it's taken you get *"The App Name you entered is already being used."*
3. If it's accepted, **creating the app record reserves the name** — you do **not** have to
   submit anything. Do this early so nobody grabs it mid-rename.

Notes:
- The app **Name** (≤30 chars) is independent of the **bundle id** and the **domain** — a free
  name doesn't guarantee a free bundle id, and vice-versa.
- Quick non-authoritative pre-checks: search the App Store app for "VehloShare"; a web search
  (done 2026-07-09 — no obvious car-sharing collision). These don't replace the ASC check.
- Trademark (EUIPO/DKPTO) is a *separate* question from Apple's name uniqueness.
