# The workspace simulator (GV-471)

A deterministic, multi-user, multi-workspace fuzzer for the shared VehloShare schema,
with a live mission-control dashboard.

```sh
npm run sim:run -- --workspaces 4 --members 4 --ticks 400 --seed 42 --serve
npm run test:simulator          # short self-test (clean, determinism, chaos, chaos-parity)
```

Needs Docker. Nothing else — no npm dependency was added, and none will be.

Since GV-471 Phase A it also **runs govehlo-mobile's own settlement code** against every
sweep, when the sibling repo is checked out. See [Client parity](#client-parity-phase-a).

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

Eight invariants, checked per workspace. Failures are keyed by `(invariant, workspace)`, so
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
| 8 | `client_parity` | govehlo-mobile's OWN settlement modules, run on the same rows, produce the same numbers as the SQL — see below. Muted, not green, when the sibling repo is absent |

Three of these deserve their reasoning written down.

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

---

## Client parity (Phase A)

Every other guard in this repo that claims to protect the mobile client from the SQL does
it by **reading** the mobile source. `check-hotpath-mirror.mjs` diffs a column list.
`test-crossing-split-contract.mjs` greps `settlement-calc.ts` for the arithmetic it expects
to find. `test-fuel-stop-verdict-contract.mjs` transcribes the client's scenarios into SQL
by hand. A regex over a TypeScript file can tell you a line still *looks* right; it cannot
tell you the two engines still produce the same number — and the pin drift GV-473 had to
heal, plus GV-472's zero-km divergence, were both exactly that failure.

Invariant 8 does the other thing. At every sweep it loads the rows govehlo-mobile's
gateway would load, **imports and runs the mobile repo's real, unmodified modules** over
them, and diffs what a member would see against what the server says:

| Module | What it contributes |
|---|---|
| `src/lib/settlement-calc.ts` | `calculateSettlements` — `fuelRate`, `totalKm`, `totalPaid`, `totalExpenses`, `totalRepairs`, `totalCrossings`, and per member `km`, `fuelPaid`, `tripCost`, `expensePaid/Share`, `repairPaid/Share`, `crossingPaid/Share`, `net`, plus `deferredFuel` presence and total |
| `src/lib/period-balance.ts` | `periodSettlement` — the app's OWN period scoping, so the scoping is not a transcription that can drift |
| `src/lib/period-snapshot.ts` | `periodEntryFingerprint` — byte-compared against `calculate_period_entry_fingerprint`, the string the close's staleness gate compares |
| `src/lib/odometer.ts` | `deriveOdometer` — the derived reading must not sit below `ledgers.max_handover_odometer` (migration 193's monotone floor) nor above the greatest source, computed independently in SQL |

Money is compared at **half an øre**: both sides round to two decimals, one in `numeric`
and one in binary doubles, so the comparison has to survive representation dust while
still catching a single øre. The fingerprint is compared byte for byte, because "close
enough" has no meaning for a string the server uses to reject a close.

### How the TypeScript is loaded — no build step, no dependency, no flag

The four modules are dependency-free and erasable-syntax-only, so Node can run them. Two
bundler conventions are in the way, and `lib/client-parity.mjs` removes both with
`module.registerHooks` (Node 22.15 / 23.5+), which is synchronous and in-thread — no
worker, no child process, no serialisation boundary:

- a **`load` hook** strips types with `module.stripTypeScriptTypes(src, { mode: "strip" })`.
  Doing it explicitly rather than relying on Node's default means the tool behaves the same
  on Node 22.13 and on Node 24, and `.github/workflows/nightly-simulator.yml` needs no flag
  it does not have. `mode: "strip"` also *refuses* non-erasable syntax (enums, namespaces,
  parameter properties), so a module that would need real transformation fails to load and
  is reported rather than being quietly mistranslated;
- a **`resolve` hook** maps `@/x` → `<mobile>/src/x` and appends `.ts` to extensionless
  relative imports. It only fires for `@/…` or for a relative specifier coming *from* a
  `.ts` file, and nothing in this repo is either, so it cannot touch the simulator's own
  imports.

`SIMULATOR_MOBILE_ROOT` overrides the sibling path (default `../govehlo-mobile` — the
pre-rename directory name, on purpose; see CLAUDE.md).

### Two deliberate deviations from the gateway

Both narrow the check to arithmetic, and both are in `readParityRows`:

- **Members.** The gateway loads `.eq('is_active', true)`; this loads every member and lets
  `calculateSettlements` apply its own `is_active` filter, which is what the SQL's
  `active_members` CTE does. That puts both engines on ONE universe, so a difference is
  arithmetic and not a row-selection choice. The gateway's active-only load does mean an
  inactive payer's GV-274 credit never reaches a phone — a real gap, but a fetch decision,
  so it is reported as a `gatewayActiveOnlyGap` note and never as a violation.
- **Windowing.** The gateway bounds trips/fuel by a date window and a row cap (GVM-559). A
  simulator workspace is far inside both; a windowed read here could only hide rows and
  turn a genuine mismatch into a pass.

### Skipping is a first-class outcome

The nightly workflow checks out this repo alone, so parity must skip cleanly there. When
`../govehlo-mobile` is missing, or a module fails to import, or the Node is too old, the
run prints a loud warning, writes a `parity` journal line saying why, and the dashboard
paints the **Klient-paritet** row as *ikke tilgængelig* — muted with a dashed border and an
em dash, never green. `npm run test:simulator` asserts both directions: with the sibling
present, that parity really compared periods; without it, that every cell is marked
skipped and the run still passes.

### `--chaos-parity`: the parity oracle's self-test

`--chaos` corrupts a column, which proves the database-side invariants fire. It says
nothing about client-vs-server, because both engines would read the corrupted column and
agree. So `--chaos-parity` perturbs the **client's copy of the rows** instead: it drops one
live fuel payment (falling back to a trip, then an expense) from the array handed to the
mobile modules, before they see it, in the first workspace that has one — and never touches
the database. The run must then report exactly one violation, and it must be
`client_parity`. Re-applied to that same workspace on every later sweep, so the invariant
wall does not end green on a run that reported a finding.

### `--fat-finger`

Adds `save_handover_fat_finger` to the booker and serial-editor mixes: a handover odometer
with one extra digit, ten times the plausible reading. It is the commonest odometer mistake
there is, and it matters here because migration 193 makes `ledgers.max_handover_odometer`
**monotone** — one fat finger does not merely record a wrong reading, it ratchets the
workspace's odometer floor and no later correction brings it down.

**Today this write succeeds.** There is no plausibility guard on
`upsert_booking_handover`, so the outcome is `ok`, the mirror is poisoned by design, and
parity stays green because the client faithfully reports the poisoned floor — both engines
are wrong together, which is precisely why a parity check alone cannot catch this class.
That is why it is behind a flag and out of the default mix: a default run must not be red
for a bug nobody has fixed. When migration 195's plausibility guard lands the action flips
to expecting a `guard` outcome and joins the default mix; the exact four-step change is
written down beside the action in `lib/actions.mjs`.

---

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

Current entries: **GV-471-F2**, below. An entry is supposed to leave this list when it is
fixed, not sit there as a silencer.

### Open: GV-471-F2 — the app and the server can print `tripCost` one øre apart

Phase A's first finding, surfaced by `client_parity` on its first long run.

```
node tools/simulator/run.mjs --workspaces 4 --members 4 --ticks 400 --seed 11 \
  --oracle-every 25 --epoch 2026-06-07 --headless        # workspace 0, tick 25
```

One trip, 90 km, two participants; one fill of 221,43 kr. Each participant's `tripCost` is
`45 × (221,43 / 90)` — exactly **110,715 kr**, a true half-øre tie. The two engines land on
opposite sides of it:

| | computation | result |
|---|---|---|
| Postgres | `221.43/90.0` → `2.4603333333333333` (numeric division truncates the repeating decimal to 16 fractional digits), `× 45.0` = `110.7149999999999985` | **110,71 kr** |
| Client | `221.43/90` → `2.4603333333333332611` (double), `× 45` = `110.71500000000000341`, `× 100` = `11071.5` exactly | **110,72 kr** |

Both round half away from zero. They simply disagree about which side of the half the
product is on, and the divide-then-multiply order is what puts it there. Sofie's phone says
she is owed 110,71 kr; the server-derived settlement request says 110,72 kr.

Bounded, and that is why nobody has seen it: the close's integrity gate allows 0,02 kr per
member, so no close can be blocked by it, and the period still nets to zero on both sides.

**The likely fix is one line of SQL, and it belongs in a migration, not here.**
`round(pm.km * (t.total_paid / t.total_km), 2)` divides first and loses the tie;
`round(pm.km * t.total_paid / t.total_km, 2)` keeps full numeric precision through the
multiply — `221.43 * 45.0 / 90.0` is exactly `110.715`, which rounds to `110,72` and agrees
with the client. It does not make the two engines provably identical (the client is still a
double), but it removes the systematic half-øre case, which is the one that recurs. Written
down here rather than done: this PR ships no SQL, and changing a settlement expression is a
migration with a schema mirror, a types regeneration and a close-gate review.

The `KNOWN_FINDINGS` match is narrow in three independent ways — only `client_parity`, only
`person.tripCost` / `person.net`, only a difference of one øre, and only when the mismatch
list was not truncated. Anything larger, or in any other field, still fails the run.

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

`npm run test:simulator` is the short self-test, four 60-tick runs of one fixed seed:

1. **clean** — must finish, must produce guards, must report no new violation;
2. **client parity** — read off the clean run's journal. With `../govehlo-mobile` present:
   the mobile modules imported, at least one period was actually compared (a parity check
   over zero periods is vacuously green, which is the one way this could pass while proving
   nothing), and no new parity violation. Absent: every cell marked skipped, and the run
   still green;
3. **determinism** — the same seed with `--no-parity` must produce the byte-identical
   action digest. Parity is oracle-side and draws no PRNG, and every `repro:` line in this
   repo depends on that staying true;
4. **`--chaos`** and, when the sibling is present, **`--chaos-parity`** — each must report
   exactly one new violation, and it must be the injected one.

It warns and exits 0 without Docker, like every other Docker-backed guard here, and fails
under `--strict`.

---

## Files

| File | Role |
|---|---|
| `run.mjs` | CLI, container boot, seeding, tick loop, reporting, reviewed findings |
| `lib/prng.mjs` | seeded PRNG and the simulated clock |
| `lib/personas.mjs` | five personas and their action weights |
| `lib/actions.mjs` | the action catalogue and the expected-rejection catalogue |
| `lib/oracle.mjs` | the seven invariants |
| `lib/client-parity.mjs` | Phase A: imports govehlo-mobile's calculation modules, reads the rows its gateway would read, and diffs |
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
