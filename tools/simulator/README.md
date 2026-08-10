# The workspace simulator (GV-471 · GV-478 · GV-480)

A deterministic, multi-user, multi-workspace fuzzer for the shared VehloShare schema,
with a live mission-control dashboard.

```sh
npm run sim:run -- --workspaces 4 --members 4 --ticks 400 --seed 42 --serve
npm run test:simulator          # short self-test (clean, rhythm, offline, duplicates,
                                #  contention, determinism, chaos, chaos-parity)
node tools/simulator/run.mjs --help
```

Needs Docker. Nothing else — no npm dependency was added, and none will be.

Since GV-471 **Phase A** it also **runs govehlo-mobile's own settlement code** against
every sweep, when the sibling repo is checked out — see
[Client parity](#client-parity-phase-a).

Since GV-478 **Phase B** the traffic it generates has a shape: a day and week rhythm, a
member who goes offline and syncs in a burst, double-tapped requests, and two psql
sessions colliding on the same lock in deterministic lockstep — see
[Behavioural realism](#behavioural-realism-phase-b).

Since GV-480 **Phase C** the dashboard shows each member's **own phone** and can be
**scrubbed back** to any tick of the run — see [Mission control](#mission-control---serve).

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
- Domain time comes from a **simulated clock**, drawn from the same PRNG. Since GV-478 it
  advances on an hour-of-week rhythm rather than a uniform 1–6 hours
  ([below](#1-day-and-week-rhythm)); `--flat-clock` restores the uniform walk. Trip dates,
  booking windows, expense dates and observed_at stamps all derive from it.
- Wall-clock time is used in exactly two places, both outside the decision path and both
  excluded from the determinism digest: the measured RPC latency (`ms`) and the journal
  line's display timestamp (`ts`).

Two runs of the same seed and configuration produce byte-identical action journals. The
proof is a digest printed at the end of every run:

```
determinism digest (actions only): 9a003e41ffd8fbe639d00d44f1e25afbf511116ae422162d7ce8c5a608081292
```

**GV-478 changed the tuple**, because a tick stopped being one statement. It is now

```
(tick, simOffsetMin, workspace, actor, persona, action, outcome, guardKind,
 dup, session, step)
```

- `dup` — a duplicate send is a separate journal line with the same tick and action as
  the first send. Without this field the two would hash identically and a run that
  double-sent could not be told from one that did not.
- `session` — which psql session the statement went to. A contention scenario's three
  sub-steps differ only in `session` and `step`.
- `step` — the sub-step: `holder` / `contender` / `holder_commit`, `dup:idempotent`,
  `offline-queue:2`, `offline-flush@188`. The offline ones carry the **decision** tick,
  so two runs of one seed must agree not merely on what was flushed but on how long each
  statement had been waiting.

Deliberately **not** in the digest: the simulated weekday and clock label. Both derive
from `--epoch`, which moves with the day a default run happens; `simOffsetMin` is the
epoch-independent half and is already in there.

**`--epoch` became load-bearing.** In Phase A the action stream did not depend on it at
all — every draw was epoch-independent, and the epoch only decided what dates got
written. The day/week rhythm keys off the simulated **weekday**, so two runs of one seed
under different epochs now diverge. Every repro command this tool prints has always
included `--epoch`; since GV-478 a repro without it is not a repro.

### Member ids are deterministic too, and that is not cosmetic

`ledger_members.id` is a `gen_random_uuid()` minted by `redeem_ledger_invite`, so it is
different on every run of the same seed. That would be harmless if nothing ever ORDERED
by it — but the settlement greedy does. `computeSettlementsFromNets` breaks an amount tie
with `a.id.localeCompare(b.id)`, and migration 117's
`enforce_settlement_request_exact_amount` recomputes the same greedy server-side and
refuses a request whose amount disagrees. Two members with **equal nets** — which an equal
split produces constantly — therefore paired up in a different *direction* from one run to
the next, and every choice downstream followed: which pair `request_settlement` picked,
whether `mark_settlement_paid` found one belonging to the actor, which member was the
contender in `settlement_pair_race`.

In Phase A this was a rare flake nobody had hit. Phase B journals an `actorSlot` derived
from the payer's identity, and `npm run test:simulator` started disagreeing with itself
about one run in three.

**The fix has to be the ids, not the ordering.** Changing the tie-break on this side would
simply disagree with the server's copy of the greedy on every tie. So right after seeding
— workspaces created, every member joined, no domain rows written yet —
`stampDeterministicMemberIds()` rewrites every `ledger_members.id` to
`…-9001-<ws><slot>`, derived from the configuration alone. It runs once, in operator
context, inside one transaction with `session_replication_role = replica`, and discovers
the referencing columns from `pg_constraint` rather than listing them, so a migration that
adds a new FK to `ledger_members` cannot silently leave a dangling reference behind.

The side benefit is worth as much as the determinism: a member id in a violation report is
now the same string on a replay, so two runs can be diffed line by line.

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

GV-478's rhythm clock keeps the same property by construction rather than by luck: it
computes a **span budget** from the run's length and clamps at it, and the epoch is chosen
from that same number, so `epoch + budget + the 40-hour booking lead` still lands before
the real present however a seed drifts. If the clamp ever bites, the tail of the run
happens at a standstill — odd, but harmless, and far better than crossing the real clock.

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
   by member count), pick an actor, then do ONE of three things — flush that actor's
   offline queue in a burst, run a lockstep contention scenario across two sessions, or
   draw an action from the actor's rhythm-modulated persona weights, build one statement,
   send it (possibly twice), classify the answer and journal it.
5. Every `--oracle-every` ticks (and once at the end), runs the invariant sweep.
6. Writes `out/journal.jsonl`, `out/violations.json`, and a console report.

### Outcomes

| Outcome | Meaning |
|---|---|
| `ok` | the RPC succeeded |
| `guard` | the database refused, and refusing was the right answer |
| `contention` | (Phase B) two sessions collided on a lock and the database serialised them — SQLSTATE 55P03. A success signal, like `guard` |
| `dup-tolerated` | (Phase B) a re-sent action legitimately created a second row, because that RPC has no idempotency key. A note, never a finding |
| `queued` | (Phase B) the offline persona decided on this write and has not sent it yet |
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
| Offline-pendleren | (Phase B) decides on writes while out of range and sends the lot on reconnect |

The joiner personas are drawn without replacement, so a four-member workspace gets three
of the five and **some personas simply do not appear** in a given workspace. That has
always been true; it matters more now that one of them is a headline feature. A run whose
report says `offline bursts 0` drew the other four — `--members 5`, more workspaces, or
another seed fixes it. `npm run test:simulator` pins a seed that draws it in both
workspaces, precisely so the feature cannot rot unnoticed.

### Actions

Trips (create / edit / backdate / crossing / delete / edit-inside-a-closed-period), fuel
logs (with and without a full tank, backdated, edited, deleted), bookings (create, edit
window, deliberately overlapping, cancel, complete into a trip with all four fuel
resolutions), handovers, workspace expenses (one-off, recurring template, `generate_due`),
repairs, settlement request / mark-paid / confirm, the full period-close choreography, tank
baseline, settings, member rename, messages.

Several actions are **hostile on purpose** — `edit_trip_in_closed_period`,
`create_overlapping_booking`, `save_handover_fat_finger`, deleting a fuel log after a
settlement was requested, editing a booking's end after its handover exists, and passing a
stale `expected_updated_at` on one edit in five. For those the expected outcome is a
specific guard; anything else is a finding.

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

### The fat finger, and migration 195

`save_handover_fat_finger` is in the booker's and the serial editor's **default** mixes: a
handover odometer with one extra digit, ten times the plausible reading. It is the
commonest odometer mistake there is, and it matters here rather than in a form-validation
test because migration 193 makes `ledgers.max_handover_odometer` **monotone** — one fat
finger does not merely record a wrong reading, it ratchets the workspace's odometer floor
and no later correction brings it down.

Until GV-475 this write **succeeded**, so the action lived behind a `--fat-finger` flag: a
default run must not be red for a bug nobody has fixed. Migration 195 added the
plausibility guard — an absolute 2.000.000 km cap and an `anchor + 50.000 km` ceiling,
where the anchor is `greatest(max_handover_odometer, tank_baseline_odometer)`, both
raising the same Danish sentence under errcode `GV475` — so the action is now an ordinary
hostile one, the flag is retired, and `odometer_plausibility` joined the
expected-rejection catalogue (matched on the **message**, per this tool's rule, not on the
SQLSTATE alone).

Two details that are easy to get wrong and cost a debugging session each:

- **The fat finger is always typed by the booking's own member.** The plausibility check
  sits *after* the write gate ("Kun den, der havde bilen, eller en administrator kan gemme
  overdragelsen"), so a fat finger from anybody else is refused for the wrong reason and
  the guard this action exists to reach is never exercised. It is also simply what
  happens: the driver standing at the car types their own reading.
- **`--chaos` no longer sets `max_handover_odometer = 999999`.** That value was only ever
  an illustration of the paragraph in `injectChaos` about monotonicity — the oracle never
  flagged it, by design — and since migration 195 it lifts the workspace's plausibility
  ceiling past a million, which makes the ten-times odometer a *legitimate* reading. The
  chaos run started reporting a `guard-missing` finding for a guard that was working
  perfectly. A self-test must corrupt exactly the thing it claims to corrupt.

The assertion is `mustNotSucceed`, not "expect exactly this guardKind", and the difference
matters: the plausibility check is the *last* thing `upsert_booking_handover` does, so on a
given tick the write can legitimately be refused earlier by the membership gate or by the
GV-421 stale token. What it may never be is **accepted**. A success is reported as a
`guard-missing` violation rather than left to the oracle, because nothing downstream of a
poisoned monotone floor is observably wrong: the client faithfully reports the poisoned
value, both engines agree, and client parity stays green. That is exactly the class a
parity check cannot catch.

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

**The list is empty**, and that is its healthy state. Both findings it has ever held —
GV-471-F1 and GV-471-F2, below — left it the way an entry is supposed to leave it: with
a migration, not with a wider match. An entry is not a silencer.

### Fixed: GV-471-F2 — the app and the server printed `tripCost` one øre apart

Phase A's first finding, surfaced by `client_parity` on its first long run. Kept here as
history now that it no longer belongs in `KNOWN_FINDINGS`.

```
node tools/simulator/run.mjs --workspaces 4 --members 4 --ticks 400 --seed 11 \
  --oracle-every 25 --epoch 2026-06-07 --headless        # workspace 0, tick 25
```

One trip, 90 km, two participants; one fill of 221,43 kr. Each participant's `tripCost` was
`45 × (221,43 / 90)` — exactly **110,715 kr**, a true half-øre tie. The two engines landed
on opposite sides of it:

| | computation | result |
|---|---|---|
| Postgres | `221.43/90.0` → `2.4603333333333333` (numeric division truncates the repeating decimal to 16 fractional digits), `× 45.0` = `110.7149999999999985` | **110,71 kr** |
| Client | `221.43/90` → `2.4603333333333332611` (double), `× 45` = `110.71500000000000341`, `× 100` = `11071.5` exactly | **110,72 kr** |

Both round half away from zero. They simply disagreed about which side of the half the
product was on, and the divide-then-multiply order is what put it there. Sofie's phone said
she was owed 110,71 kr; the server-derived settlement request said 110,72 kr.

Bounded, and that is why nobody had seen it: the close's integrity gate allows 0,02 kr per
member, so no close could be blocked by it, and the period still netted to zero on both
sides. Systematic, though — an exact tie is what a group splitting one fill evenly between
two or three drivers produces all the time — so it recurred rather than drifted.

**Fixed by migration 196 (GV-477):** `round(pm.km * (t.total_paid / t.total_km), 2)` divides
first and loses the tie; `round(pm.km * t.total_paid / t.total_km, 2)` keeps full numeric
precision through the multiply — `221.43 * 45.0 / 90.0` is exactly `110.715`, which rounds
to `110,72` and agrees with the client. Both occurrences moved together (the printed
`tripCost` and the copy `net` recomputes inline), `fuelRate` was deliberately left alone,
and the mobile client is unchanged: the fix moves the server toward the client, not the
other way. It does not make the two engines provably identical — the client is still a
double — but it removes the systematic half-øre case. Pinned by
`tools/test-zero-km-fuel-carryforward-contract.mjs`, whose calc half now reads migration
196 because that is where the live definition lives.

The historical repro, kept for posterity: on the **pre-196** schema the seed-11 command
above hit it at workspace 0, tick 25, and the Phase B default mix
`--workspaces 4 --members 4 --ticks 400 --seed 42 --oracle-every 25 --epoch 2026-05-26 --sessions 2`
hit it once at workspace 2, tick 50 (`tripCost` 642,53 client vs 642,52 server, with that
member's `net` one øre the other way). Both are clean now, and the seed-42 run going from
*one known finding* to *none* is what verified the migration.

Its `KNOWN_FINDINGS` match was narrow in three independent ways — only `client_parity`, only
`person.tripCost` / `person.net`, only a difference of one øre, and only when the mismatch
list was not truncated — which is the shape any future entry should copy.

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

## Behavioural realism (Phase B)

Phase A produced *correct* traffic: real RPCs, real personas, real invariants. It did not
produce *plausible* traffic. The clock ticked a uniform one to six hours, so Tuesday at
07:40 and Sunday at 03:00 were the same workspace; every write arrived in the order it was
decided, from one connection, exactly once. Three whole classes of production bug live
outside that model, and GV-478 is four features that put them inside it.

All four are **on by default**, each has an off switch, and the four together restore
Phase A's *shape* for an A/B. They do not restore Phase A's digests — migration 195 also
moved the fat finger into the default mix, and a weight is a weight.

| Flag | Turns off |
|---|---|
| `--flat-clock` | the day/week rhythm: back to a uniform 1–6 h tick and unmodulated persona weights |
| `--no-offline` | the sixth persona and its queue |
| `--no-dup` | the duplicate send |
| `--no-interleave` | the contention scenarios |
| `--sessions N` | how many psql sessions to hold (default 2; `1` turns interleaving off, since one session cannot contend with itself) |

### 1. Day and week rhythm

`lib/rhythm.mjs`, two halves.

**When a tick happens.** `RhythmClock` advances by rejection sampling against an
hour-of-week intensity curve: draw a step of 20–150 minutes, and keep stepping (30–120
more) while the hour it lands in is quiet. Nights are crossed in a few large strides (the
curve is ~0,02 there, so nearly every draw rejects), peaks are entered and lingered in
(~0,95, so the first draw nearly always accepts). Measured over 60 000 ticks: **34 % of
actions land in the four peak hours** against 17 % for a uniform walk, and **1 % in
01–04** against 17 %. The occasional 2 a.m. action survives, because it should — somebody
does log yesterday's trip from bed.

The mean advance is tuned to **3,7 h**, right next to Phase A's 3,5 h, so a rhythm run
covers about the same number of calendar days as the flat run it replaces. The clustering
comes from the rejection, not from the step size. The clock also **clamps** at a span
budget (`ticks × 3,7 h × 1,15 + one day`) and the epoch is chosen from the same number, so
the run provably finishes before the real present no matter how a seed drifts — see
[the epoch section](#the-epoch-and-the-one-thing-determinism-costs) for why that matters.

**What the actor does at that moment.** `modulateWeights` multiplies the persona's own
weights by a table of eight rules — `commute`, `evening`, `end_of_day`, `night`,
`weekend`, `month_edge`, `mid_month`, `thirsty`. Every rule carries a `why` in the source.
Three are worth naming here:

- **`month_edge` and `mid_month` are a pair.** Boosting settlement work in the last and
  first three days of the simulated month means nothing unless the middle of the month is
  damped; otherwise a "boosted" edge is just a louder constant.
- **`thirsty` is not a clock rule at all.** It reads `ws.kmSinceFuel`, which trips
  accumulate and a fill resets, so a tankning follows the driving rather than a die roll.
- **There is no "quiet hours" multiplier**, and there cannot be one: scaling every weight
  equally is a no-op, because `weighted()` normalises. Quiet hours are modelled by the
  clock skipping them. Night instead *shifts the mix* — backdated logging and chat go up,
  trips and handovers go down, which is what a 2 a.m. action actually is.

A modulated weight is floored at 0,05 rather than allowed to reach zero. A rule is a bias,
not a ban, and an action that can never be drawn at 03:00 is an action whose 03:00 bugs
are unreachable.

Every action line now carries `simClock` ("tir 16:28"), `simPhase` and the list of rules
that fired, so the journal and the dashboard show the rhythm rather than asserting it.

### 2. Offline-pendleren

A sixth persona who drives the same commute and spends part of it underground. The app
keeps working — that is what offline-first means — so they keep logging, and the writes
sit in a local queue until the phone reconnects and sends the lot.

What makes it worth simulating is not the queue but **what the queue does to time**:

- the statement carries the **simulated timestamps of the moment it was decided**, so it
  arrives backdated relative to everything the workspace wrote in between;
- the whole burst lands **inside one tick**, out of order relative to the rest of the
  workspace, one journal line per flushed statement so the digest covers all of it;
- an **edit carries the row version the phone could see when it was decided**. Actions
  built for an offline actor read `updated_at` at decision time (`ctx.readUpdatedAt`) and
  put it in `expected_updated_at`, so if anybody touched that row in the meantime,
  migration 160's GV-421 guard refuses the late write instead of silently overwriting it.
  That is the entire point, and it is why the persona's edit weights are higher than a
  plain commuter's: an edit is the only action that carries a token.

**The offline stretch is counted in the member's own picks, not in ticks**, and the first
version got that wrong in a way worth recording. A member of a four-workspace, four-member
run is the actor about once every sixteen ticks, so a window of "3 to 9 ticks" expired
before they were next picked: the persona went offline, queued nothing, and reconnected to
an empty queue. Every burst was one statement long and the feature was decorative. Counted
in picks, a burst is 2–6 decisions by construction.

A real burst from
`--workspaces 4 --members 4 --ticks 400 --seed 478 --epoch 2026-05-26`:

```
 34 queued log_fuel                                    98 queued log_trip
 68 queued edit_trip        tok                       127 queued edit_fuel        tok
 84 queued edit_trip        tok
132 flush  log_fuel    guard not_found    waited 98   <- "Open settlement period was not
132 flush  edit_trip   guard not_found    waited 64       found or was already closed"
132 flush  edit_trip   guard not_found    waited 48
132 flush  log_trip    guard not_found    waited 34
132 flush  edit_fuel   guard permission   waited 5
```

Five writes decided between tick 34 and tick 127, sent in one burst at tick 132, and four
of them refused because **the admin closed the period while the phone was in a tunnel**:
each carried the `target_open_period_id` it could see when it was decided, and that period
no longer exists. The fifth was refused because the row's payer had changed underneath it.
Nothing else in this repo writes that sequence, and the guard messages are the product's
own.

A phone that never comes back into range before the run ends keeps its queue; the run
prints a note saying how many statements never made it, because an unflushed queue is a
silently missing chunk of a workspace's history.

### 3. Duplicate and retry chaos

Roughly **1 action in 12** is sent a second time, immediately, byte-identically — the
double-tap, and the retry of a request whose response never arrived. The decision comes
from the PRNG at action-draw time and is in the digest.

The second send is judged against an **expected-duplicate catalogue** in `lib/actions.mjs`,
next to the expected-rejection catalogue and built the same way: every entry was read out
of `supabase-schema.sql`.

| Expectation | Meaning | Actions |
|---|---|---|
| `idempotent` | the schema guarantees no second row. **Verified, not trusted**: a probe counts the rows after the first send and after the duplicate, and any increase is a `duplicate_hazard` finding that fails the run | trips, fuel, bookings, handovers, booking completion, settlement transitions, period close, recurring generation |
| `tolerated` | a plain INSERT with no idempotency key, so a second send legitimately creates a second row **today**. Real double-tap exposure, journalled as `dup-tolerated` — a note, never a finding, never counted as a guard | one-off expenses, repairs, new recurring templates, chat messages |

An action **absent** from the catalogue is never duplicated: duplicating an action whose
expectation nobody has worked out produces a result nobody can interpret.

The three mechanisms the idempotent half rests on:

- `trips` / `fuel_payments` / `car_bookings` carry a UNIQUE `(ledger_id, legacy_id)` and
  the upsert RPCs resolve with `on conflict … do update`, behind a per-legacy-id
  `pg_advisory_xact_lock(hashtext(ledger || ':trip:' || legacy_id))`;
- `booking_handovers.booking_id` is UNIQUE — migration GVM-529 says outright that "a
  second save EDITS the handover rather than stacking a duplicate";
- `upsert_settlement_request_status` looks the pair's row up `for update` and UPDATEs it,
  inserting only when there is none (the GVM-241 shape), and
  `generate_due_recurring_expenses` inserts `on conflict (recurring_expense_id,
  occurrence_date) do nothing` under `workspace_expenses_recurrence_uq`.

Two deliberate choices:

- **The probe runs after the first send and after the duplicate**, not before and after
  the pair. The question is "did the *second* send create a row", and a successful first
  close legitimately changes the count.
- **The duplicate's `apply` is never run.** For an idempotent action there is nothing new
  to record; for a tolerated one the second row is left *untracked by the harness on
  purpose*, which is exactly what a double-tap leaves behind in production. The oracle
  reads the database, not the harness's model.

Not covered, and named so the gap is not mistaken for a claim: `redeem_ledger_invite` runs
only during seeding, before the tick loop exists.

### 4. Parallel sessions and lockstep contention

`lib/db.mjs` now holds **N sessions** (`--sessions`, default 2) against the same
container, each with its own `set_config` auth context, so two different members really do
act as two different `authenticated` users. `lib/interleave.mjs` uses the second one.

**Why lockstep and not a real race.** A race is scheduled by the operating system, so it
is not reproducible, so a finding could not be handed back as a repro command — and
determinism is this tool's product. Roughly 1 tick in 12 becomes a scenario instead of an
action, and the scenario steps the sessions one statement at a time in a PRNG-chosen
order:

1. the **holder** opens a transaction on a secondary session and runs one real RPC. Its
   locks are held, because the transaction is deliberately left open;
2. the **contender** runs a conflicting real RPC on the primary session;
3. the holder **commits or rolls back** — PRNG-drawn, because the two leave the workspace
   in different states and a fuzzer should visit both;
4. the contender's outcome is read against the scenario's expectation.

**`SET LOCAL lock_timeout` is the design, not a detail.** Step 2 blocks — that is the
point — and a single-threaded driver that waits for it has deadlocked itself, because only
the driver can send the holder's commit. `lock_timeout = 400 ms` on the contender turns the
block into an *answer*: SQLSTATE **55P03**, caught by `sim_exec` like any other exception
and returned as data. It applies to advisory locks as well as row locks, which matters
because these RPCs serialise themselves with `pg_advisory_xact_lock` far more often than
with row locks. 400 ms is chosen so a merely slow statement on a loaded CI machine still
finishes (these RPCs run in single-digit milliseconds) while thirty scenarios cost about
twelve seconds. The holder gets a 4 s timeout too — it should never fire, and exists only
so a harness bug cannot become a run that hangs until CI kills it.

55P03 gets its own outcome class, `contention`, because it is neither a guard (nothing was
refused on the merits) nor an error (nothing is wrong): it is the database proving it
serialises the two writers.

| Scenario | Holder | Contender | The lock the schema names |
|---|---|---|---|
| `same_trip_edit` | the driver edits their trip | an admin edits the same trip | `upsert_trip_with_participants`' `hashtext(ledger \|\| ':trip:' \|\| legacy_id)` |
| `fuel_during_close` | a member logs a fill | the admin runs the **real** period close | `close_settlement_period`'s `for update of sp` against the writers' `for share of sp` |
| `settlement_pair_race` | the admin re-requests a pair | the payer marks the same pair paid | `hashtext(ledger \|\| ':settlement:' \|\| period_id)` |
| `handover_race` | the booking's member saves a handover | an admin saves the same handover | `hashtext(ledger \|\| ':handover:' \|\| booking_id)` |
| `double_completion` | the booking's member completes it | an admin completes the same booking | the `car_bookings` row itself — `for update of cb`, taken one step early by migration 197's GV-479 pre-check |

Every scenario is built out of the **same** RPC calls the tick loop uses (`tripWrite`,
`fuelWrite`, `bookingCompletionWrite`, the close program) rather than a hand-written copy,
which would stop testing the real call the moment either drifted.

`fuel_during_close` has the roles the "wrong" way round on purpose. The close takes the
exclusive lock, so it has to be the *contender*: a close held open as the holder would
usually fail its own precondition first, release everything at the subtransaction abort,
and leave the scenario testing nothing. A fuel write almost always succeeds, so as the
holder it reliably parks a `for share` on the period row — and the close then blocks at
the very first thing it does, which is what migration 141's wrapper promises ("writers
already take FOR SHARE on this row; writers that start later block here until the close
commits"). It runs the **real** close, snapshot and all, because a stub close would be
refused on its own malformed snapshot in the hazard case, and a hazard that reports as
`guard` is a hazard nobody sees.

**What counts as a finding** is narrow, and its first clause does most of the work:

| Contender | Verdict |
|---|---|
| holder's statement failed | **judge nothing.** No lock was held (a failed statement inside `sim_exec` rolls back to its subtransaction and releases what it took), so the contender met no contention and its outcome says nothing |
| `contention` | expected — the lock did its job |
| `guard` | expected — refused on the merits *before* it reached the lock; every one of those gates sits ahead of the lock in these functions |
| `ok` | **`interleave_hazard`.** Two writers got through the same named lock at once, which is precisely what the lock is in the schema to prevent |
| `error` | already a violation by the ordinary path |

That first clause is not a loophole, it is the honest reading, and it fires. In a 400-tick
seed-478 run, **four of thirty** scenarios had their holder refused by the fuel payer gate
("Only the fuel payer or a ledger admin can create this fuel payment" — `fuelWrite` names
somebody else as payer one time in five), so no `for share` was ever taken, the contender's
close succeeded legitimately, and nothing was reported. Of the remaining twenty-six,
**nineteen ended in `contention`** and seven in a `guard`. Making the holder always pay for
their own fill would raise the engagement rate; it is left alone because a scenario skipped
for a stated reason costs less than one more special case in the builders.

`double_completion` is the collision this README used to list as the one deliberately left
out. With the same idempotency key it is identical to the duplicate catalogue's
`complete_booking` entry minus a session; with two *different* keys the expected outcome
was genuinely unsettled — nothing in the schema said which trip should win, and a scenario
whose expectation nobody has decided produces noise rather than findings. **Migration 197
(GV-479) settled it**, so the scenario exists now, and it draws its two keys the only way
that makes it a second *completion* rather than a retry: one `bookingCompletionWrite` call
each, each with its own key from `nextId`. Two outcomes are expected and the shared
judgement accepts both — `contention` when the booking had no trip yet (the holder takes
the `car_bookings` row and the contender queues on it), and `guard` when the booking was
already completed in an earlier tick, in which case the GV-479 pre-check refuses *both*
sessions with the same Danish sentence, the holder's statement fails, and the first clause
of the verdict table correctly abstains. `ok` is the hazard, as everywhere else: a second
completion that succeeds while the first is still in flight is exactly the silent overwrite
GV-479 exists to end.

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

The run header shows the simulated **weekday and clock** ("tir 16:28"), not just the date,
because a Tuesday at 07:40 and a Sunday at 23:10 are different workspaces; and a
`Sessioner N` chip, since two sessions is what makes a `låsekonflikt` possible at all. The
three Phase B outcome classes appear in the ticker as muted badges told apart by their
border — `låsekonflikt` solid, `dublet` dotted, `i kø` dashed. None of them is money, so
none of them is amber; none of them is a failure, so none of them is the error red.

Panels: run header with seed, configuration, simulated clock and tick progress; a workspace
grid with per-member phone panels; a scrolling action ticker where guards are visually
distinct from errors; an invariant wall (one cell per invariant × workspace, click for the
detail JSON); an RPC latency/count table with inline SVG sparklines; and a violations panel
showing the exact repro command.

The dashboard follows the branding rules: amber `#F4A261` for money amounts only, blue
`#355d9c` only for the "Anmodet" settlement chip, Courier New for odometers, fuel and
latencies, Danish number formatting and labels throughout, sentence case, no emoji, inline
SVG icons.

### Phase C (GV-480): the palette, the phones and the scrubber

**Green is a signal now, not the room.** Phases A and B painted every surface with
`color-mix(--color-mist into --color-deep-forest)`. That was provably on-palette and it was
the wrong call: mixing one brand green into another for *every* panel put a green cast over
the whole page — the user's word for it was an overlay — and it spent the one colour the
page most needs to keep meaningful. A green cell on the invariant wall says "this invariant
held", and it cannot say that on a green field. The surfaces are now a neutral, very
slightly warm graphite ramp, and green appears in exactly five places, all of which mean
something: the live/ok pills, a passing invariant cell, an "is owed" amount, the `ok` badge,
and the latency sparkline. Amber, blue and error are untouched. The canonical palette
already sanctions the move — `--color-disabled-*` is documented there as "neutral grey,
deliberately NOT brand-green", for the same reason. The ramp is cockpit furniture and is
deliberately **not** proposed as a token: nothing ships it and no product renders it. The
contrast figures per surface are in the comment block at the top of `dashboard.html`; the
one that actually changed a decision is `--color-attention`, which was **below AA** on deep
forest (3.7:1) and clears it on the new panel (4.5:1) — which is why the `værn` pill and
badge no longer carry a raised fill.

**Per-member phones.** Every workspace card holds a collapsible shelf of small
phone-shaped panels, one per member, showing what that member's app would show right now:
their name and persona (the admin marked with a discreet `adm`), their balance with the
GVM-74 direction — owes in amber, is owed in leaf, `I er kvit` at zero — the period they
are in, their own last three actions with the ticker's own outcome badges, and, for the
Offline-pendleren, `offline · N i kø` while the queue is filling and `offline-burst · N
sendt` for the two ticks after it empties. The shelf is collapsible per workspace, and the
grid puts two phones on a row whether four workspaces share the page or eight; below that
it wraps and the page scrolls rather than squashing a phone narrower than a legible
`1.184,11 kr`.

Where the numbers come from matters, because a dashboard that reads the database is a
dashboard that changes the run. They come from **`workspaceViews()` in `run.mjs`**: one
shape with two readers — `/state`, which the page polls while it is following live, and a
new `state` journal line the **oracle sweep** writes, which is what a replay and the
scrubber read. Every value in it is already in the harness's model or in `ws.balances`,
which the `zero_sum` invariant piggybacks onto a sweep that was happening anyway, so the
phones cost the run **no extra query, no PRNG draw and no statement**. `digestOf()` hashes
`kind === "action"` lines only, so the determinism digest cannot see any of this — Phase C
does not move it, and the digest of a given seed is character-identical to Phase B's.
Balances therefore step at each sweep (`--oracle-every`), which is honest: that is when they
were measured. A member's own action list and queue depth update every tick, because both
are derived from the `action` lines the journal already carried — the queue depth is simply
`offline: "queued"` minus `offline: "flush"` up to that tick.

**The journal scrubber.** A slider spanning tick 0 → the latest tick sits under the run
header, with ◀ ▶ single-step buttons; `←`/`→` step and `End` jumps back to live (no other
keys — a dashboard that swallows keystrokes is one you cannot use find-in-page on). Drag it
back and the ticker, the phones, the workspace grid, the invariant wall, the violations and
every counter re-render **as they were at that tick**, with a `Du ser tick T · Hop til nu`
chip to come back; the live stream keeps accumulating behind the pinned view, and dragging
to the right edge resumes live-follow on its own. The one panel that does not rewind is the
RPC latency table — it is a running aggregate over the whole run rather than a per-tick
series, and it says so in the panel heading while you are scrubbed.

All of it is client-side and possible only because of the `/events` design: the stream
replays **from line 1**, so the browser already holds every line of the run. State at tick T
is **recomputed** from that array on demand rather than checkpointed — a full pass over a
2.000-tick run is a few thousand integer increments, cheaper than the paint it feeds, and
checkpoints would have bought nothing while introducing the one bug a scrubber must not
have: a view at T that depends on which ticks you visited on the way there. Because the page
derives everything from the journal, the scrubber works identically on a run that ended an
hour ago: open the dashboard, let it replay, drag.

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

`npm run test:simulator` is the short self-test, six 60-tick runs of one fixed seed.

**The seed is chosen, not arbitrary, and it has been chosen twice.** GV-478 moved it from
4711 to 101: at 4711 neither workspace draws the Offline-pendleren, and a self-test that
never exercises the offline queue would let that whole feature rot. GV-479 moved it again,
to **1717**, for the same kind of reason — adding the fifth contention scenario changes the
weighted draw inside `buildScenario` and with it the whole downstream PRNG stream, so at
101 the offline burst stopped flushing and `double_completion` was never drawn at all. 1717
was picked by replaying nineteen candidates against every assertion in the self-test: it
queues offline writes and flushes them backdated, draws `double_completion` with its
contender refused by migration 197's own guard (so the new rule is executed, not merely
listed), and still produces duplicates, a period close, a fat finger refused by migration
195 and thirteen guards inside 60 ticks — in the default shape *and* in Phase A's, which is
the clause that eliminates most candidates, since Phase A asserts exactly one action line
per tick and an offline burst adds one per flushed statement. Re-run that search whenever a
change to the action pool, the persona pool or the scenario list moves the stream again: a
seed is cheaper to re-pick than an assertion is to weaken. The `--epoch` is pinned for the same class of
reason: the rhythm keys off the simulated weekday.

1. **clean** — must finish, must produce guards, must report no new violation. Note that
   "one action line per tick" stopped being true in Phase B (a duplicate is its own line,
   a scenario is three, a burst is one per flushed statement); what is asserted is that
   every tick produced at least one, which is what keeps a tick number in a violation
   report meaningful;
2. **client parity** — read off the clean run's journal. With `../govehlo-mobile` present:
   the mobile modules imported, at least one period was actually compared (a parity check
   over zero periods is vacuously green, which is the one way this could pass while proving
   nothing), and no new parity violation. Absent: every cell marked skipped, and the run
   still green;
3. **determinism** — the same seed with `--no-parity` must produce the byte-identical
   action digest. Parity is oracle-side and draws no PRNG, and every `repro:` line in this
   repo depends on that staying true;
4. **the four Phase B features actually fired** — read off the clean run's journal, no
   extra container. A flag that is on and never fires is a feature nobody is testing, so
   this half asserts that every line carries a weekday and clock and that several phases
   of the day were visited; that at least one write was queued offline, flushed in a
   burst, and had genuinely waited; that at least one duplicate was sent, carried its
   expectation, and created no unguarded second row; that at least one contention scenario
   ran, used a second session, and had its contender serialised by the lock — including
   `double_completion` by name, pinned so migration 197's guard cannot be left uncovered by
   a stream that stopped drawing it, with `contention` and `guard` both accepted as its
   contender's outcome; and that every fat-finger odometer was refused, at least one of
   them by migration 195's plausibility guard;
5. **determinism with everything on** — the identical command, twice. The `--no-parity`
   half above proves parity draws no PRNG; this proves the thing two sessions put at risk,
   because an OS-scheduled race would land here as a flake. It is what says the lockstep
   really is lockstep;
6. **Phase A's shape is still reachable** — `--flat-clock --no-dup --no-interleave
   --sessions 1` must run clean, produce exactly 60 action lines, use one session, and
   apply no rhythm. It is what an A/B uses, and what a bisect falls back to when a Phase B
   feature is the suspect;
7. **`--chaos`** and, when the sibling is present, **`--chaos-parity`** — each must report
   exactly one new violation, and it must be the injected one.

It warns and exits 0 without Docker, like every other Docker-backed guard here, and fails
under `--strict`.

---

## Files

| File | Role |
|---|---|
| `run.mjs` | CLI, container boot, seeding, tick loop, reporting, reviewed findings |
| `lib/prng.mjs` | seeded PRNG and the flat simulated clock |
| `lib/rhythm.mjs` | Phase B: the hour-of-week clock and the weight rules |
| `lib/personas.mjs` | six personas and their action weights |
| `lib/actions.mjs` | the action catalogue, the expected-rejection catalogue and the expected-duplicate catalogue |
| `lib/interleave.mjs` | Phase B: the lockstep contention scenarios |
| `lib/oracle.mjs` | the seven invariants |
| `lib/client-parity.mjs` | Phase A: imports govehlo-mobile's calculation modules, reads the rows its gateway would read, and diffs |
| `lib/journal.mjs` | the append-only JSONL stream and the determinism digest |
| `lib/db.mjs` | the persistent `psql` sessions (a pool since Phase B), SQL literal helpers, `sim_exec` |
| `lib/server.mjs` | the `--serve` web server |
| `dashboard.html` | mission control, single file, zero external requests |

`lib/db.mjs` is the one module the GV-471 brief did not name. It exists because the
simulator's shape is the opposite of every other Docker guard's: hundreds of tiny
statements whose individual outcome and latency are the product, rather than a handful of
large ones. One `docker exec psql` per action would cost ~50–100 ms of process overhead
against a ~1 ms RPC, so the session is held open for the whole run and spoken to over a
line protocol. Keeping that in `run.mjs` would have doubled its length for no gain.
