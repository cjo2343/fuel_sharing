# Databehandlere og underdatabehandlere

Status pr. 2026-07-17. **[OPERATØR-FAKTA]**-kolonnen (DPA på plads?) kræver opslag i
den enkelte vendors aftalevilkår og markeres ✅/❌ af operatøren.

| Vendor | Rolle | Persondata | Region | DPA/overførselsgrundlag |
|---|---|---|---|---|
| **Supabase** | Database, Auth, lager — hele appens datalag | Alle dataklasser (se retention.md) | EU-projekt | [OPERATØR-FAKTA: DPA + underdatabehandlerliste] |
| **Cloudflare** | Pages/Functions (landing, admin, API), Access-gate, e-mail-alias (services@govehlo.dk) | Trafik gennem API'et (requests med e-mails, nummerplader i POST-bodies); videresendt e-mail | Globalt edge-netværk (US-selskab) | [OPERATØR-FAKTA: DPA; DPF-certificering] |
| **Sentry** | Fejltelemetri (web + mobil) | Fejlhændelser — konvention: ingen PII i beskeder; IP-håndtering pr. konfiguration | **EU-region valgt** | [OPERATØR-FAKTA: DPA; event-TTL] |
| **Better Stack** | Oppetidsovervågning | Ingen — rammer kun /api/health-proxyen | EU/US | Ingen persondata behandles |
| **Expo (EAS)** | Push-relay (Expo push-service) | Push-tokens + notifikationsindhold (navne/beløb) | USA | [OPERATØR-FAKTA: DPA/DPF] |
| **Apple APNs** | Push-levering iOS | Device-token + indhold | USA | Apples standardvilkår [OPERATØR-FAKTA] |
| **Google FCM** | Push-levering Android | Device-token + indhold | USA | [OPERATØR-FAKTA: DPF] |
| **Mindee** | Kvitterings-OCR (planlagt, GVM-237-sporet) | Kvitteringsbilleder (kan indeholde betalingsdetaljer) | EU-behandling muligt | [OPERATØR-FAKTA: DPA — møde ~22/7-2026] |
| **GraphHopper GmbH** | Ruteberegning (Planlæg-fanen) | Kun koordinater — ingen konto-id'er | Tyskland | Koordinater uden identifikatorer; lav risiko |
| **Photon (Komoot)** | Geokodning af adresser | Søgestrenge (adresser) — nøglefri, ingen konto | EU | Nøglefri offentlig tjeneste; lav risiko |
| **Nummerplade Tjek / autotelli.dk** | Bilopslag ved oprettelse | Nummerplade (POST via Cloudflare-proxy) | Danmark | [OPERATØR-FAKTA: vilkår] |

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
