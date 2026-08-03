// Anti-drift contract for the incident damage kind + repair link (GVM-521, migration 166).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// The repair link is the first foreign key in this schema that a client supplies and
// that a plain FK CANNOT validate. vehicle_repairs.id is unique across every
// workspace, so `references public.vehicle_repairs(id)` is satisfied just as happily
// by another group's repair as by your own. The only thing standing between an
// incident and a stranger's repair costs is one `and vr.ledger_id = ...` inside
// set_incident_repair — a line that can be deleted without the migration looking
// wrong, without the FK complaining, and without a single existing test going red.
//
// The mutations this file exists to kill, each of which leaves the migration looking
// correct:
//
//   • the same-ledger clause going missing, so an incident can point at another
//     workspace's repair and read its cost, workshop and date out of the join — a
//     data-protection incident, not a bug;
//   • the deleted_at clause going missing, so a link can be made to a repair the
//     workspace has already retracted;
//   • the admin-or-reporter gate widening, so any member can re-attribute someone
//     else's damage report to a repair;
//   • null losing its UNLINK meaning (e.g. rewritten as coalesce(p_repair_id,
//     vi.repair_id) to match update_vehicle_incident's patch semantics), which would
//     make a mis-linked repair permanent;
//   • damage_kind's default flipping to 'existing_damage', which would silently
//     assert that every dent a member logs was already on the car;
//   • the CHECK widening past the two values, or the column becoming nullable, so
//     "we don't know" creeps back in as a third state the UI has to handle;
//   • a write grant appearing on public.vehicle_incidents, which would route around
//     set_incident_repair — and therefore around the ledger check — entirely. That
//     grant is what makes RPC-only enforcement sound instead of merely conventional,
//     so it is asserted here rather than assumed.
//
// Shape is asserted against the CATALOG of a replayed database — pg_attribute,
// pg_constraint, pg_get_constraintdef, has_table_privilege, has_function_privilege —
// rather than against the SQL text. A regex can be satisfied by a line that never
// runs; a catalog query cannot.
//
// ── Why not the role matrix ─────────────────────────────────────────────────────
// set_incident_repair has no client caller until govehlo-mobile's GVM-521 half
// lands. tools/test-rls-role-matrix.mjs would therefore report it under the GV-379
// coverage check and demand a reviewed allow-list entry — for a function that is
// expected to get a real caller within weeks. That is precisely the rubber-stamp
// entry role-matrix-coverage-allowlist.mjs warns against, so the RPC is pinned here
// instead, and the role matrix covers only the damage-kind half, which rides on
// log_vehicle_incident / update_vehicle_incident — RPCs both clients already call.
//
// ── Docker ──────────────────────────────────────────────────────────────────────
// Real enforcement needs a real Postgres, so this replays supabase-schema.sql into a
// disposable container. Docker-free machines get a loud warning and a pass — the same
// contract test-booking-handover-contract.mjs uses — so `npm run validate` stays
// dependency-free. CI runs it with --strict, where a skip is a failure.
//
//   node tools/test-incident-repair-link-contract.mjs            # warn when Docker is absent
//   node tools/test-incident-repair-link-contract.mjs --strict   # CI: unchecked = failure

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const CONTAINER = `govehlo-incident-repair-${process.pid}`;
const DB = "incidentrepair";

let checked = 0;

// A failed assertion must not leave a Postgres container running on a dev machine —
// the next run would then collide on nothing but still cost a rebuild to notice.
process.on("uncaughtException", (error) => {
  removeContainer(CONTAINER);
  process.stderr.write(`\n❌ incident repair-link contract: ${error.stack || error.message}\n`);
  process.exit(1);
});

function pin(label, fn) {
  fn();
  checked += 1;
  process.stdout.write(`  ok - ${label}\n`);
}

let dockerUp = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
  dockerUp = true;
} catch {
  dockerUp = false;
}

