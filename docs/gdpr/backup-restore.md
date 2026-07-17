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
| _(første drill udestår)_ | | | | | | |
