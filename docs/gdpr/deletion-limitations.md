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

**Undtagelse — sidste aktive medlem:** er brugeren det ENESTE aktive medlem i et
workspace, er der ingen andres regnskab at bevare, og hele workspacet hård-slettes
i stedet (cascade gennem alle børnetabeller: ture, events, bookinger — alt).
Data-minimering frem for pseudonymisering, når intet formål består.

## Kendte begrænsninger (oplyses ved sletteanmodninger)

1. **Backups**: Projektets nuværende Free-plan har ingen managed backups/PITR.
   Logical dumps taget til restore-drills eller migrationer kan dog indeholde
   slettede data indtil deres korte rotation udløber. Efter opgradering til Pro
   er managed-vinduet syv dage. Ved enhver restore SKAL sletteanmodninger siden
   dump-/backup-tidspunktet genafspilles (incident-response.md, trin 6).
2. **Fejltelemetri**: Sentry-events udløber efter TTL i stedet for at blive slettet
   aktivt; konventionen "ingen PII i beskeder" begrænser eksponeringen.
3. **Push-indhold**: Allerede leverede notifikationer på modtagerens enhed (med
   navne/beløb) kan ikke tilbagekaldes.
4. **Workspace-sletning**: `delete_my_account` hård-sletter hele workspacet med
   cascade, når det sidste aktive medlem forlader det. Et workspace med andre
   aktive medlemmer består af hensyn til deres fælles regnskab. Anomale
   workspaces uden aktive medlemmer slettes kun efter manuel operatør-review;
   inaktivitet alene udløser aldrig automatisk sletning.

## End-to-end-verifikation (udestående evidens)

| Test | Status | Evidens |
|---|---|---|
| Kontosletning i prod med engangskonto (opret → deltag → slet → verificér scrubs i SQL) | ✅ BESTÅET | 2026-07-17: engangskonto (claude+e2e-test@…) oprettet i eget workspace + 1 tur; "Slet konto" kørt i appen. SQL-verifikation: 0 rækker tilbage i auth.users / expo_push_tokens / ledger_events.actor_email / owner_activity_log for e-mailen; workspacet hård-slettet inkl. tur (sidste-medlem-grenen). App logget ud; kold start genopliver IKKE sessionen (modsat GVM-362-fejlen for alm. log-ud). |
| Dataeksport (GVM-335) på rigtig konto: eksportér, åbn filen, kontrollér fuldstændighed | ✅ BESTÅET | 2026-07-17: eksport kørt på rigtigt medlem; fil `vehloshare-data-eksport-2026-07-17.json` (13 kB) skabt on-device, aldrig uploadet. Struktur verificeret: format vehloshare-export/2, profil matcher den indloggede konto, kun medlemmets EGNE rækker (ejerskabs-afgrænsning bekræftet — delt synlighed giver ikke eksport-adgang til andres rækker). |

Dataeksporten (art. 20) er klient-side: filen bygges på enheden med ubegrænset
paginering, uploades aldrig, og indholdet logges aldrig (`src/lib/data-export.ts`
i govehlo-mobile, enhedstestet).
