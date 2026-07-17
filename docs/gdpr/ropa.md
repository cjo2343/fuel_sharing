# Fortegnelse over behandlingsaktiviteter (RoPA, art. 30)

**Dataansvarlig:** [OPERATØR-FAKTA: virksomhedsnavn + CVR — jf. GV-177 bruges
virksomhedsidentitet, ikke personnavn/-adresse] · Kontakt: services@govehlo.dk ·
Ingen DPO udpeget (ikke påkrævet: lille aktør, ingen kernebehandling af følsomme
oplysninger i stort omfang).

Alle behandlinger sker med Supabase-projektet i **EU** som primært lager. Klienterne
er den native app (iOS/Android) og admin-konsollen (kun operatøren, dobbelt-gatet via
Cloudflare Access + Supabase-login).

## A1 — Konto og medlemskab

- **Formål:** Oprette og administrere brugerkonti og workspace-medlemskaber
  (magic-link-login, invitationer, roller).
- **Registrerede:** App-brugere (workspace-medlemmer).
- **Datakategorier:** E-mail, visningsnavn, rolle, MobilePay-nummer (frivilligt,
  til afregningslinks), invitationskoder, auth-metadata (Supabase Auth).
- **Retsgrundlag:** Kontrakt (art. 6(1)(b)) — tjenesten kan ikke leveres uden.
- **Modtagere:** Supabase (EU). Magic-link-e-mails via Supabase Auths mailudsendelse
  [OPERATØR-FAKTA: indbygget SMTP eller egen udbyder?].
- **Sletning:** Ved kontosletning (se deletion-limitations.md); se retention.md.

## A2 — Delebilsregnskab

- **Formål:** Registrere ture, tankninger, udgifter, reparationer, bookinger og
  beregne/afregne omkostningsfordeling mellem medlemmer.
- **Registrerede:** Workspace-medlemmer.
- **Datakategorier:** Ture (km, datoer, deltagere), brændstofkøb (beløb, liter),
  udgifter og reparationer (beløb, værksted, kvitteringsdata), bookinger,
  afregningsperioder/-anmodninger, bilens stamdata **inkl. nummerplade**
  (nummerplader er personoplysninger — sendes aldrig i URL'er, kun POST-bodies).
- **Retsgrundlag:** Kontrakt (art. 6(1)(b)).
- **Modtagere:** Supabase (EU). Ved kvitterings-OCR: Mindee (planlagt — se
  subprocessors.md). Ved ruteplanlægning: GraphHopper (DE) og Photon (koordinater,
  ingen konto-id'er).
- **Sletning:** Regnskabsdata består som pseudonymiseret historik efter kontosletning
  (øvrige medlemmers regnskab, art. 17(3)); se deletion-limitations.md.

## A3 — Aktivitetsfeed og beskeder

- **Formål:** Fælles aktivitets-/chatfeed pr. workspace (hvem gjorde hvad, hvornår)
  og live-synk mellem klienter.
- **Datakategorier:** Hændelsestekster (navne + beløb), chatbeskeder, aktør-id/e-mail.
- **Retsgrundlag:** Kontrakt; feedet er en kernefunktion (transparens om penge).
- **Sletning:** Feedet er workspace-historik uden aldersgrænse (produktbeslutning);
  aktørfelter anonymiseres ved kontosletning.

## A4 — Push-notifikationer

- **Formål:** Påmindelser (booking-afslutning, afregning, lukning) og driftsbeskeder.
- **Datakategorier:** Expo-push-token, platform, bruger-id/e-mail (tabellen
  `expo_push_tokens`). Indhold: fulde tekster med navne/beløb som standard
  (PUSH_CONTENT_MODE=generic er nødventil).
- **Retsgrundlag:** Kontrakt/legitim interesse; enheds-opt-in via OS.
- **Modtagere:** Expo push-service → Apple APNs / Google FCM (**tredjelandsoverførsel
  til USA**). Expo oplyser DPF-compliance; Firebase-vilkårene indarbejder SCC'er,
  og Apple/Google står på Expos underdatabehandlerliste. Expos egen DPA-evidens er
  fortsat et release-gap; se subprocessors.md.
- **Sletning:** Ved kontosletning; inaktive tokens ryddes automatisk efter 180 dage
  (migration 130).

## A5 — Drift, sikkerhed og support

- **Formål:** Fejlsøgning, misbrugsbeskyttelse, operatørtilsyn.
- **Datakategorier:** Fejltelemetri (Sentry, EU-region — uden PII i beskeder),
  operatør-audit-log (`owner_activity_log`: handling, aktør-e-mail, tidspunkt),
  rate-limit-registre (e-mail-nøgler), oppetidsmålinger (Better Stack — rammer kun
  /api/health, ingen persondata).
- **Retsgrundlag:** Legitim interesse (art. 6(1)(f)) — drift og sikkerhed.
- **Sletning:** Se retention.md (`owner_activity_log`: 24 måneder, automatisk).

## A6 — Opslag ved oprettelse af bil

- **Formål:** Slå bilens stamdata op ud fra nummerplade (bekvemmelighed ved oprettelse).
- **Datakategorier:** Nummerplade (sendes via Cloudflare-proxy i POST-body).
- **Modtagere:** Nummerplade Tjek / autotelli.dk (dansk kilde).
- **Retsgrundlag:** Kontrakt (brugeren initierer opslaget).
- **Sletning:** Opslaget persisteres kun som bilens stamdata i workspacet.

## Tekniske og organisatoriske foranstaltninger (TOMs)

- Row-Level Security på alle domænetabeller; adfærden CI-testes af en rollematrix
  (110+ cases) på hver PR.
- Privilegerede RPC'er er service-role-only; klienter har aldrig service-nøglen.
- Admin-konsol dobbelt-gatet (Cloudflare Access + Supabase-login, host-låst).
- Ingen PII i logs eller URL-parametre (håndhævet konvention; nummerplader kun i
  POST-bodies). Kryptering i transit (TLS) og hvile (Supabase).
- Skemaændringer kun via reviewede migrationer med CI-ækvivalenskontrol.
- Databehandling holdes i EU; US-processorer undgås aktivt for persondata
  (lokal beregning > EU/nøglefri > EU-DPA — projektpolitik).