if (!dockerUp) {
  const message =
    "incident repair-link contract: Docker is unavailable, so the SQL was NOT executed. " +
    "Migration 166's same-ledger repair rule, its unlink semantics and damage_kind's shape are unverified on this run.";
  if (strict) {
    process.stderr.write(`\n❌ ${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n⚠️  ${message}\n`);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`\n❌ incident repair-link contract: ${message}\n`);
  removeContainer(CONTAINER);
  process.exit(1);
}

try {
  startPostgres(CONTAINER, ROOT);
  createDbWithPrelude(CONTAINER, DB);
} catch (error) {
  fail(error.message);
}

const applied = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
if (applied.status !== 0) fail(`Consolidated schema failed to apply:\n${applied.stderr}`);

// ── Fixtures ───────────────────────────────────────────────────────────────────
// Two workspaces, because the headline property is a CROSS-workspace one and a
// single-workspace fixture cannot express it.
//
//   ws 'inc'      Anna (admin), Bo (member — reports the incidents), Cille (bystander)
//                 repairs: R1 (live), R3 (soft-deleted)
//   ws 'inc-two'  Erik (admin) — a real, active, signed-in member of a DIFFERENT group
//                 repairs: R2 (live, and the one that must stay unreachable from 'inc')
//
// Repairs are inserted directly rather than through insert_repair: this suite is about
// the link, and routing the fixture through the repair RPC would drag in migration
// 114's advisory lock and period stamping and give a failure there a misleading name.
const M = (n) => `10000000-0000-0000-0000-00000000000${n}`;
const ANNA = M(1);
const BO = M(2);
const CILLE = M(3);
const ERIK = M(4);
const L = "inc";
const L2 = "inc-two";

const R1 = "20000000-0000-0000-0000-000000000001";
const R2 = "20000000-0000-0000-0000-000000000002";
const R3 = "20000000-0000-0000-0000-000000000003";
const GHOST = "20000000-0000-0000-0000-0000000000ff";

const seed = `
insert into public.ledgers (id, name, slug) values
  ('${L}', 'Incident test', '${L}'),
  ('${L2}', 'Other group', '${L2}');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${ANNA}',  '${L}',  'Anna',  'anna@test.dk',  'admin',  true),
  ('${BO}',    '${L}',  'Bo',    'bo@test.dk',    'member', true),
  ('${CILLE}', '${L}',  'Cille', 'cille@test.dk', 'member', true),
  ('${ERIK}',  '${L2}', 'Erik',  'erik@test.dk',  'admin',  true);

-- Both workspaces need an OPEN settlement period: enforce_settlement_entry_period_boundary
-- refuses a repair that would land outside one, so a fixture without periods fails in the
-- accounting engine rather than in anything this suite is about.
insert into public.settlement_periods (id, ledger_id, status, label, opened_at) values
  ('50000000-0000-0000-0000-000000000001', '${L}',  'open', 'Aaben', now() - interval '60 days'),
  ('50000000-0000-0000-0000-000000000002', '${L2}', 'open', 'Aaben', now() - interval '60 days');

insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id, deleted_at) values
  ('${R1}', '${L}',  current_date, 'Ny kofanger',      4200.00, '${ANNA}', null),
  ('${R2}', '${L2}', current_date, 'Andres reparation', 9900.00, '${ERIK}', null),
  ('${R3}', '${L}',  current_date, 'Fortrudt',          100.00, '${ANNA}', now());
`;
const seeded = psql(CONTAINER, DB, ["-c", seed]);
if (seeded.status !== 0) fail(`Seeding ledgers/members/repairs failed:\n${seeded.stderr}`);

function raw(sql, args = []) {
  const res = psql(CONTAINER, DB, [...args, "-c", sql]);
  if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
  return res.stdout.trim();
}

const scalar = (sql) => raw(sql, ["-t", "-A"]);

