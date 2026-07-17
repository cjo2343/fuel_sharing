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
| 2026-07-17 | vehloshare-backup.sql.gz | sha256:30bb7db46da5… | 0.5 MB | 132 migrationer (130_operational_retention) | 9 workspaces | BESTÅET |

Noter til 2026-07-17-drillen: manuelt pg_dump (Postgres 17-image) mod
session-pooleren — Free-planen har ingen dashboard-backups endnu. 350 tolererede
restore-fejl, alle i den forventede klasse (supabase_admin/pgbouncer-roller,
pg_net-extension — intet i public-skemaet). RLS bekræftet aktiv på alle 14
kernetabeller efter restore; repræsentativ RPC eksekverede. vehicle_repairs og
expo_push_tokens var tomme i prod (sidstnævnte forventet — ingen enheder har
registreret push-tokens endnu).
