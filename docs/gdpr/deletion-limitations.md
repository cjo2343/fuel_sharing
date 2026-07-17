# Sletning: hvad der faktisk sker, og hvor grænserne går

## Selvbetjent kontosletning (`delete_my_account`, migration 056+)

Brugeren sletter sin konto i appen (Bilprofil → Slet konto). RPC'en kører i én
transaktion og:

- **Anonymiserer** medlemmet i alle workspaces: visningsnavn erstattes af et anonymt
  navn, e-mail fjernes, medlemskabet deaktiveres.
- **Sletter** alle push-tokens (`expo_push_tokens`) og legacy-web-push-rækker for
  brugerens e-mail.
- **Renser** rate-limit-registre og nuller aktørfelter (`actor_email`,
  `actor_user_id`) i operatør-audit-loggen.
- **Skriver** en anonymiseret feed-hændelse ("… er anonymiseret. Gruppens regnskab
  er uændret.") så øvrige medlemmer kan se hvorfor navnet ændrede sig.
- Auth-brugeren slettes i Supabase Auth.

Adfærden er CI-testet: `tools/test-functional-smoke.sh` (GV-180) kører RPC'en mod en
frisk database i Docker og asserterer hver scrub på hver PR.

## Hvad der bevidst IKKE slettes

**Regnskabshistorikken** (ture, tankninger, udgifter, afregninger) består —
pseudonymiseret — fordi den er de ØVRIGE medlemmers fælles regnskab. Grundlag:
art. 17(3)(b)/(e)-hensyn og øvrige medlemmers berettigede interesse; en tur, Lars
har betalt sin andel af, forsvinder ikke fordi chaufføren sletter sin konto.
Rækkerne peger på det anonymiserede medlem og kan ikke længere henføres til personen
med rimelige midler.

## Kendte begrænsninger (oplyses ved sletteanmodninger)

1. **Backups**: Slettede/anonymiserede data lever videre i Supabase-backups indtil
   backup-vinduet er rullet [OPERATØR-FAKTA: vindue — se backup-restore.md].
   Backups overskrives rullende og genindlæses kun ved katastrofe; ved en
   restore SKAL sletteanmodninger siden backup-tidspunktet genafspilles
   (incident-response.md, trin 6).
2. **Fejltelemetri**: Sentry-events udløber efter TTL i stedet for at blive slettet
   aktivt; konventionen "ingen PII i beskeder" begrænser eksponeringen.
3. **Push-indhold**: Allerede leverede notifikationer på modtagerens enhed (med
   navne/beløb) kan ikke tilbagekaldes.
4. **Workspace-sletning**: Der er intet selvbetjent "slet hele workspacet" — det er
   en operatørhandling (admin-konsollens cleanup, GV-303, er soft-delete).
   Bilens stamdata inkl. nummerplade består til workspacet nedlægges af operatøren.

## End-to-end-verifikation (udestående evidens)

| Test | Status | Evidens |
|---|---|---|
| Kontosletning i prod med engangskonto (opret → deltag → slet → verificér scrubs i SQL) | ⚠️ Udestår | Dato + operatørens SQL-verifikation her |
| Dataeksport (GVM-335) på rigtig konto: eksportér, åbn filen, kontrollér fuldstændighed | ⚠️ Udestår | Dato + kontrol her |

Dataeksporten (art. 20) er klient-side: filen bygges på enheden med ubegrænset
paginering, uploades aldrig, og indholdet logges aldrig (`src/lib/data-export.ts`
i govehlo-mobile, enhedstestet).