/** Run `sql` as `email` and return the SQLSTATE it raises, or 'OK' when it succeeds. */
function sqlstateOf(email, sql) {
  const wrapped = `
do $$
begin
  ${sql}
  raise notice 'GVSTATE:OK';
exception when others then
  raise notice 'GVSTATE:%', sqlstate;
end $$;`;
  const res = psql(CONTAINER, DB, [
    "-c",
    `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${wrapped}`,
  ]);
  if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${wrapped}`);
  const match = `${res.stdout}\n${res.stderr}`.match(/GVSTATE:(\S+)/);
  if (!match) fail(`Could not read a SQLSTATE back from:\n${wrapped}`);
  return match[1];
}

const sqlLit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);

/** Log an incident as `email`, returning its id. Reporter is resolved from the JWT. */
function logIncident({ actor = "bo@test.dk", ledger = L, title = "Bulet doer", damageKind = "new_incident" } = {}) {
  const state = sqlstateOf(
    actor,
    `perform public.log_vehicle_incident(${sqlLit(ledger)}, current_date, ${sqlLit(title)}, 'Parkeringsskade',
       null, null, null, null, 'open', null, ${sqlLit(damageKind)}, null, null);`,
  );
  if (state !== "OK") fail(`fixture: logging incident "${title}" as ${actor} raised ${state}`);
  return scalar(
    `select id from public.vehicle_incidents where ledger_id = ${sqlLit(ledger)} and title = ${sqlLit(title)}
       order by created_at desc, id desc limit 1;`,
  );
}

const setRepair = (actor, incidentId, repairId, event = null) =>
  sqlstateOf(
    actor,
    `perform public.set_incident_repair('${incidentId}'::uuid, ${repairId === null ? "null" : `'${repairId}'::uuid`},
       ${sqlLit(event)}, ${event === null ? "null" : sqlLit("body")});`,
  );

const linkOf = (incidentId) =>
  scalar(`select coalesce(repair_id::text, 'NULL') from public.vehicle_incidents where id = '${incidentId}';`);

const columnOf = (incidentId, column) =>
  scalar(`select coalesce(${column}::text, 'NULL') from public.vehicle_incidents where id = '${incidentId}';`);

process.stdout.write("\nIncident damage kind + repair link (real Postgres, consolidated schema):\n");

// ═══════════════════════════════════════════════════════════════════════════════
// 1. SHAPE — asserted against the catalog, not the SQL text
// ═══════════════════════════════════════════════════════════════════════════════

pin("damage_kind is NOT NULL and defaults to 'new_incident'", () => {
  const row = scalar(
    `select (case when a.attnotnull then 'notnull' else 'nullable' end)
            || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), 'NO DEFAULT')
       from pg_attribute a
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.vehicle_incidents'::regclass and a.attname = 'damage_kind';`,
  );
  assert.match(row, /^notnull\|/, "a nullable damage_kind reintroduces 'we don't know' as a third state");
  assert.match(
    row,
    /'new_incident'/,
    "the backlog and every default-taking client must classify as a new incident, not as pre-existing damage",
  );
});

pin("the CHECK admits exactly 'existing_damage' and 'new_incident'", () => {
  const def = scalar(
    `select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.vehicle_incidents'::regclass and conname = 'vehicle_incidents_damage_kind_check';`,
  );
  assert.ok(def, "the named CHECK must exist — the RPC validation alone is not the schema's guarantee");
  assert.match(def, /existing_damage/);
  assert.match(def, /new_incident/);
  // A third value would have to appear as a quoted literal in the constraint text.
  const literals = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(literals)], ["existing_damage", "new_incident"]);
});

pin("repair_id references vehicle_repairs with ON DELETE SET NULL", () => {
  const def = scalar(
    `select pg_get_constraintdef(c.oid) from pg_constraint c
      where c.conrelid = 'public.vehicle_incidents'::regclass and c.contype = 'f'
        and pg_get_constraintdef(c.oid) like '%vehicle_repairs%';`,
  );
  assert.match(def, /FOREIGN KEY \(repair_id\) REFERENCES vehicle_repairs\(id\)/i);
  assert.match(def, /ON DELETE SET NULL/i, "deleting a repair must never take the damage record with it");
});

