# Backup og restore-drill

## Backup-posture

Backups er **Supabase-styrede** (dashboardet → Database → Backups). Fakta der skal
holdes ajour her:

- Plan: [OPERATØR-FAKTA: Free/Pro — afgør backup-vindue]
- Kadence + opbevaringsvindue: [OPERATØR-FAKTA: fx daglige backups, 7 dages vindue]
- Point-in-Time Recovery aktiveret? [OPERATØR-FAKTA]
- Backups ligger hos Supabase i EU-regionen sammen med projektet.

GDPR-konsekvensen af vinduet: slettede data lever i backups indtil vinduet er
rullet — det er den frist, der oplyses ved sletteanmodninger
(deletion-limitations.md, begrænsning 1).

**Dumps med produktionsdata må aldrig committes eller ligge i repoet.** Gem dem
uden for arbejdsmappen og slet dem straks efter drillen.

## Restore-drill — procedure

Formål: bevise at backuppen faktisk kan genskabes til en brugbar database, i stedet
for at antage det. Kadence: **mindst kvartalsvis** og efter større skemaændringer.

1. Download nyeste backup-dump fra Supabase-dashboardet (eller `supabase db dump`).
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
