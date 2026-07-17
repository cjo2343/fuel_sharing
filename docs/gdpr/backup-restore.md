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
   backups kan ikke downloades). Gem det krypteret uden for repoet.
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

## Drill-log

| Dato | Dump | Checksum | Størrelse | Tracker-status | Workspaces | Resultat |
|---|---|---|---|---|---|---|
| 2026-07-17 | vehloshare-backup.sql.gz | sha256:30bb7db46da5… | 0.5 MB | 132 migrationer (130_operational_retention) | 9 workspaces | BESTÅET |

Noter til 2026-07-17-drillen: manuelt pg_dump (Postgres 17-image) mod
session-pooleren — Free-planen har ingen dashboard-backups endnu. 350 tolererede
restore-fejl, alle i den forventede klasse (supabase_admin/pgbouncer-roller,
pg_net-extension — intet i public-skemaet). RLS bekræftet aktiv på alle 14
kernetabeller efter restore; repræsentativ RPC eksekverede. vehicle_repairs og
expo_push_tokens var tomme i prod (sidstnævnte forventet — ingen enheder har
registreret push-tokens endnu).