pin("authenticated may SELECT vehicle_incidents but may NOT insert, update or delete it", () => {
  const grants = ["SELECT", "INSERT", "UPDATE", "DELETE"].map((p) =>
    scalar(`select has_table_privilege('authenticated', 'public.vehicle_incidents', '${p}');`),
  );
  assert.deepEqual(
    grants,
    ["t", "f", "f", "f"],
    "a write grant would route around set_incident_repair and its same-ledger check entirely",
  );
});

pin("authenticated may execute set_incident_repair; anon may not", () => {
  const sig = "public.set_incident_repair(uuid, uuid, text, text)";
  assert.equal(scalar(`select has_function_privilege('authenticated', '${sig}', 'EXECUTE');`), "t");
  assert.equal(scalar(`select has_function_privilege('anon', '${sig}', 'EXECUTE');`), "f");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. DAMAGE KIND — the distinction the log did not have
// ═══════════════════════════════════════════════════════════════════════════════

pin("a client that omits damage_kind_value gets 'new_incident'", () => {
  const state = sqlstateOf(
    "bo@test.dk",
    `perform public.log_vehicle_incident(target_ledger_id => '${L}', incident_date_value => current_date,
       title_value => 'Uden skadetype', description_value => 'Gammel klient');`,
  );
  assert.equal(state, "OK");
  const id = scalar(
    `select id from public.vehicle_incidents where ledger_id = '${L}' and title = 'Uden skadetype';`,
  );
  assert.equal(columnOf(id, "damage_kind"), "new_incident");
});

pin("existing damage and a new incident are distinguishable in the same workspace", () => {
  const older = logIncident({ title: "Var der i forvejen", damageKind: "existing_damage" });
  const fresh = logIncident({ title: "Skete i gaar", damageKind: "new_incident" });
  assert.equal(columnOf(older, "damage_kind"), "existing_damage");
  assert.equal(columnOf(fresh, "damage_kind"), "new_incident");
});

pin("a third damage kind is rejected (22023) and writes no row", () => {
  const before = scalar(`select count(*) from public.vehicle_incidents where ledger_id = '${L}';`);
  const state = sqlstateOf(
    "bo@test.dk",
    `perform public.log_vehicle_incident('${L}', current_date, 'Ugyldig', 'Ugyldig skadetype',
       null, null, null, null, 'open', null, 'ukendt', null, null);`,
  );
  assert.equal(state, "22023");
  assert.equal(scalar(`select count(*) from public.vehicle_incidents where ledger_id = '${L}';`), before);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. THE REPAIR LINK — the same-ledger rule a foreign key cannot express
// ═══════════════════════════════════════════════════════════════════════════════

const incident = logIncident({ title: "Skade til reparation" });

pin("the reporter can link a live repair from their OWN workspace", () => {
  assert.equal(setRepair("bo@test.dk", incident, R1), "OK");
  assert.equal(linkOf(incident), R1);
});

pin("linking does NOT move repair_status — no second copy of that state", () => {
  assert.equal(
    columnOf(incident, "repair_status"),
    "open",
    "deriving status from the link is the design; writing it here would overwrite the member's own judgement",
  );
});

pin("ANOTHER workspace's repair is rejected (22023) and the existing link is untouched", () => {
  const state = setRepair("bo@test.dk", incident, R2);
  assert.equal(state, "22023", "vehicle_repairs.id is globally unique — the FK alone accepts this");
  assert.equal(
    linkOf(incident),
    R1,
    "a rejected link must leave the row exactly as it was, not clear it on the way out",
  );
  assert.equal(
    scalar(`select count(*) from public.vehicle_incidents where repair_id = '${R2}';`),
    "0",
    "no incident anywhere may point at the other group's repair",
  );
});

pin("a SOFT-DELETED repair in the same workspace is rejected (22023)", () => {
  assert.equal(setRepair("bo@test.dk", incident, R3), "22023");
  assert.equal(linkOf(incident), R1);
});

pin("a repair id that does not exist at all is rejected (22023)", () => {
  assert.equal(setRepair("bo@test.dk", incident, GHOST), "22023");
  assert.equal(linkOf(incident), R1);
});

pin("null UNLINKS — a mis-linked repair is never permanent", () => {
  assert.equal(setRepair("bo@test.dk", incident, null), "OK");
  assert.equal(
    linkOf(incident),
    "NULL",
    "if null were read as 'leave unchanged' (update_vehicle_incident's patch semantics), the link could never be undone",
  );
});

pin("deleting the linked repair clears the link and keeps the incident", () => {
  assert.equal(setRepair("anna@test.dk", incident, R1), "OK");
  raw(`delete from public.vehicle_repairs where id = '${R1}';`);
  assert.equal(linkOf(incident), "NULL");
  assert.equal(
    scalar(`select count(*) from public.vehicle_incidents where id = '${incident}';`),
    "1",
    "the damage record must outlive the repair row",
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. WHO MAY LINK — the GV-253 gate, restated per role
// ═══════════════════════════════════════════════════════════════════════════════

const R4 = "20000000-0000-0000-0000-000000000004";
raw(`insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id)
     values ('${R4}', '${L}', current_date, 'Lakering', 2500.00, '${ANNA}');`);

const bosIncident = logIncident({ title: "Bos skade" });

pin("a bystander member (not admin, not reporter) is denied 42501 and changes nothing", () => {
  assert.equal(setRepair("cille@test.dk", bosIncident, R4), "42501");
  assert.equal(linkOf(bosIncident), "NULL");
});

pin("a member of ANOTHER workspace is denied 42501", () => {
  assert.equal(setRepair("erik@test.dk", bosIncident, R4), "42501");
  assert.equal(linkOf(bosIncident), "NULL");
});

pin("a workspace admin who is not the reporter may link", () => {
  assert.equal(setRepair("anna@test.dk", bosIncident, R4), "OK");
  assert.equal(linkOf(bosIncident), R4);
});

pin("an incident that does not exist is rejected before any privilege leaks", () => {
  assert.equal(setRepair("bo@test.dk", "30000000-0000-0000-0000-0000000000ff", R4), "22023");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. THE FEED — reuses incident_updated, and only when asked
// ═══════════════════════════════════════════════════════════════════════════════

const eventCount = (type) =>
  Number(scalar(`select count(*) from public.ledger_events where ledger_id = '${L}' and event_type = '${type}';`));

pin("linking without an event_title writes no feed event", () => {
  raw(`delete from public.ledger_events where ledger_id = '${L}';`);
  assert.equal(setRepair("anna@test.dk", bosIncident, null), "OK");
  assert.equal(eventCount("incident_updated"), 0);
});

pin("linking WITH an event_title writes exactly one incident_updated — no new event_type", () => {
  raw(`delete from public.ledger_events where ledger_id = '${L}';`);
  assert.equal(setRepair("anna@test.dk", bosIncident, R4, "Reparation koblet paa"), "OK");
  assert.equal(eventCount("incident_updated"), 1);
  const types = scalar(
    `select coalesce(string_agg(distinct event_type, ','), 'NONE') from public.ledger_events where ledger_id = '${L}';`,
  );
  assert.equal(
    types,
    "incident_updated",
    "a new event_type here would reach every member's Activity feed unclassified (GV-413)",
  );
  const meta = scalar(
    `select metadata::text from public.ledger_events where ledger_id = '${L}' and event_type = 'incident_updated';`,
  );
  assert.match(meta, new RegExp(`"repair_id": ?"${R4}"`));
  assert.match(meta, /"linked": ?true/);
});

removeContainer(CONTAINER);
process.stdout.write(`\n✅ incident repair-link contract: ${checked} properties pinned against a real Postgres.\n`);
