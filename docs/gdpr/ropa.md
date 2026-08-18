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
  skader/hændelser samt beregne/afregne omkostningsfordeling mellem medlemmer.
- **Registrerede:** Workspace-medlemmer.
- **Datakategorier:** Ture (km, datoer, deltagere), brændstofkøb (beløb, liter),
  hertil **valgfrie kvitteringsfotos på den enkelte tankning** (GVM-537, migration
  169) — formålet er gruppens fælles dokumentation af en delt udgift: fotoet svarer
  på "hvad stod der på kvitteringen?", mens pengene stadig er i bevægelse. Kategorien
  er **opt-in pr. tankning** (der uploades aldrig noget af sig selv, og der findes
  ingen workspace-indstilling, der slår det til for alle), **ét foto pr. tankning**
  som en ny vedhæftning erstatter frem for at lægge oveni, og det **slettes
  automatisk**, når tankningens afregningsperiode er lukket og betalt — se
  retention.md. Fotoet kan indeholde tidspunkt, sted og fx de sidste fire cifre af et
  betalingskort; det ligger i en privat Supabase-bucket i EU, hentes kun af
  workspacets medlemmer, og hverken sti eller signeret URL optræder i URL'er,
  query-strenge eller logs,
  udgifter og reparationer (beløb, værksted, kvitteringsdata), bookinger,
  skader/hændelser (titel, beskrivelse, dato, kilometerstand, status, skadetype
  — eksisterende skade eller ny hændelse — valgfrit skadenummer, fører og relation
  til booking/tur samt til den reparation, der udbedrede skaden) samt valgfri
  hændelsesfotos,
  **køretøjets dokumentarkiv** (GVM-523, migration 201) — workspacets papirmappe for
  den fælles bil: en titel, en valgfri udløbsdato og op til fem **fotograferede
  sider** pr. dokument (kun fotos, ingen PDF i v1). Kategorien er den mest
  personfølsomme i A2 og skal læses som sådan: en **registreringsattest** bærer
  ejerens navn og adresse, og en **forsikringspolice** bærer et policenummer — det er
  oplysninger om ét medlem, fotograferet af et andet. Dataminimeringen ligger i
  formen, ikke i et løfte: intet uploades af sig selv (en række findes kun, fordi et
  medlem fotograferede en side), bucketen er privat og afgrænset til workspacet af
  stiens første led, fem sider pr. dokument er et hårdt loft håndhævet i databasen,
  og hverken sti eller signeret URL optræder i URL'er, query-strenge eller logs.
  Udløbsdatoen læses **kun af klienten** (Hjem-skærmens helbredskø) — der sendes
  ingen påmindelse og kører intet job på den,
  overdragelser ved bookingens afslutning (kilometerstand, brændstofniveau,
  **parkerings- og nøgleplacering som fritekst**, stand og bemærkning, besked til
  næste fører, nøglekvittering — lokationsangivelserne er personhenførbare og gemmes
  bevidst som fritekst uden koordinater), bilens **aktuelle parkerings- og
  nøgleplacering** på selve workspacet (samme slags personhenførbare fritekst uden
  koordinater, med angivelse af hvilket medlem der sidst opdaterede den og hvornår),
  hertil **ét valgfrit koordinatpar til bilens parkering** — "parkeringsnålen"
  (GVM-536, migration 168; siden GVM-540/migration 170 kan nålen også sættes fra
  overdragelsen). Det er den **bevidste og eneste undtagelse** fra
  fritekst-uden-koordinater-holdningen ovenfor, truffet af den dataansvarlige
  2026-08-04, og den er en undtagelse — ikke en opblødning: platformen fjernede
  koordinater i migration 062/071 (GPS på tankninger) og 151 (tankstationer), og
  fritekstvalget i 164/167 står ved magt for alle andre felter. Nålen er
  **brugerudløst** (medlemmet trykker selv "brug min placering" — der indsamles
  aldrig position i baggrunden), **ét enkelt punkt om en parkeret bil**, der
  **overskrives på stedet** uden historik, og den **ryddes**, når parkeringsteksten
  ændres uden en ny nål (en ældre klients gem, eller en overdragelse der spejler ny
  parkeringstekst uden selv at bære en nål), så en forældet nål aldrig kan overleve
  den tekst, den hørte til. Bærer overdragelsen selv en frisk nål, **erstattes** den
  gamle — det er stadig ét punkt, overskrevet på stedet, og overdragelsens egen række
  gemmer aldrig koordinater (de ville blive én position pr. booking, altså en
  bevægelseshistorik).
  Koordinaterne optræder aldrig i aktivitetsfeedet (hændelsens metadata bærer kun
  boolean-feltet `parking_pin_set`), aldrig i URL'er, query-strenge eller logs. Vises
  nålen på et minikort, hentes korttiles hos MapTiler (CH/EU) — se
  subprocessors.md,
  **"Jeg er på vej" — delt forventet ankomst** (GVM-238 P0, migration 202): et
  **afledt minuttal** knyttet til en aktiv booking, sammen med tidspunktet delingen
  begyndte og tidspunktet tallet sidst blev opdateret (`car_bookings.on_my_way`,
  præcis de tre nøgler `eta_minutes` / `started_at` / `updated_at`). **Der behandles
  ingen position på serveren — hverken gemt, modtaget eller videresendt.** Telefonen
  beregner ankomsttiden lokalt ud fra sin egen placering og sender **kun det færdige
  minuttal**; der findes ingen breddegrad, længdegrad, adresse eller rute nogen
  steder i denne kategori. Det er håndhævet, ikke lovet: RPC'en `set_on_my_way` tager
  et **heltal** og bygger selv JSON-objektet på serveren (der findes ingen parameter,
  et koordinat kan smugles ind gennem), og en **CHECK-constraint** på tabellen lukker
  nøglesættet, så heller ikke et direkte PostgREST-kald kan tilføje et felt.
  Kategorien er **flygtig**: tilstanden nulstilles, når medlemmet er fremme, når
  bookingen slutter, eller når delingen stoppes manuelt, og den forsvinder helt med
  bookingen. Feed- og synk-hændelserne (`on_my_way_started`, `on_my_way_updated`,
  `on_my_way_stopped`) bærer kun et booking-id og et minuttal.
  **Forholdet til løftet om "ingen løbende sporing" på privatlivssiden:** funktionen
  modsiger det ikke. Løftet handler om behandling af **position**, og der er ingen
  position at behandle — vi modtager en **varighed**, ikke et sted, og en varighed
  kan ikke sammenstilles til en bevægelseshistorik. Delingen er desuden
  **brugerudløst** (medlemmet trykker selv), **afgrænset til én aktiv booking** og
  **synlig for den, der deler** (modtagerne får tilmed at vide, hvor gammelt tallet
  er — "opdateret for 8 min siden" — så ingen tror, der ligger en live-sporing bag).
  Det er den samme linje som parkeringsnålen ovenfor: brugerudløst, ét formål, ingen
  historik — blot uden overhovedet at røre et koordinat,
  afregningsperioder/-anmodninger, bilens stamdata **inkl. nummerplade**
  (nummerplader er personoplysninger — sendes aldrig i URL'er, kun POST-bodies).
- **Retsgrundlag:** Kontrakt (art. 6(1)(b)).
- **Modtagere:** Supabase (EU), inklusive privat objektlager til hændelsesfotos,
  kvitteringsfotos og dokumentsider (tre adskilte private buckets, alle kun læsbare
  for workspacets medlemmer).
  Ved kvitterings-OCR: Mindee (Frankrig, EU) som reserve-vej, når on-device-læsning
  mangler eller er usikker — LIVE, gated alene af Pages-nøglerne (GV-482, se
  subprocessors.md). Ved opslag af tankstationer i nærheden og den stationsliste,
  tankstations-påmindelsen geofencer omkring: OpenStreetMap/Overpass (FOSSGIS e.V.,
  DE) — enhedens koordinater i fuld præcision, server-til-server, uden konto-id'er
  (GV-482). Ved ruteplanlægning: GraphHopper (DE) og Photon (koordinater,
  ingen konto-id'er) — samt Cloudflare KV som korttids-cache (GV-428): den
  normaliserede rute (geometri, alternativer, krydsninger) gemmes i 10 minutter
  under en hashet koordinat-nøgle uden bruger-id eller adressetekst, så gentagne
  opslag ikke koster et nyt GraphHopper-kald. Se retention.md-rækken "Rute-cache".
  Ved kortvisning (ruteoversigten siden GVM-407 og parkeringsnålens minikort siden
  GVM-536): **MapTiler** (CH/EU) — klienten henter selv style og korttiles, så
  MapTiler ser de omtrentlige koordinater i det viste udsnit plus API-nøglen, aldrig
  konto-id'er. Se subprocessors.md.
- **Sletning:** Regnskabs- og hændelsesdata består som fælles, pseudonymiseret
  køretøjshistorik efter kontosletning (øvrige medlemmers regnskab og dokumentation,
  art. 17(3)); fotoets forfatterkobling fjernes. Dokumentarkivet kan derimod ryddes
  af gruppen selv når som helst: den, der gemte et dokument, og enhver
  workspace-admin kan slette det — rækken hård-slettes, siderne forsvinder med den,
  og klienten fjerner objekterne (det daglige forældreløse-sweep er sikkerhedsnettet).
  Se deletion-limitations.md.

## A3 — Aktivitetsfeed og beskeder

- **Formål:** Fælles aktivitets-/chatfeed pr. workspace (hvem gjorde hvad, hvornår)
  og live-synk mellem klienter.
- **Datakategorier:** Hændelsestekster (navne + beløb), chatbeskeder, aktør-id/e-mail,
  samt **tilstedeværelse** (hvilke medlems-id'er der har appen åben lige nu) over
  Supabase Realtime. Tilstedeværelsen er et online/offline-signal om navngivne
  personer og hører derfor til workspacet: kanalerne `presence-<workspace-id>` og
  `ledger-changes-<workspace-id>` er **private** (GVM-575, lukket 2026-08-12).
  Migrationerne 202/205/206 lægger RLS-politikker på `realtime.messages`, så kun
  workspacets egne medlemmer må lytte og melde sig til netop de kanaler, og klienten
  åbner dem med `private: true`. Politikker binder kun private kanaler, så hullet var
  først lukket, da **"Allow public access to channels"** blev slået fra i projektets
  Realtime-indstillinger — en indstilling i Supabase-dashboardet, som ingen migration
  skriver og ingen forespørgsel kan læse. Den kontrolleres derfor med
  `npm run probe:realtime-public-access` (et offentligt join skal afvises med
  "PrivateOnly") og attesteres før udgivelse som `realtime_public_access_closed` i
  `docs/release-attestations.json` (GV-490); se DEPLOY-CHECKLIST.md afsnit 6a.
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
  udsendelseslog for nyhedsbrevet (`newsletter_send_log`: operatør-e-mail, overskrift,
  antal modtagere, tidspunkt — ingen modtageradresser, GV-445),
  rate-limit-registre (e-mail-nøgler), oppetidsmålinger (Better Stack — rammer kun
  /api/health, ingen persondata).
- **Retsgrundlag:** Legitim interesse (art. 6(1)(f)) — drift og sikkerhed.
- **Sletning:** Se retention.md (`owner_activity_log`: 24 måneder, automatisk;
  `newsletter_send_log`: 24 måneder, automatisk fra migration 176).

## A6 — Opslag ved oprettelse af bil

- **Formål:** Slå bilens stamdata op ud fra nummerplade (bekvemmelighed ved oprettelse)
  samt lejlighedsvis opdatering af synsdato, ejerafgift og forsikringsselskab.
- **Datakategorier:** Nummerplade (sendes via Cloudflare-proxy i POST-body).
- **Modtagere:** Synsbasen ApS (dansk kilde; erstattede Nummerplade Tjek / autotelli.dk
  i GVM-199 — den gamle nøgle er tilbagekaldt, GV-166).
- **Retsgrundlag:** Kontrakt (brugeren initierer opslaget).
- **Sletning:** Opslaget persisteres kun som bilens stamdata i workspacet.

## A7 — Nyhedsbrev (markedsføring)

- **Formål:** Udsende nyhedsbrev til personer der selv har bedt om det (dobbelt opt-in, GV-366).
- **Registrerede:** Nyhedsbrevsabonnenter — en SELVSTÆNDIG kreds; listen kan pr. konstruktion
  ikke seedes fra appens brugere (håndhævet af konsent-vagten i CI).
- **Datakategorier:** E-mailadresse, requested_at, confirmed_at, samtykketekst-version,
  token-digests (sha256). Bevidst IKKE: IP, user agent, navn, kobling til workspace.
- **Retsgrundlag:** Samtykke (art. 6(1)(a)) + markedsføringslovens § 10; beviset er
  requested_at + confirmed_at + consent_text_version.
- **Modtagere:** Supabase (EU, lager) og Sweego (Frankrig, EU — udsendelse); se subprocessors.md.
- **Sletning:** Afmelding hård-sletter rækken med det samme; ubekræftede tilmeldinger slettes
  automatisk efter 7 dage (dagligt sweep fra migration 165 + ved hver ny tilmelding). Se retention.md.

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
