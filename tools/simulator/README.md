# The workspace simulator (GV-471)

A deterministic, multi-user, multi-workspace fuzzer for the shared VehloShare schema,
with a live mission-control dashboard.

```sh
npm run sim:run -- --workspaces 4 --members 4 --ticks 400 --seed 42 --serve
npm run test:simulator          # short self-test (clean run + chaos run)
```

Needs Docker. Nothing else — no npm dependency was added, and none will be.

---

## Why this exists

Every other guard in `tools/` asserts a **scripted** sequence: call this RPC, then that
one, then check. They are very good at the bug you already thought of, and structurally
unable to find the other kind:

- an edit that lands against a period somebody else closed two moves ago,
- a booking whose end time is corrected *after* its handover was written (migration 189's
  restamp, and therefore migration 193's mirror),
- a delete that arrives after a settlement was requested,
- four people interleaving across four workspaces for four hundred moves, each with their
  own habits.

Nobody writes those tests, because nobody thinks of them. This tool runs them by not
thinking of them either: it draws an action from a persona's weights, sends it to the
real RPC, classifies the answer, and every N ticks stops the world and asks the database
seven questions that no successful write is allowed to have broken.

---

## Determinism is the product

A fuzzer that cannot hand back a reproduction is a rumour generator. So:

- Every decision comes from a seeded PRNG (`lib/prng.mjs`, mulberry32). There is no
  `Math.random()` and no `Date.now()` anywhere in a decision path.
- Domain time comes from a **simulated clock** that advances 1–6 simulated hours per tick,
  drawn from the same PRNG. Trip dates, booking windows, expense dates and observed_at
  stamps all derive from it.
- Wall-clock time is used in exactly two places, both outside the decision path and both
  excluded from the determinism digest: the measured RPC latency (`ms`) and the journal
  line's display timestamp (`ts`).

Two runs of the same seed and configuration produce byte-identical action journals. The
proof is a digest over `(tick, simOffsetMin, workspace, actor, persona, action, outcome,
guardKind)` printed at the end of every run:

```
determinism digest (actions only): 9bdd243b7212878a79c235bb9cb73edddd069a8fcc6ea5b371387be5112dbbfc
```

### The epoch, and the one thing determinism costs

Several production rules read `now()` — a handover may not be written before its booking
has *started* (migration 189), a recurring template's next due date must fall within
`[today-90d, today+5y]`, a repair date may not be more than a year ahead. If the simulated
clock straddled the real one, those rules would answer differently depending on the hour
the run happened.

So the whole run is anchored in the **past**: the epoch defaults to today minus the run's
simulated span plus three days of margin, and booking lead times are capped at 40 hours so
even the last tick's booking has started before the real present. `--epoch YYYY-MM-DD`
pins it explicitly, and every repro command the tool prints includes the epoch it used.

The cost, stated plainly: **guards keyed to "is this booking active right now" can never
fire.** The wall-clock half of the booking-log policy (GVM-413/417) is out of this tool's
reach. That is a known blind spot, not an oversight.

A second consequence: runs longer than roughly 600 ticks push the epoch more than 90 days
back, at which point `upsert_recurring_expense` starts rejecting next-due dates as out of
range. Those show up as `validation` guards, not as findings.

---

## What a run does

1. Boots the canonical disposable Postgres 17 container (`tools/lib/replay-container.mjs`
   — the same image every Docker guard uses) and applies `supabase-schema.sql`. A run is
   therefore also a fresh-install validation of the consolidated schema.
2. Mints synthetic `auth.users` rows. This is the only object with no production write
   path, exactly as the load rehearsal found.
3. Seeds each workspace through the **production onboarding RPCs**:
   `create_private_ledger_workspace` → `get_workspace_join_code` → `redeem_ledger_invite`
   per member → `set_tank_baseline` → `update_ledger_settings`.
4. Runs the tick loop. Each tick: advance the simulated clock, pick a workspace (weighted
   by member count), pick an actor, draw an action from that actor's persona weights, build
   one statement, send it, classify the answer, journal it.
5. Every `--oracle-every` ticks (and once at the end), runs the invariant sweep.
6. Writes `out/journal.jsonl`, `out/violations.json`, and a console report.

### Outcomes

| Outcome | Meaning |
|---|---|
| `ok` | the RPC succeeded |
| `guard` | the database refused, and refusing was the right answer |
| `error` | the database refused and nothing in the catalogue says it should have |

`guard` is a **success signal**. A run with no guards is a run whose fuzz never reached an
edge, and `npm run test:simulator` fails if a clean run produces zero of them. The
expected-rejection catalogue in `lib/actions.mjs` is built from the actual `raise
exception` texts in `supabase-schema.sql` and matches on the **message**, not only the
SQLSTATE — 22023 and 42501 each cover a dozen unrelated rules, and a SQLSTATE-only
catalogue would launder a real bug into "expected".

An `error` is recorded exactly like an oracle violation.

### Personas

Assigned at seed time and kept for the whole run (`lib/personas.mjs`). Slot 0 is always
the admin — the only persona that closes periods or changes settings, mirroring the SQL's
own admin gates.

| Persona | What they do |
|---|---|
| Administrator | settings, settlement requests, period closes |
| Storforbruger | most of the kilometres and most of the fills |
| Glemsom logger | backdated entries, and entries that land after a period was prepared |
| Serieredigerer | edits and deletes recent entries, and moves booking windows |
| Bookinggal | bookings, handovers with odometer + fuel readings, completions |

### Actions

Trips (create / edit / backdate / crossing / delete / edit-inside-a-closed-period), fuel
logs (with and without a full tank, backdated, edited, deleted), bookings (create, edit
window, deliberately overlapping, cancel, complete into a trip with all four fuel
resolutions), handovers, workspace expenses (one-off, recurring template, `generate_due`),
repairs, settlement request / mark-paid / confirm, the full period-close choreography, tank
baseline, settings, member rename, messages.

Several actions are **hostile on purpose** — `edit_trip_in_closed_period`,
`create_overlapping_booking`, deleting a fuel log after a settlement was requested, editing
a booking's end after its handover exists, and passing a stale `expected_updated_at` on one
edit in five. For those the expected outcome is a specific guard; anything else is a
finding.

---

## The oracle

Seven invariants, checked per workspace. Failures are keyed by `(invariant, workspace)`, so
a corruption that survives several sweeps is one violation, not five.

| # | Invariant | What it asserts |
|---|---|---|
| 1 | `zero_sum` | per open/queued period, the member nets from `calculate_period_settlement` sum to zero within `n × 0,005 kr` |
| 2 | `closed_fingerprint` | a closed period's stored `entryFingerprint` still equals a fresh `calculate_period_entry_fingerprint` |
| 3 | `handover_mirror` | migration 193: `ledgers.max_handover_odometer >= max(booking_handovers.end_odometer)`, and the latest fraction/observed_at pair equals a fresh recompute |
| 4 | `participant_denorm` | migration 192: every `trip_participants.ledger_id` equals its trip's |
| 5 | `rls_isolation` | a member of workspace A, as role `authenticated`, sees **zero** rows of workspace B across eleven tables |
| 6 | `event_classification` | every `event_type` a run actually wrote is in `FEED_VISIBLE_EVENT_TYPES` or `EVENT_TYPE_EXCLUDE` (GV-413) |
| 7 | `recurring_integrity` | no duplicate `(recurring_expense_id, occurrence_date)`, and `workspace_expenses_recurrence_uq` still exists |

Two of these deserve their reasoning written down.

**Why invariant 1 has a tolerance.** Expenses, repairs and crossings each run a
largest-remainder integer-øre split, so those three sum exactly. The fuel share does not:
`tripCost` is `round(km × (totalPaid / totalKm), 2)` per member — an independent rounding
per person — so the sum can miss `totalPaid` by up to half an øre per member. Anything
beyond `n × 0,005 kr` is arithmetic that lost money.

**Why the close stores a fingerprint.** `buildCloseSnapshot` in the load rehearsal omits
`entryFingerprint` deliberately (a client that cannot hash must still be able to close).
The simulator asks the *server* for it and puts it in the snapshot, so the close persists
it into `snapshot_json` and invariant 2 has something to recompute against later. Without
that, closed-period immutability is unobservable after the fact.

### `--chaos`: the oracle's self-test

An oracle that never fires passes every clean run there is. `--chaos` injects one known
corruption with raw service-role SQL right after seeding — it contradicts migration 193's
mirror fraction pair — and immediately sweeps. The run must then flag exactly that one
violation, and `npm run test:simulator` asserts it.

> A note on the obvious corruption. Pushing `max_handover_odometer` *above* the true
> maximum is **not** a corruption: migration 193 makes that column deliberately monotone,
> so a value above the table's max is exactly what an edited-down or deleted handover
> leaves behind. The oracle asserts `mirror >= table max` for that reason, and the
> detectable corruption is the fraction pair, which 193 recomputes rather than ratchets.

### Reviewed findings

A finding this tool has already surfaced and that a person has read lives in
`KNOWN_FINDINGS` in `run.mjs`. It is still detected, still printed, still written to
`violations.json` — it just does not fail the run, so `npm run test:simulator` keeps
meaning *"the harness works and nothing new appeared"*. Each entry carries a **narrow**
match: a broad one would quietly swallow the next real bug in the same invariant.

Current entries: **none.** An empty registry is the healthy state — a finding is
supposed to leave it when it is fixed, not sit there as a silencer.

### Fixed: GV-471-F1 — fuel paid in a period with zero kilometres was credited to nobody's debit

The tool's first finding, and the reason the registry pattern exists. Kept here as
history now that it no longer belongs in `KNOWN_FINDINGS`.

`calculate_period_settlement`'s `net` expression was
`case when totalKm > 0 then fuelPaid + … - tripCost - shares else fuelPaid + … - shares end`.
The `else` branch omits `tripCost` — correct, a per-km rate is undefined at zero km — but
it also omitted any other way of charging the fuel. A period holding fuel logs and no live
trips therefore credited the payer the full amount, debited nobody, and stopped netting to
zero by exactly `totalPaid`; the close guard only compares snapshot totals, so such a
period could be archived with a payer owed money nobody owed. Reachable in production the
moment a group logs a fill before its first trip of a new period, or deletes the only trip
in one.

**Fixed by migration 194 (GV-472):** fuel bought in a period with no kilometres is
excluded from `net`, reported as a `deferredFuel` block, and moved into the next period by
`close_settlement_period`, where it is split against real kilometres. Pinned by
`tools/test-zero-km-fuel-carryforward-contract.mjs`.

The historical repro, kept for posterity — on the **pre-194** schema
`--workspaces 4 --members 4 --ticks 400 --seed 11 --oracle-every 25 --epoch 2026-06-07`
hit it three times: 637,36 kr (open period), 938,20 kr (a **queued** period, so migration
140's carry-over path was affected too) and 262,66 kr. In every case the residue equalled
`totalPaid` to the øre, which was the signature. That same command is now clean.

---

## The violation report and the repro workflow

Any oracle failure or `error` outcome writes `out/violations.json` with the seed, the tick,
the invariant or action, the full detail, and the last 50 journal lines — the context a
reader needs and cannot reconstruct. It also prints the one command that reproduces the
run exactly:

```
node tools/simulator/run.mjs --workspaces 4 --members 4 --ticks 400 --seed 42 \
  --oracle-every 25 --epoch 2026-06-07 --headless
```

`--headless` exits non-zero when there is at least one **new** (non-reviewed) violation.

---

## Mission control (`--serve`)

`--serve [port]` (default 8471, localhost only) starts a `node:http` server with three
routes:

- `GET /` — `dashboard.html`, one self-contained file with no external request of any kind
- `GET /events` — Server-Sent Events, replaying the journal **from line 1** and then
  following it
- `GET /state` — the current snapshot as JSON

That single SSE choice is what makes the live view and the report view the same page:
opening the dashboard after a run replays the whole run and then has nothing more to
follow. The server stays up after the run ends so the report can be read.

Panels: run header with seed, configuration, simulated clock and tick progress; a workspace
grid with live per-member balances, open-period status and last action; a scrolling action
ticker where guards are visually distinct from errors; an invariant wall (one cell per
invariant × workspace, click for the detail JSON); an RPC latency/count table with inline
SVG sparklines; and a violations panel showing the exact repro command.

The dashboard follows the branding rules: amber `#F4A261` for money amounts only, blue
`#355d9c` only for the "Anmodet" settlement chip, Courier New for odometers, fuel and
latencies, Danish number formatting and labels throughout, sentence case, no emoji, inline
SVG icons.

---

## Safety and GDPR

- **No env file, no connection string, no URL.** The only database this tool can address is
  a container it started itself, addressed by container name, removed on exit (`--keep`
  leaves it for inspection). There is no code path that can point it at production. This is
  the same safety property `tools/load-rehearsal/lib/pg-local.mjs` documents, preserved
  deliberately.
- **Synthetic data only.** Every name, place and email is fixture text; addresses use the
  `.invalid` TLD, which by RFC 6761 can never resolve, so no synthetic address can ever be
  mailed.
- **The server binds `127.0.0.1` explicitly.** A run's data is synthetic, but it is still a
  workspace's data in shape, and a dashboard is not a thing to expose on a network
  interface by accident.
- `out/` is git-ignored.

---

## Why this is not in `npm run validate`

`npm run validate` is dependency-free by contract — no Docker, no Python — and runs on
every push. The simulator hosts a Postgres container and takes tens of seconds. It belongs
with the other Docker-backed checks, as its own npm script.

`npm run test:simulator` is the short self-test: a 60-tick clean run (must finish, must
produce guards, must report no new violation) and the same run with `--chaos` (must report
exactly one new violation, and it must be the injected one). It warns and exits 0 without
Docker, like every other Docker-backed guard here, and fails under `--strict`.

---

## Files

| File | Role |
|---|---|
| `run.mjs` | CLI, container boot, seeding, tick loop, reporting, reviewed findings |
| `lib/prng.mjs` | seeded PRNG and the simulated clock |
| `lib/personas.mjs` | five personas and their action weights |
| `lib/actions.mjs` | the action catalogue and the expected-rejection catalogue |
| `lib/oracle.mjs` | the seven invariants |
| `lib/journal.mjs` | the append-only JSONL stream and the determinism digest |
| `lib/db.mjs` | the persistent `psql` session, SQL literal helpers, `sim_exec` |
| `lib/server.mjs` | the `--serve` web server |
| `dashboard.html` | mission control, single file, zero external requests |

`lib/db.mjs` is the one module the GV-471 brief did not name. It exists because the
simulator's shape is the opposite of every other Docker guard's: hundreds of tiny
statements whose individual outcome and latency are the product, rather than a handful of
large ones. One `docker exec psql` per action would cost ~50–100 ms of process overhead
against a ~1 ms RPC, so the session is held open for the whole run and spoken to over a
line protocol. Keeping that in `run.mjs` would have doubled its length for no gain.
