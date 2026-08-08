# Backup og restore-drill

## Backup-posture

Dashboard-verifikation udført **2026-07-17** på projekt
`kdudfqzglhydmzntqosb`:

- Plan: **Free**.
- Managed backup-kadence/vindue: **ingen**. Dashboardet siger eksplicit, at Free
  Plan ikke omfatter project backups.
- Point-in-Time Recovery: **ikke tilgængelig/ikke aktiveret** på planen.
- Projektregion: EU. Der findes derfor heller ingen managed backupkopi at placere
  eller gendanne endnu.

Supabase dokumenterer, at Pro giver daglige backups med syv dages vindue, mens
PITR er et betalt add-on og kræver mindst Small compute. Fysiske/PITR-backups kan
ikke downloades som dump; en flytbar restore-drill kræver `supabase db dump` eller
`pg_dump`: https://supabase.com/docs/guides/platform/backups.

**Release-beslutning:** Free-planens nul-backup er ikke acceptabel til reel
produktion. Opgradér til mindst Pro før offentlig release. Indtil opgraderingen
skal operatøren tage et krypteret logical dump efter større produktionsmigrationer;
en automatiseret daglig off-site dump er alternativet, hvis Pro udskydes.

GDPR-konsekvensen efter opgradering: slettede data lever i managed backups, indtil
backupvinduet er rullet. På nuværende Free-plan findes det vindue ikke; logical
dumps skal have en dokumenteret slettefrist lig deres korte rotationsvindue.

**Dumps med produktionsdata må aldrig committes eller ligge i repoet.** Gem dem
uden for arbejdsmappen og slet dem straks efter drillen.

## Interim før Pro-opgraderingen (GV-313)

Indtil Pro-planen er aktiv findes der INGEN automatiske backups. Interim-regler:

- Tag et manuelt dump FØR enhver risikabel SQL-apply, og mindst ugentligt.
  Prod kører Postgres 17 (GV-314), så dump med 17-imaget:
  ```sh
  read -s DBURL   # session-pooler URI fra dashboardet; indtastes usynligt
  docker run --rm postgres:17-alpine pg_dump "$DBURL" | gzip > ~/vehloshare-backup.sql.gz
  unset DBURL
  ```
- **Behold det nyeste dump** (sikkert, uden for repo og cloud-synk) — det er det
  eneste backup indtil Pro. Slet-efter-drill-reglen ovenfor gælder først, når de
  daglige Supabase-backups eksisterer; rotér da de manuelle dumps ud.

## Restore-drill — procedure

Formål: bevise at backuppen faktisk kan genskabes til en brugbar database, i stedet
for at antage det. Kadence: **mindst kvartalsvis** og efter større skemaændringer.

1. Opret et frisk logical dump med `supabase db dump`/`pg_dump` (managed fysiske
   backups kan ikke downloades). **Brug 17-imaget** — prod kører Postgres 17.x, og
   et ældre `pg_dump` nægter at læse serveren med
   `server version mismatch: server 17.6, pg_dump 15.18` (set i den første drill
   2026-07-17, GV-314):
   ```sh
   read -s DBURL   # session-pooler URI fra dashboardet; indtastes usynligt
   docker run --rm postgres:17-alpine pg_dump "$DBURL" | gzip > ~/drill-dump.sql.gz
   unset DBURL
   ```
   Gem det krypteret uden for repoet.
2. Kør drillen (Docker påkrævet):
   ```sh
   npm run drill:restore -- ~/Downloads/backup.sql.gz
   ```
   Værktøjet ([tools/restore-drill.mjs](../../tools/restore-drill.mjs)) genskaber
   dumpet i en engangs-Postgres-container og asserterer: migrations-tracker til
   stede og ajour med repoet, alle kernetabeller findes med RLS slået til,
   nøgle-RPC'er overlevede, og en repræsentativ RPC kan faktisk eksekvere mod
   dataene. Rækketal rapporteres som evidens.
3. Indsæt evidenslinjen fra outputtet i loggen herunder.
4. Slet dump-filen.

Fejler drillen: behandl det som en hændelse (incident-response.md) — en backup der
ikke kan genskabes, er ingen backup.

