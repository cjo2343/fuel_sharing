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

## Progress (2026-07-09) — done vs remaining

**Done — non-disruptive infra groundwork (no user-facing brand change yet):**
- **Phase 1 (domain):** `vehloshare.app` + `www` live on the Pages project; `vehloshare.com` 301 → `.app`. TLS valid.
- **Admin URL cutover** (done ahead of Phase 1 step 4): `admin.vehloshare.app` is the canonical, Cloudflare-Access-gated console; legacy `admin.govehlo.dk` 301s to it; the `/admin` bypass on every public origin is guarded (govehlo-web #82/#83). Supabase magic-link redirect allowlisted for the new host.
- **Phase 2 (partial):** `vehloshare.app` verified as a Sweego sending domain (SPF/DKIM/DMARC all green). Sender **not** switched yet.

**Done — Phase 5 display-string sweep (deliberate early flip, 2026-07-09):** shipped ahead of
cutover on purpose — the site has no traffic yet, so there's no cost to flipping public-facing
copy now. This was a deliberate call, not an accidental merge; the earlier "HOLD until cutover"
framing for this piece is obsolete. govehlo-web **#87** (merge `3bd8e7e`): landing title,
"VehloShare Admin" console title, `manifest.json`, all `email-templates/*.html`, `landing.js`,
the privatliv page. govehlo-mobile **#264** (merge `6364a07`): 14 files incl. the SignInScreen
wordmark and `expo.name` → "VehloShare", plus `485b14e` (iOS location-permission string).

**NOT started — everything gated on the Apple Developer account (deliberate):**
- **Phase 3 (app identity)** — bundle id `dk.govehlo.app`, scheme `govehlo://`, `slug`,
  `applinks:govehlo.app`, home-screen name / `CFBundleDisplayName`. Apple-gated + would break the
  working `govehlo://` dev/auth loop.
- **Phase 4 (universal links)** — needs the Apple Team ID.
- **Phase 5 (repos + services)** — GitHub repo renames, Sentry org display name, Supabase project
  display name still say "govehlo".
- **Phase 2 step 3** — switch the Supabase SMTP sender to `no-reply@vehloshare.app` (govehlo.dk is
  still the live sender — the SENDER domain is held, unlike the display copy above).
- **Phase 6** — the `govehlo.dk` → `vehloshare.app` 301 cutover.

**Sequencing:** No Apple Developer account exists yet — it gates App Store name reservation, the
`app.vehloshare` App ID, iOS entitlements, TestFlight, and Phase 4. The identity/infra sweep
(bundle id, scheme, repo/service renames, domain 301) is one coordinated cutover at launch prep;
the display-string sweep above shipped separately because it carries no Apple/infra risk.

**Nothing is broken.** `govehlo.dk` keeps serving, the `govehlo://` scheme still works, and the
app still builds against the old bundle id — only the visible copy changed. The console is served
from `admin.vehloshare.app` and now correctly titled "VehloShare Admin" (shipped in #87).

---

## Good news up front (things that DON'T have to change)

- **The Supabase database does not move.** Project ref stays `kdudfqzglhydmzntqosb`. No
  data migration — only the project *display name*, the auth redirect allowlist, and the
  SMTP sender address change.
- **Jira keys stay `GV` / `GVM`.** Renaming keys breaks every commit/PR/issue reference.
  Rename only the project *display names*. (Not worth the churn.)
- **The bundle id is invisible to users** — see Decision 1. You are not *forced* to change it.

---

## Domain portfolio (roles are fixed — don't blur them)

Exactly **one** canonical domain: `vehloshare.app`. Everything else is a 301 redirect to it.
Two "canonical" domains = a universal-link mismatch (the entitlement lists only
`vehloshare.app`) plus split-brain email/SEO.

| Domain | Role | Setup |
|---|---|---|
| **vehloshare.app** | **Canonical — the only source of truth.** App `associatedDomains`, universal-link files (`/.well-known/*`), auth/join links, and the Sweego email sending domain all live here. | Cloudflare zone → Pages custom domain; Sweego SPF/DKIM/DMARC; hosts the association files. |
| **vehloshare.com** | Redirect only (brand / type-in protection). | Cloudflare zone + a 301 → `vehloshare.app`. **No** email, **no** universal links, **not** a Pages app domain. |
| **vehloshare.dk** | Optional, redirect only (DK-first market). | Same as `.com`: 301 → `vehloshare.app`. |
| **govehlo.dk** | Legacy — redirect only after cutover (Decision 3). | Keep serving until cutover, then 301 → `vehloshare.app`; keep in the Supabase auth allowlist through the transition. |

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

---

## Cutover-day checklist — what's still held for the Apple-gated cutover

The single record of what still has to happen for the identity/infra sweep (bundle id, scheme,
universal links, repo/service renames, domain 301). The display-string sweep already shipped
early (Phase 5's user-facing copy — see the Progress section above), so item 3's web/email line
below is marked done. Gated on the Apple Developer account; do the rest as one coordinated pass.
Ordered so nothing breaks mid-flip.

### 0. Apple (unblocks the app side)  [YOU]
- [ ] Enroll in the Apple Developer Program.
- [ ] Register App ID **`app.vehloshare`** with the **Associated Domains** capability.
- [ ] Reserve the App Store name **"VehloShare"** (create the app record; no submit needed).

### 1. App identity — mobile (after Apple)  [CLAUDE + YOU]
- [ ] `app.json`: `scheme` → `vehloshare://`; `ios.bundleIdentifier` + `android.package` → `app.vehloshare`; `ios.associatedDomains` → `applinks:vehloshare.app`; `android.intentFilters` host → `vehloshare.app`. (`expo.name` already done, mobile #264.)
- [ ] Native projects: rename `ios/` folder + Xcode project + entitlements; AndroidManifest. (Or `expo prebuild` and commit.) `CFBundleDisplayName` → "VehloShare" is already done in app.json's infoPlist (mobile #404, 2026-07-19) — the label appears after the next prebuild/native build.
- [ ] Repoint the API base: `EXPO_PUBLIC_API_URL` → `https://vehloshare.app` (currently defaults to `https://govehlo.dk` in every `src/lib/*` proxy).
- [ ] **[YOU]** add `vehloshare://auth/callback` to the Supabase redirect allowlist; then rebuild + reinstall all dev/TestFlight builds (the scheme is compiled in — old installs only answer `govehlo://` until rebuilt).
- [x] **Done (2026-07-19, mobile #404):** `govehlo-mobile/src/lib/notifications.ts` — Android
  notification CHANNEL name flipped `'GoVehlo'` → `'VehloShare'`, done deliberately in a
  reviewed PR (not a sweep-agent find/replace; the file is local-only-guarded per the
  worktree-agent leak lesson) with a regression test pinning the channel name.

### 2. Universal links — Phase 4 (after Apple)  [CLAUDE + YOU]
- [ ] Host `/.well-known/apple-app-site-association` (`appID` `TEAMID.app.vehloshare`, paths `/join/*`,`/auth/*`) + `assetlinks.json` on `vehloshare.app`; `_headers` serves AASA as `application/json`, `_middleware` must not intercept `/.well-known/*`.
- [ ] Switch auth `redirect_to` + join links to `https://vehloshare.app/...` (keep `vehloshare://` fallback) + a web fallback page.
- [ ] **[YOU]** Supabase redirect allowlist: add `https://vehloshare.app/**`.

### 3. Public web + email flip  [CLAUDE done / YOU]
- [x] **Done (2026-07-09):** govehlo-web **#87** merged (`3bd8e7e`) — GoVehlo→VehloShare display
  copy (landing, admin, email templates, privatliv, generic push titles) is live. Deliberate early
  flip, not part of the held identity/infra sweep — see the Progress section above.
- [ ] **[YOU]** Supabase → SMTP: switch sender → `no-reply@vehloshare.app`; **re-paste** the rebranded email templates into Supabase (the repo copies aren't live).
- [ ] **[YOU]** Cloudflare Email Routing on `vehloshare.app` (MX + forward rules) for `support@` / `services@vehloshare.app`, mirroring govehlo.dk.

### 4. Domain 301 — LAST  [YOU]
- [ ] **Only after mobile is rebuilt pointing at vehloshare.app:** `301` `govehlo.dk` → `vehloshare.app`. ⚠️ A plain 301 turns the app's `/api/*` **POSTs into GETs (drops the body)** — if any old build might still call govehlo.dk, use **308** for `/api/*` (preserves method+body), 301 for pages.
- [ ] Keep `govehlo.dk` in the Supabase auth allowlist through the transition (Decision 3).

### 5. Repos & services  [YOU]
- [ ] Rename GitHub repos `govehlo-web` → `vehloshare-web`, `govehlo-mobile` → `vehloshare-mobile` (GitHub keeps redirects; Cloudflare Pages + EAS track by repo *id* so usually survive — **verify auto-deploy still fires** and update local git remotes). `fuel_sharing` has no "govehlo" in its name — rename optional.
- [ ] Sentry org + Supabase project **display names** → VehloShare (cosmetic; Supabase ref/URL unchanged).

### 6. Store listings — before any submission  [YOU]
- [ ] `store/apple/*.json`, `store/google/*.json`, `store/privacy-policy.html`,
  `store/apple/review-notes.txt` still carry GoVehlo metadata (name, descriptions, support URL,
  reviewer notes). Rewrite for VehloShare before the first App Store / Play submission — these
  aren't touched by the code sweeps above.

### 7. Cleanup  [YOU + CLAUDE]
- [ ] Retire `govehlo.dk`'s Sweego records + the old sender once nothing references them.
- [ ] **[CLAUDE]** sweep the `CLAUDE.md` files + remaining internal-doc references GoVehlo → VehloShare.
- [ ] Update the mobile `PRIVACY_URL` / support mailto (`src/screens/CarProfile/CarProfilePrivacyScreen.tsx`) to `vehloshare.app` once inbound routing exists.
