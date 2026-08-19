# Opbevaringsfrister pr. dataklasse

Status pr. 2026-07-21 — **ærlig** opgørelse: kolonnen "Håndhævelse" siger, om fristen
faktisk håndhæves automatisk, kræver manuel handling, eller er et kendt hul.

| Dataklasse (tabeller) | Frist | Håndhævelse |
|---|---|---|
| Konto/identitet (Supabase Auth, `ledger_members`) | Til kontosletning | **Automatisk ved sletning**: `delete_my_account` anonymiserer (se deletion-limitations.md) |
| Regnskabsdata (`trips`, `fuel_payments`, `workspace_expenses`, `vehicle_repairs`, `settlement_*`) | Workspacets levetid; består pseudonymiseret efter medlems kontosletning | Ingen aldersgrænse for aktive rækker — bevidst (fælles regnskab; bogføringshensyn) |
| Skader/hændelser (`vehicle_incidents`, `vehicle_incident_photos`, private objekter i `incident-photos`) | Workspacets levetid | Ingen automatisk aldersgrænse. Fotos kan slettes af uploaderen eller en workspace-admin; hændelsesrækken kan redigeres, men har endnu ikke selvbetjent sletning. Ved kontosletning anonymiseres medlemsreferencen og fotoets forfatterkobling fjernes, mens den fælles køretøjshistorik og billeder består. Hele klassen slettes ved workspace-purge. |
| **Kvitteringsfotos på tankninger** (`fuel_payment_receipts`, private objekter i `fuel-receipts`) | **Til afregningen er lukket OG betalt** — ingen aldersgrænse, en begivenhed | **Automatisk fra migration 169** (GVM-537, ejerbeslutning 2026-08-04). **Opt-in pr. tankning**: rækken findes kun, fordi et medlem selv valgte at vedhæfte et foto til netop den tankning; et workspace, der aldrig trykker "vedhæft kvittering", gemmer intet. **Ét foto pr. tankning** — en ny vedhæftning ERSTATTER den gamle (unik `fuel_payment_id`), så billeder aldrig hober sig op. Slettes af det daglige retention-sweep, når tankningens afregningsperiode har status `closed` OG ingen betalingsanmodning i perioden står i andet end `paid`/`cancelled`. **En uafklaret `paid_pending`-påstand tæller IKKE som betalt**: modtageren kan stadig afvise den (migration 090), og kvitteringen er præcis det, en sådan uenighed afgøres med. Sweep'et sletter også `storage.objects`-rækken, så filen ikke kan hentes bagefter. Dette er platformens **første begivenhedsbaserede frist** (alle andre automatiske klasser er aldersbaserede) og den eneste klasse, der sletter sig selv, mens workspacet lever — bevidst: dokumentationsbehovet dør med afregningen. Uploaderen eller en workspace-admin kan fjerne fotoet før da. Ved kontosletning anonymiseres `uploader_member_id` via medlemsrækken (`delete_my_account` omskriver den på stedet), præcis som `fuel_payments.payer_member_id`. |
| **Køretøjets dokumentarkiv** (`vehicle_documents`, `vehicle_document_photos`, private objekter i `vehicle-documents`) | Workspacets levetid | Ingen automatisk aldersgrænse — **bevidst** (GVM-523, migration 201, ejerbeslutning 2026-08-10), samme holdning som skader/hændelser ovenfor: en forsikringspolice eller en registreringsattest ER bilens papirer, og en aldersgrænse ville slette dem, mens de stadig gælder. **Udløbsdatoen er ikke en frist**: den læses kun af klienten (Hjem-skærmens helbredskø) og udløser hverken sletning, påmindelse eller job — et udløbet dokument er stadig historik. **Hård sletning, ingen tombstone**: den, der gemte dokumentet, og enhver workspace-admin kan slette det eller en enkelt side; rækkerne forsvinder straks, siderne cascader med dokumentet, og RPC'en giver klienten de stier, den skal fjerne i objektlageret. **Loft: 50 dokumenter pr. workspace og 5 sider pr. dokument** (5 MiB pr. fil), håndhævet i databasen — arkivet kan altså ikke vokse ubegrænset. Ved kontosletning anonymiseres `created_by_member_id` via medlemsrækken (`delete_my_account` omskriver den på stedet), præcis som ved kvitteringsfotos; selve dokumenterne består som gruppens fælles papirer. Hele klassen slettes ved workspace-purge, og efterladte objekter fjernes af det daglige forældreløse-sweep (se deletion-limitations.md, punkt 6). |
| Overdragelser (`booking_handovers`) | Workspacets levetid | Ingen automatisk aldersgrænse — **bevidst**: den nyeste række ER bilens aktuelle tilstand (hvor den er parkeret, hvor nøglerne er), og de ældre er køretøjets historik, samme holdning som skader/hændelser ovenfor. Parkerings- og nøgleplacering er personhenførbar lokationsdata og gemmes bevidst som **fritekst uden koordinater** (dataminimering, GVM-529). Ved kontosletning anonymiseres forfatterreferencen via medlemsrækken (`delete_my_account` omskriver den på stedet) — friteksterne nulstilles **ikke**, fordi de er fakta om den fælles bil, som gruppen har brug for; hele klassen slettes ved workspace-purge (cascade fra `ledgers`). |
| Bilens aktuelle placering på workspacet (`ledgers.parking_location`, `key_location`) | Workspacets levetid | Ingen aldersgrænse — **bevidst** (migration 167): værdien ER bilens aktuelle tilstand, og en tømt værdi ville blot betyde "ingen ved det". Overskrives på stedet ved hvert gem; ingen historik. Fritekst uden koordinater. Ved kontosletning anonymiseres `location_updated_by_member_id` via medlemsrækken; friteksterne nulstilles ikke (fakta om den fælles bil). Slettes med `ledgers`-rækken ved workspace-purge. |
| **Parkeringsnål** (`ledgers.parking_lat`, `parking_lng`) | Workspacets levetid — og i praksis kortere | **Ét valgfrit koordinatpar** (GVM-536, migration 168; den bevidste undtagelse fra no-koordinater-holdningen, jf. ropa.md A2). **Brugerudløst**: skrives kun når et medlem selv gemmer en placering — ingen baggrundsindsamling. **Overskrives på stedet, ingen historik**: ingen audit-tabel, ingen tidligere-værdi-kolonne, ingen hændelse der bærer den gamle værdi, så ét punkt kan aldrig blive til et bevægelsesmønster. Koordinaterne skrives aldrig i `ledger_events` (metadata bærer kun boolean-feltet `parking_pin_set`), i URL'er eller i logs. **Ryddes automatisk, når parkeringsteksten ændres uden en ny nål** — både når en ældre klient gemmer uden nålefelterne (`set_vehicle_location` er full-set) og når en overdragelse spejler ny parkeringstekst — så nålen aldrig overlever den tekst, den hørte til; det er reelt fristen. Dør med `ledgers`-rækken ved workspace-purge. |
| **"Jeg er på vej": ankomsttid, delingsnøgle og live-position** (`car_bookings.on_my_way`; positionen har **ingen** tabel) | **Delingens levetid** — og for positionen: **ingen opbevaring overhovedet** | **To halvdele, to svar** (GVM-238 P0 migration 202, live-kortet GVM-587, `pubkey` migration 209; jf. ropa.md A2). **Den varige halvdel** er `car_bookings.on_my_way` — minuttal, `started_at`, `updated_at` og fra 209 en valgfri `pubkey`. Den **nulstilles**, når medlemmet er fremme, når bookingen slutter, eller når delingen stoppes; delingsnøglen er tilfældig og født pr. deling, så den **dør med delingen** og kan ikke føres videre til hverken person eller enhed. Resten forsvinder med bookingrækken (soft-delete-rækken ovenfor: 90 dage efter `deleted_at`). **Ingen koordinat har nogensinde stået her** — CHECK-constrainten holder nøglesættet lukket. **Den flygtige halvdel** — positionen på live-kortet — har **ingen frist, fordi der ikke er noget at slette**: den sendes som en broadcast-besked på den private Realtime-kanal, Supabase relayer den til de medlemmer, der er tilsluttet netop da, og gemmer den ingen steder (ingen `realtime.messages`-række — en server-relay blev fravalgt af præcis den grund, ingen log, ingen historik, ingen genafspilning). Modtagernes klienter fjerner prikken **3 minutter** efter sidste opdatering og straks ved stop. Ved kontosletning er der derfor intet at scrubbe i denne klasse. |
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
| **Afmeldings-tokens til nyhedsbrevet** (`newsletter_send_tokens`) | **Abonnentens levetid** | **Automatisk fra migration 175** (GV-441). Én række pr. udsendt afmeldingslink, gemt som pseudonymt sha256-digest; det rå token findes kun i mailen og i den URL, modtageren klikker på, aldrig her. Rækkerne er personhenførbare via `subscriber_id`, og fristen er derfor abonnentens egen: `ON DELETE CASCADE` fjerner **alle** tokens i samme sætning som afmeldingen (der hård-sletter abonnenten, jf. 161), så et token aldrig kan overleve den adresse, det hørte til — det er det, der forhindrer tabellen i at blive den tombstone, 161 afviste. **Migration 185** (GV-456) fjerner den tidligere 24-måneders opportunistiske rydning: den genskabte netop den fejl, GV-441 lukkede — et >24 måneder gammelt afmeldingslink matchede intet, og afmeldings-endpointets bevidste anti-enumererings-tavshed fortalte så en aktiv abonnent, at adressen var slettet, selv om den ikke var det (en opt-out der melder succes uden at gøre noget; markedsføringslovens § 10 vendt om og art. 17 besvaret med en løgn). Da `ON DELETE CASCADE` allerede binder tokenets levetid til abonnentens, er "abonnentens levetid" i sig selv opbevaringsbegrænset til formålet (art. 5(1)(e)), og et hvilket som helst link, vi nogensinde har sendt, virker, så længe adressen står på listen. Tabellen kender hverken adresse, navn eller udsendelseshistorik — kun "er dette digest et af vores". Erstatter den roterende `newsletter_subscribers.unsubscribe_token_hash`-kolonne, hvor kun det NYESTE brev bar et virksomt link. |
| **Udsendelseslog for nyhedsbrevet** (`newsletter_send_log`) | **24 måneder** | **Automatisk fra migration 176** (GV-445). Én række pr. udsendelse: operatørens e-mail (vores personale, ikke en abonnent), overskrift, antal modtagere og tidspunkt. Ingen modtageradresse, intet navn og ingen kobling til abonnentlisten — tabellen svarer på "hvem sendte hvad, hvornår, til hvor mange" og ikke "hvem modtog det". Operatør-e-mailen er persondata med et endeligt revisionsformål; 24-måneders-fristen er den samme som `owner_activity_log`, fordi de to tabeller besvarer samme spørgsmål i samme vindue. Ryddes af det daglige retention-sweep (`run_operational_retention`). |
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
