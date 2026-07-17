# Opbevaringsfrister pr. dataklasse

Status pr. 2026-07-17 — **ærlig** opgørelse: kolonnen "Håndhævelse" siger, om fristen
faktisk håndhæves automatisk, kræver manuel handling, eller er et kendt hul.

| Dataklasse (tabeller) | Frist | Håndhævelse |
|---|---|---|
| Konto/identitet (Supabase Auth, `ledger_members`) | Til kontosletning | **Automatisk ved sletning**: `delete_my_account` anonymiserer (se deletion-limitations.md) |
| Regnskabsdata (`trips`, `fuel_payments`, `workspace_expenses`, `vehicle_repairs`, `recurring_expenses`, `settlement_*`, `car_bookings`) | Workspacets levetid; består pseudonymiseret efter medlems kontosletning | Ingen aldersgrænse — bevidst (fælles regnskab; bogføringshensyn) |
| Aktivitetsfeed + chat (`ledger_events`, `messages`) | Workspacets levetid | Ingen aldersgrænse — **bevidst produktbeslutning** (feedet ER historikken); aktørfelter anonymiseres ved kontosletning |
| Push-tokens (`expo_push_tokens`) | Kontosletning ELLER 180 dages inaktivitet | **Automatisk** fra migration 130: dagligt sweep via `run_operational_retention` (GV-309) — token gendannes ved næste app-åbning |
| Legacy web-push (`push_subscriptions`) | Udfaset | **Tømt i migration 130** (dødt PWA-levn); tabel droppes i GV-311 |
| Events med udløb (`ledger_events.expires_at`) | Ved udløb | **Automatisk** fra migration 130 (p.t. skriver ingen kode udløbsdatoer — sweep'et er fremtidssikring) |
| Soft-slettede rækker (`deleted_at` på trips/bookinger m.fl.) | ⚠️ Ingen frist | **ÅBEN BESLUTNING**: beholdes p.t. på ubestemt tid (muliggør fejlretning/fortryd); kandidat til f.eks. 90-dages purge i retention-sweep'et |
| Operatør-audit (`owner_activity_log`) | ⚠️ Ingen frist | **ÅBEN BESLUTNING**: aktørfelter nulles ved kontosletning, men rækker består; foreslået frist 24 mdr. |
| Rate-limit-registre (`ledger_onboarding_rate_limits`, `owner_api_rate_limits`) | Kort teknisk levetid | Renses ved kontosletning; ingen aldersgrænse i øvrigt (lav risiko — nøgler/e-mails) |
| Fejltelemetri (Sentry EU) | Sentrys event-TTL | [OPERATØR-FAKTA: standard 90 dage — bekræft i Sentry-projektet] |
| Backups (Supabase) | Backup-vinduet | Supabase-styret — se backup-restore.md [OPERATØR-FAKTA: plan + vindue] |

## Det automatiske sweep (migration 130, GV-309)

`run_operational_retention(p_stale_push_days := 180, p_dry_run := false)` —
service-role-only, kaldes dagligt via `/api/hooks/retention-cleanup`
(RETENTION_CLEANUP_KEY). Rører **kun** driftsdata: inaktive push-tokens og
eksplicit udløbne events. **Aktivitetsfeedet slettes aldrig efter alder** —
migration 009's farlige 30-dages-default er samtidig gjort ukaldbar for klientroller.

Verifikation af at sweep'et faktisk kører: hook'en returnerer tællinger; operatøren
kan køre dry-run i SQL-editoren:
`select public.run_operational_retention(180, true);`

## Åbne beslutninger (til operatøren)

1. Purge-frist for soft-slettede rækker (forslag: 90 dage efter `deleted_at`).
2. Frist for `owner_activity_log` (forslag: 24 måneder).
3. Skal helt inaktive workspaces (alle medlemmer væk) hård-slettes efter en frist?
