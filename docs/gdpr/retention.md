# Opbevaringsfrister pr. dataklasse

Status pr. 2026-07-21 — **ærlig** opgørelse: kolonnen "Håndhævelse" siger, om fristen
faktisk håndhæves automatisk, kræver manuel handling, eller er et kendt hul.

| Dataklasse (tabeller) | Frist | Håndhævelse |
|---|---|---|
| Konto/identitet (Supabase Auth, `ledger_members`) | Til kontosletning | **Automatisk ved sletning**: `delete_my_account` anonymiserer (se deletion-limitations.md) |
| Regnskabsdata (`trips`, `fuel_payments`, `workspace_expenses`, `vehicle_repairs`, `settlement_*`) | Workspacets levetid; består pseudonymiseret efter medlems kontosletning | Ingen aldersgrænse for aktive rækker — bevidst (fælles regnskab; bogføringshensyn) |
| Skader/hændelser (`vehicle_incidents`, `vehicle_incident_photos`, private objekter i `incident-photos`) | Workspacets levetid | Ingen automatisk aldersgrænse. Fotos kan slettes af uploaderen eller en workspace-admin; hændelsesrækken kan redigeres, men har endnu ikke selvbetjent sletning. Ved kontosletning anonymiseres medlemsreferencen og fotoets forfatterkobling fjernes, mens den fælles køretøjshistorik og billeder består. Hele klassen slettes ved workspace-purge. |
| Overdragelser (`booking_handovers`) | Workspacets levetid | Ingen automatisk aldersgrænse — **bevidst**: den nyeste række ER bilens aktuelle tilstand (hvor den er parkeret, hvor nøglerne er), og de ældre er køretøjets historik, samme holdning som skader/hændelser ovenfor. Parkerings- og nøgleplacering er personhenførbar lokationsdata og gemmes bevidst som **fritekst uden koordinater** (dataminimering, GVM-529). Ved kontosletning anonymiseres forfatterreferencen via medlemsrækken (`delete_my_account` omskriver den på stedet) — friteksterne nulstilles **ikke**, fordi de er fakta om den fælles bil, som gruppen har brug for; hele klassen slettes ved workspace-purge (cascade fra `ledgers`). |
| Aktivitetsfeed + chat (`ledger_events`, `messages`) | Workspacets levetid | Ingen aldersgrænse — **bevidst produktbeslutning** (feedet ER historikken); aktørfelter anonymiseres ved kontosletning |
| Push-tokens (`expo_push_tokens`) | Kontosletning ELLER 180 dages inaktivitet | **Automatisk** fra migration 130: dagligt sweep via `run_operational_retention` (GV-309) — token gendannes ved næste app-åbning |
| Legacy web-push (`push_subscriptions`) | Udfaset | **Tømt i migration 130** (dødt PWA-levn); tabel droppes i GV-311 |
| Events med udløb (`ledger_events.expires_at`) | Ved udløb | **Automatisk** fra migration 130 (p.t. skriver ingen kode udløbsdatoer — sweep'et er fremtidssikring) |
| Soft-slettet chat, bookinger og tilbagevendende skabeloner (`messages`, `car_bookings`, `recurring_expenses`) | **90 dage efter `deleted_at`** | **Automatisk fra migration 131**. Perioden giver plads til fejlretning/fortryd; derefter hård-slettes tombstonen. |
| Soft-slettede regnskabsrækker (`trips`, `fuel_payments`, `workspace_expenses`, `vehicle_repairs`) | **Fem hele regnskabsår efter året for sletningen** | **Automatisk fra migration 131**. Fx beholdes en række slettet i 2026 til og med 31/12/2031. Dette er den konservative bogføringsfrist; konkret lovpligt afhænger af den dataansvarliges status. **Undtagelse:** hel-workspace-sletning (kontosletning som sidste medlem, eller operatør-nedlæggelse — se afsnittet nedenfor) fjerner også yngre regnskabsrækker. |
| Nedlagte workspaces (`ledgers` + alle barnerækker via cascade) | **90 dage efter operatørens nedlæggelse** (`ledgers.deleted_at`) | **Automatisk fra migration 132** (GV-316): dagligt sweep purger workspaces forbi gendannelsesfristen. Medlemmer mister adgangen straks ved nedlæggelsen og notificeres via feed-event. |
| Operatør-audit (`owner_activity_log`) | **24 måneder** | **Automatisk fra migration 131**; aktørfelter nulles tidligere ved kontosletning. 24 måneder dækker rimelig hændelses-/tvistundersøgelse uden permanent personhistorik. |
| Rate-limit-registre (`ledger_onboarding_rate_limits`, `owner_api_rate_limits`) | Kort teknisk levetid | Renses ved kontosletning; ingen aldersgrænse i øvrigt (lav risiko — nøgler/e-mails) |
| Fejltelemetri (Sentry EU) | **30 dage** | Projektets nuværende gratis Developer-plan (5.000 errors/måned) har 30-dages lookback; projektet bruger EU-ingest. Team/Business giver op til 90 dage. Bekræft plan-/org-indstillingen ved hver årlig vendor-review. |
| Ubekræftede nyhedsbrevs-tilmeldinger (`newsletter_subscribers`, confirmed_at is null) | **7 dage (168 timer)** | **Automatisk fra migration 165**: dagligt retention-sweep + opportunistisk ved hver ny tilmelding (161). Bekræftede abonnenter slettes KUN ved afmelding (hård sletning, ingen tombstone). |
| Rute-cache (Cloudflare KV, `route:<sha256-præfiks>`) | **10 minutter (TTL 600 s)** | **Automatisk** via KV-TTL (GV-419). Værdien er den normaliserede rute — geometri, alternativer, bro/færge-krydsninger, km/minutter — for et adressepar, dvs. lokationsrelateret data behandlet hos Cloudflare (eksisterende databehandler, EU-DPA via Pages). Nøglen er sha256 af afrundede koordinater (4 decimaler, ~11 m) + variant; hverken bruger-id, adressetekst eller e-mail indgår, og cachen er bevidst bruger-anonym: et hit kan ikke føres tilbage til hvem der planlagde. Formål: samme opslag inden for 10 min koster ikke et nyt GraphHopper-kald (dagsbudgettet, GV-419). |
| Backups (Supabase) | **Ingen managed backup på nuværende Free-plan** | Kritisk driftsgab; se backup-restore.md. Før produktion: Pro (daglig/7 dage) eller automatiseret krypteret logical dump. |

## Det automatiske sweep (migration 130, GV-309)

`run_operational_retention(p_stale_push_days := 180, p_dry_run := false)` —
service-role-only, kaldes dagligt via `/api/hooks/retention-cleanup`
(RETENTION_CLEANUP_KEY). Rører **kun** driftsdata: inaktive push-tokens og
eksplicit udløbne events samt de besluttede tombstone-/audit-klasser ovenfor.
**Aktivitetsfeedet slettes aldrig efter alder** — migration 009's farlige
30-dages-default er samtidig gjort ukaldbar for klientroller.

Verifikation af at sweep'et faktisk kører: hook'en returnerer tællinger; operatøren
kan køre dry-run i SQL-editoren:
`select public.run_operational_retention(180, true);`

Cloudflare-evidens 2026-07-17: `govehlo-scheduler` fik
`RETENTION_CLEANUP_KEY` som secret kl. 17:17 UTC og blev deployet kl. 17:21 UTC
(version `22c757e0-4fb7-4db6-b4ef-d2eec48a0af2`) med cron
`30 3 * * *`. Første kørsel af migration 131's udvidede klasser sker først efter,
at migrationen er anvendt i Supabase.

Cron-strengen ovenfor er et **øjebliksbillede fra den dag**, ikke en konfigurationskopi
at vedligeholde her. Siden GV-388 er kadencen erklæret ét sted — `SCHEDULE_CRONS` i
govehlo-web `functions/api/_scheduler-cadence.js` — og både Workerens dispatcher,
operatørkonsollens kadence-tekster og alle overdue-tærskler udledes derfra;
`test/scheduler-cadence.test.mjs` fejler, hvis `workers/scheduler/wrangler.toml` er
kommet ud af trit. Slå den gældende kadence op dér, ikke her.

## Beslutning: workspace-purge tilsidesætter femårsfristen (2026-07-18, GV-316)

En hel-workspace-sletning (operatør-nedlæggelse efter 90 dages gendannelsesfrist,
eller `delete_my_account` når sidste aktive medlem forlader workspacet) cascade-sletter
også regnskabsrækker, der er yngre end femårsfristen ovenfor. Det er en **bevidst,
dokumenteret beslutning** (truffet 2026-07-18), ikke et hul:

- Femårsfristen i migration 131 er vores egen konservative politik for tombstones i
  et LEVENDE workspace — ikke en klar lovpligt for privates delebilsdata; et evt.
  bogføringskrav påhviler brugeren selv, ikke tjenesten.
- GDPR's minimeringsprincip trækker i retning af sletning, og kontosletningsstien
  (`delete_my_account`) har haft præcis denne semantik siden migration 056 —
  operatør-nedlæggelse følger samme præcedens.
- **Tjekliste FØR en nedlæggelse** (operatøren er ansvarlig): (1) tilbyd/bekræft
  dataeksport til medlemmerne (appens eksportflow, GVM-335); (2) kontrollér at der
  ikke er kendt tvist eller legal hold på workspacet; (3) gennemfør derefter
  nedlæggelsen — 90-dages-vinduet er fortrydelsesmarginen.

## Beslutning om forladte workspaces

**Ingen automatisk sletning alene på grund af inaktivitet.** Et workspace kan være
sjældent brugt, men stadig indeholde nødvendigt fælles regnskab. Den normale
kontosletningssti hård-sletter allerede workspacet med cascade, når det sidste
aktive medlem forlader det. Et eventuelt anomalt workspace uden aktive medlemmer
skal sættes i manuel operatør-review: kontrollér medlemsstatus, eksport-/tvistbehov
og legal hold; slet derefter eksplicit. Der indføres ikke en skjult tidsbombe i
det daglige sweep.

Kilder til beslutningen: Datatilsynets princip om at slette/anonymisere, når data
ikke længere er nødvendige, og deres krav om opfølgning på slettekørsler:
https://www.datatilsynet.dk/regler-og-vejledning/grundlaeggende-begreber/hvad-er-dine-forpligtelser/de-grundlaeggende-principper
og https://datatilsynet.dk/regler-og-vejledning/behandlingssikkerhed/sletning.
Erhvervsstyrelsens vejledning angiver fem års opbevaring af regnskabsmateriale:
https://erhvervsstyrelsen.dk/vejledning-bogfoeringsloven.
