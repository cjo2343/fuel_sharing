# Hændelseshåndtering (databrud) — runbook

Gælder ethvert sikkerhedsbrud der rammer persondata: lækket nøgle, RLS-fejl der
eksponerer andres data, kompromitteret operatørkonto, fejlsendt push/e-mail,
tabt/utilsigtet offentliggjort backup.

## Opdagelse

Kilderne der kan udløse denne runbook:

- **Sentry (EU)** — fejlspidser, uventede exceptions i auth-/RLS-nære stier.
- **Better Stack** — nedetid (kan maskere et angreb).
- **Admin-konsollens Health** — migrationsdrift, settlement-integritetsbatchen
  (drift = muligt dataintegritetsbrud), fejltal pr. workspace.
- **owner_activity_log** — uventede operatørhandlinger (kompromitteret adgang).
- **Brugerhenvendelse** til services@govehlo.dk ("jeg kan se en andens data").

## Runbook

1. **Stands blødningen** (minutter): Rotér den kompromitterede nøgle (Supabase
   service-nøgle roteres i dashboardet; Cloudflare-secrets kræver redeploy).
   Ved RLS-hul: patch-migration straks — service-role-only-lockdown af den ramte
   RPC/tabel er den hurtige nødbremse. Ved kompromitteret operatøradgang: fjern
   e-mailen fra Cloudflare Access-policyen.
2. **Bevar evidens**: Notér tidslinje NU (UTC): hvornår opstod, hvornår opdaget,
   hvad er set. Eksportér relevante udsnit af owner_activity_log og Supabase-logs
   før de roterer.
3. **Vurdér omfang** (art. 33(1)-tærsklen): Hvilke persondata, hvor mange
   registrerede, i hvor lang tid? Risiko for de registrerede (økonomiske data +
   navne = reel risiko; tomme/anonymiserede data = næppe). Konklusionen SKRIVES
   i hændelsesloggen — også når vurderingen er "ingen anmeldelse nødvendig"
   (art. 33(5): dokumentationspligt gælder alle brud).
4. **Anmeld til Datatilsynet inden 72 timer** fra opdagelse, hvis brud med risiko:
   via virk.dk → "Anmeld brud på persondatasikkerheden". Delanmeldelse er OK når
   man ikke ved alt endnu — 72-timersfristen venter ikke på fuld afklaring.
5. **Underret de berørte** (art. 34, ved høj risiko) i klart sprog: brug appens
   announcement-banner (`replace_app_announcement`, migration 126) + push + e-mail
   til de berørte. Sig hvad der skete, hvad vi gjorde, hvad de selv bør gøre.
6. **Ved restore fra backup**: genafspil alle sletteanmodninger modtaget efter
   backup-tidspunktet (deletion-limitations.md), og verificér med
   smoke-assertions før tjenesten genåbnes.
7. **Efterspil**: Post-mortem i hændelsesloggen + Jira-tickets på de strukturelle
   fixes. Opdatér denne runbook hvis den var mangelfuld.

## Kontakter

| Rolle | Hvem |
|---|---|
| Dataansvarlig/operatør | [OPERATØR-FAKTA: navn/virksomhed] · services@govehlo.dk |
| Datatilsynet | virk.dk-formular · dt@datatilsynet.dk · +45 33 19 32 00 |
| Supabase support | Dashboard-support (EU-projekt) |
| Cloudflare | Dashboard-support |

## Hændelseslog

Alle brud OG nærved-hændelser logges her (art. 33(5)). Ingen persondata i loggen —
beskriv kategorier, ikke personer.

| Dato | Hændelse | Omfang | Anmeldt DT? | Berørte underrettet? | Post-mortem |
|---|---|---|---|---|---|
| _(ingen endnu)_ | | | | | |
