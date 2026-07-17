# Databehandlere og underdatabehandlere

Status pr. 2026-07-17. "Dokumentation" skelner bevidst mellem et offentliggjort
vilkår og bevis for, at operatørkontoen faktisk har accepteret/underskrevet det.
Et offentligt DPA-link er ikke i sig selv kontraktevidens.

| Vendor | Rolle | Persondata | Region | DPA/overførselsgrundlag |
|---|---|---|---|---|
| **Supabase** | Database, Auth, lager — hele appens datalag | Alle dataklasser (se retention.md) | EU-projekt | **DPA offentliggjort (v. 1/6-2026)** med SCC-mekanismer: https://supabase.com/downloads/docs/Supabase%2BDPA%2B260601.pdf. Gem accept-/konto-evidens i kontraktarkivet; ikke i git. Underdatabehandlerlisten er en del af vendor-reviewet. |
| **Cloudflare** | Pages/Functions (landing, admin, API), Access-gate, e-mail-alias (services@govehlo.dk) | Trafik gennem API'et (requests med e-mails, nummerplader i POST-bodies); videresendt e-mail | Globalt edge-netværk (US-selskab) | **Customer DPA v6.4, 3/4-2026**, indgår i self-serve/enterprise-aftalen og indeholder overførselsvilkår: https://www.cloudflare.com/cloudflare-customer-dpa/. Gem konto-/accept-evidens. |
| **Sentry** | Fejltelemetri (web + mobil) | Fejlhændelser — SDK'et scrubber kendte PII-felter; send stadig aldrig hemmeligheder | **EU-region valgt** (`ingest.de.sentry.io`) | Sentry stiller DPA til rådighed under Organization → Legal & Compliance (`https://sentry.io/legal/dpa/`). **Event-lookback: 30 dage** på den nuværende gratis Developer-plan; Sentrys aktuelle plantabel: https://sentry.io/pricing/. Kontoens DPA-accept skal eksporteres/skærmbilledes ved næste login-review. |
| **Better Stack** | Oppetidsovervågning | Monitorerer offentligt `/api/health`; ingen brugerpayloads sendes | EU/US | DPA ikke nødvendig for den nuværende dataløse monitorrolle. Revurdér straks hvis request-logs, headers eller brugerdata aktiveres. |
| **Expo (EAS)** | Push-relay (Expo push-service) | Push-tokens + notifikationsindhold (navne/beløb) | USA | Expo beskriver sig som databehandler og DPF-compliant: https://expo.dev/privacy-explained. Indhold lagres ikke efter levering; push receipts slettes efter 24 timer: https://docs.expo.dev/push-notifications/faq/. **GAP: ingen underskrevet/offentligt linket DPA-evidens er fundet; indhent den fra Expo før offentlig produktion eller brug `PUSH_CONTENT_MODE=generic`.** |
| **Apple APNs** | Push-levering iOS | Device-token + indhold | USA | APNs er Expo-underdatabehandler. Brugen reguleres af den accepterede Apple Developer Program License Agreement, inkl. Attachment 1: https://developer.apple.com/support/terms. Gem den accepterede kontoversion; Expo skal flow-down'e databeskyttelsesvilkår. |
| **Google FCM** | Push-levering Android | Device-token + indhold | USA | FCM er udtrykkeligt omfattet af Firebase Data Processing and Security Terms + Google APIs Terms: https://firebase.google.com/terms/ og https://firebase.google.com/terms/data-processing-terms/. SCC'er er indarbejdet. Google er desuden Expo-underdatabehandler. |
| **Mindee** | Kvitterings-OCR (planlagt, GVM-237-sporet) | Kvitteringsbilleder (kan indeholde betalingsdetaljer) | EU-behandling muligt | **Ikke godkendt til produktion endnu.** DPA, valgt region, modeltræning/fravalg og billed-TTL skal være skriftligt dokumenteret før feature-flag aktiveres. |
| **GraphHopper GmbH** | Ruteberegning (Planlæg-fanen) | Koordinater og klientens netværksmetadata; ingen VehloShare-konto-id'er | Tyskland | EU-leverandør, men koordinater/IP kan stadig være persondata. **GAP: kontrakt/DPA-evidens mangler**; indhent ved produktionsaftale eller proxy/minimér og dokumentér legitim interesse. |
| **Photon (Komoot)** | Geokodning af adresser | Søgestrenge og klientens netværksmetadata; ingen VehloShare-konto | EU | Offentlig nøglefri tjeneste er ikke et DPA. **GAP:** proxy/caching og leverandørvilkår skal afklares før bred produktion; undgå at sende konto-id'er. |
| **Nummerplade Tjek / autotelli.dk** | Bilopslag ved oprettelse | Nummerplade (POST via Cloudflare-proxy) | Danmark | **GAP:** vilkår/DPA mangler i evidenspakken. Indhent skriftlig rolle-, formåls-, log- og TTL-afklaring; nummerplader må fortsat aldrig stå i URL/log. |

## Bevidste fravalg (projektpolitik)

- Ingen Mapbox/Google Maps til geodata (US-processorer for adfærdsdata) — lokal
  beregning og EU-tjenester foretrækkes.
- Ingen betalingsformidler (Stripe m.fl.): afregninger er P2P via MobilePay-links;
  appen rører aldrig betalingsmiddeldata.
- DAWA/DAR-flytningen (DAWA lukker 1/10-2026) holder adresseopslag på danske
  offentlige tjenester.

## Proces

Ny vendor ⇒ vurdér: (1) kan det beregnes lokalt? (2) findes EU/nøglefrit alternativ?
(3) ellers kræv EU-DPA. Tilføj rækken her + aktiviteten i ropa.md i samme PR.

## Kontraktevidens, der skal ligge uden for git

Ved hver årlig vendor-review gemmes PDF/skærmbillede med kontonavn, accepteret
vilkårsversion og dato i operatørens adgangsbegrænsede kontraktarkiv. Ovenstående
links dokumenterer de gældende standardvilkår, men repoet må ikke indeholde
underskrifter, kontoudtog eller andre fortrolige aftaledokumenter.