**Efter en RIGTIG genskabelse (eller enhver bulk-import) i prod: kør `analyze;` som
sidste skridt (GV-466).** Friske, ustatistik-belagte tabeller får planlæggeren til
at vælge forkerte planer — målt i GV-438: feed-læsningen flipper til en Bitmap-scan
over ALLE events og går fra ~1 ms til 25–75 ms, voksende lineært, indtil autovacuum
tilfældigvis når tabellen. Én `analyze;` i SQL-editoren lukker vinduet med det
samme. (En planlagt ANALYZE-cron og et forsikrings-indeks blev begge målt og
fravalgt — cronen løser et problem autovacuum allerede løser i drift, og indekset
gav 0 ms i dag mod evig vedligehold af dets prædikat.)

> **Næste drill kræver et FRISKT dump (GV-393).** Drillen udleder sit
> aktualitetskrav fra `tools/test-migrations.mjs`' `expected`-liste og fejler hårdt
> på et dump, der er ældre end den nyeste forventede migration. Seneste drill
> (2026-07-18) kørte på et dump ved migration 133; repoet står nu ved **147**, så
> det gemte dump vil fejle med det samme. Tag et nyt `pg_dump` fra prod før
> `npm run drill:restore` køres igen — det er en manuel handling, ikke noget CI kan
> gøre. Kør den gerne umiddelbart efter at have anvendt en migration, mens dumpet
> stadig er aktuelt.

## Drill-log

Seneste drill: migration 133 (2026-07-18)

> Linjen ovenfor er **maskinlæst** af [`tools/check-release-gates.mjs`](../../tools/check-release-gates.mjs)
> (GV-422), som sammenligner tallet med det højeste migrationsnummer i
> `supabase/migrations/` og markerer et efterslæb over 15 migrationer som en
> release-blocker. Formatet er fast: `Seneste drill: migration NNN (YYYY-MM-DD)`.
> Opdatér den — sammen med en ny række i tabellen — hver gang en drill er kørt.
> Indtil GV-422 stod tallet kun i prosa, og derfor var der intet, der kunne se, at
> drillen sakkede bagud.

| Dato | Dump | Checksum | Størrelse | Tracker-status | Workspaces | Fejl | Rækker | Tracker | Resultat |
|---|---|---|---|---|---|---|---|---|---|
| 2026-07-17 | vehloshare-backup.sql.gz | sha256:30bb7db46da5… | 0.5 MB | 132 migrationer (130_operational_retention) | 9 workspaces | 350 tolereret (uklassificeret) | ikke verificeret | — | BESTÅET (før hærdning) |
| 2026-07-18 | vehloshare-backup-2026-07-18.sql.gz | sha256:2e41c87facd1… | 0.5 MB | 133 migrationer (131_gdpr_retention_policy) | 9 workspaces | fejl: 329 tolereret / 0 fatale | 25/25 tabeller verificeret (0 afvig) | aktuel | BESTÅET |

Noter til 2026-07-17-drillen: manuelt pg_dump (Postgres 17-image) mod
session-pooleren — Free-planen har ingen dashboard-backups endnu. 350 tolererede
restore-fejl, alle i den forventede klasse (supabase_admin/pgbouncer-roller,
pg_net-extension — intet i public-skemaet). RLS bekræftet aktiv på alle 14
kernetabeller efter restore; repræsentativ RPC eksekverede. vehicle_repairs og
expo_push_tokens var tomme i prod (sidstnævnte forventet — ingen enheder har
registreret push-tokens endnu).

Noter til 2026-07-18-drillen: første kørsel med den hærdede drill (GV-325) —
eksplicit fejl-allowlist (ukendt ⇒ fatal), eksakt rækketal-verifikation mod
dumpets egne COPY-blokke og dump-aktualitetskrav afledt af migrationsguardens
expected-liste. Drill-containeren kører nu postgres:17 (matcher prods 17.x) —
den første kørsel på 15 fejlede korrekt på PG17-only-støj (GRANT MAINTAIN,
transaction_timeout), hvilket bekræftede at versions-mismatch nu fanges i
stedet for at tolereres. Alle 329 tolererede fejl positivt klassificeret
(roller/pg_net/supabase_vault/publication/bootstrap-stubs); 0 fatale; 25/25
public-tabeller matcher dumpet eksakt. Samme dump fungerer som opdateret
interim-backup (erstatter 2026-07-17-dumpet).
