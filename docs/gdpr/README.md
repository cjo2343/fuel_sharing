# GDPR-evidenspakke (GV-258 / GV-310)

Operationel GDPR-dokumentation for VehloShare (tidl. GoVehlo): delebils-udgiftsdeling
for små grupper i Danmark. Én delt Supabase-database (EU) bag to produkter:
**govehlo-mobile** (React Native-appen) og **govehlo-web** (landing, admin-konsol,
`/api/*` Functions). Dette repo er den kanoniske kilde til databaseskemaet, og derfor
også hjemsted for denne pakke.

## Indhold

| Dokument | Indhold |
|---|---|
| [ropa.md](ropa.md) | Fortegnelse over behandlingsaktiviteter (art. 30) |
| [subprocessors.md](subprocessors.md) | Databehandlere/underdatabehandlere med region og datatyper |
| [retention.md](retention.md) | Opbevaringsfrister pr. dataklasse — med ærlig status (automatisk/manuel/hul) |
| [deletion-limitations.md](deletion-limitations.md) | Hvad kontosletning faktisk sletter, og hvor grænserne går |
| [incident-response.md](incident-response.md) | Brud-runbook (art. 33/34) + hændelseslog |
| [backup-restore.md](backup-restore.md) | Backup-posture, restore-drill-procedure og drill-log |

## Status på de fire operationelle punkter (Codex-review 2026-07-17)

1. **"Verify scheduled retention cleanup actually executes"** — verificeret: der kørte
   INGEN oprydning (migration 009's funktioner havde nul kaldere). Erstattet af
   `run_operational_retention` (migration 130, GV-309) + planlagt hook. Status og
   frister: [retention.md](retention.md).
2. **"Test account deletion and data export end to end"** — begge features findes og er
   enheds-/Docker-testet (delete_my_account-smoke i CI; dataeksport GVM-335 med tests).
   End-to-end-kørsel i produktion udestår — se [deletion-limitations.md](deletion-limitations.md)
   for testplanen og evidensfelterne.
3. **"Document backup retention, deletion limitations, subprocessors, incident handling"**
   — denne pakke. Felter markeret **[OPERATØR-FAKTA]** kræver opslag i dashboards
   (Supabase-plan, DPA'er) og udfyldes af operatøren.
4. **"Perform a restore drill"** — værktøj: `npm run drill:restore -- <dump>`
   ([tools/restore-drill.mjs](../../tools/restore-drill.mjs)). Procedure og log:
   [backup-restore.md](backup-restore.md).

## Vedligehold

- Nye behandlinger (ny vendor, ny datatype) ⇒ opdatér ropa.md + subprocessors.md i
  samme PR som koden.
- Restore-drill: mindst kvartalsvis; resultat i backup-restore.md's log.
- Ejer: operatøren (controller). Kontakt: services@govehlo.dk.
