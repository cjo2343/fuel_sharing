// Anti-drift contract for "Jeg er på vej" + the private Realtime presence channel
// (GVM-238 P0 / GVM-575, migration 202), plus the photo row caps the same migration adds.
//
// Static and dependency-free, so it runs in `npm run validate` on every commit; the role
// matrix proves the BEHAVIOUR of the two RPCs against a real Postgres. Everything is
// asserted in BOTH the migration and the consolidated schema, so the two copies cannot
// drift apart either.
//
// Six things it pins, and why each is the kind of thing a later tidy-up reverses with
// nothing else noticing:
//
//   (1) NO COORDINATE, EVER. This is the whole product decision of 2026-08-10 — the map
//       was cut and only derived MINUTES are shared. Three mechanisms hold it up and all
//       three are asserted: the RPC takes a scalar and BUILDS the jsonb, the table CHECK
//       constraint closes the key set, and no coordinate word appears anywhere in the
//       feature's SQL. The constraint is the load-bearing one, because migration 005
//       gives authenticated a real UPDATE policy on car_bookings — a member could PATCH
//       a latitude straight into the column without going near the RPC.
//
//   (2) car_bookings.updated_at IS NOT BUMPED. Migration 160 made that column an
//       optimistic-concurrency token. Adding a tidy `updated_at = now()` to either RPC
//       looks like housekeeping and would make a five-minute ETA refresh refuse every
//       other member's booking edit with GV42T. Nothing else in the repo can see that.
//
//   (3) THE ASYMMETRIC GATE. Sharing is member-or-creator; clearing also admits the
//       admin. "Simplifying" the share gate to public.can_manage_car_booking would let a
//       workspace admin announce that another person is on their way — a statement about
//       where that person is. The test asserts the share path does NOT call that helper.
//
//   (4) ONE FEED ROW PER SHARE. The first call writes on_my_way_started; a refresh writes
//       the audit type. A refactor that collapsed the two INSERT sites into one would put
//       eight entries in the feed for one drive home, and would still pass every other
//       guard. Also re-reads the GV-413 register so all three types stay classified.
//
//   (5) THE REALTIME HALF IS PROD-ONLY AND CANNOT BE SEEN BY ANY OTHER GUARD. The
//       `realtime` schema does not exist in a plain-Postgres replay, so schema
//       equivalence and the role matrix are both blind to these two policies — this file
//       is the only thing that will ever check them. It therefore asserts the full policy
//       TEXT, the schema guard around every realtime statement, the left()/substring()
//       prefix handling (a ledger id can contain LIKE's '_' wildcard), and the ABSENCE of
//       an `alter table realtime.messages enable row level security` we neither need nor
//       own.
//
//   (6) THE PHOTO ROW CAPS. Migration 184's trigger caps storage OBJECTS; nothing capped
//       the ROW registrations until now. Each cap must equal its bucket's object limit,
//       and must be counted UNDER the advisory lock — a bare count-then-insert is the
//       exact check-then-insert race 184 was written to close, and it looks identical in
//       a diff.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FEED_VISIBLE_EVENT_TYPES } from './ledger-event-visibility.mjs';
import { EVENT_TYPE_EXCLUDE } from './load-rehearsal/lib/hotpaths.mjs';

// Comments are stripped before anything is matched. Half the assertions below are
// NEGATIVES ("no coordinate word", "no can_manage_car_booking", "no LIKE"), and this
// migration's whole argument for each of those lives in a comment right next to the code
// that obeys it — so a scan over the raw text would fail on the very prose that explains
// why the code is correct. The comments are documentation; the SQL is the contract.
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

const migration = stripComments(
  readFileSync('supabase/migrations/202_on_my_way_and_private_realtime.sql', 'utf8'),
);
const schema = stripComments(readFileSync('supabase-schema.sql', 'utf8'));

const sliceFrom = (sql, start, end) => {
  const from = sql.lastIndexOf(start);
  assert.ok(from >= 0, `expected to find ${JSON.stringify(start)}`);
  const to = sql.indexOf(end, from);
  assert.ok(to > from, `expected to find ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return sql.slice(from, to);
};

// Words that must never appear in this feature's SQL. The point of GVM-238 P0 is that
// the platform never learns a position, so the vocabulary of positions has no business
// in any of these bodies.
const COORDINATE_WORDS = /\b(lat|latitude|lng|lon|longitude|coord|coordinate|geohash|accuracy|heading|altitude|geo_point|position)\b/i;

for (const [label, sql] of [['migration 202', migration], ['supabase-schema.sql', schema]]) {
  // ── (1) the column and the shape constraint ─────────────────────────────────
  assert.match(
    sql,
    /alter table public\.car_bookings\s+add column if not exists on_my_way jsonb;/i,
    `${label}: car_bookings.on_my_way must be a nullable jsonb column`,
  );

  const constraint = sliceFrom(
    sql,
    "add constraint car_bookings_on_my_way_shape_check",
    'end $$;',
  );
  // All three keys required…
  assert.match(
    constraint,
    /on_my_way \?& array\['eta_minutes', 'started_at', 'updated_at'\]/,
    `${label}: the constraint must require all three keys`,
  );
  // …and nothing else tolerated. This half is the one that makes "no coordinate is ever
  // stored" true against a direct PostgREST PATCH; dropping it leaves a constraint that
  // happily accepts {"eta_minutes":5,"started_at":…,"updated_at":…,"lat":55.6}.
  assert.match(
    constraint,
    /on_my_way - array\['eta_minutes', 'started_at', 'updated_at'\] = '\{\}'::jsonb/,
    `${label}: the constraint must CLOSE the key set — an extra key is how a coordinate gets in`,
  );
  assert.match(constraint, /jsonb_typeof\(on_my_way -> 'eta_minutes'\) = 'number'/);
  assert.match(constraint, /on_my_way -> 'eta_minutes' >= '1'::jsonb/);
  assert.match(constraint, /on_my_way -> 'eta_minutes' <= '600'::jsonb/);
  assert.match(constraint, /jsonb_typeof\(on_my_way -> 'started_at'\) = 'string'/);
  assert.match(constraint, /jsonb_typeof\(on_my_way -> 'updated_at'\) = 'string'/);
  // A CHECK constraint cannot contain a subquery, which is why the key set is closed with
  // the jsonb minus operator rather than jsonb_object_keys. A `select` here would fail at
  // apply time in the SQL Editor, long after CI said yes.
  assert.doesNotMatch(
    constraint,
    /\bselect\b/i,
    `${label}: a CHECK constraint cannot contain a subquery`,
  );

  // ── (2)+(3) set_on_my_way ───────────────────────────────────────────────────
  const setFn = sliceFrom(
    sql,
    'create or replace function public.set_on_my_way',
    'revoke all on function public.set_on_my_way',
  );

  // The signature takes SCALARS. A jsonb parameter would be a hole straight through
  // every other protection in this file.
  assert.match(
    setFn,
    /public\.set_on_my_way\(\s*target_ledger_id text,\s*legacy_booking_id text,\s*eta_minutes integer,\s*event_title text default null,\s*event_body text default null\s*\)/,
    `${label}: set_on_my_way must take scalars only — no jsonb parameter`,
  );
  assert.doesNotMatch(setFn, /\bjsonb\s+default\b|\b\w+ jsonb\s*[,)]/i, `${label}: no jsonb parameter`);

  // The state is BUILT here, from the scalar.
  assert.match(
    setFn,
    /v_state := jsonb_build_object\(\s*'eta_minutes', eta_minutes,\s*'started_at', v_started_at,\s*'updated_at', v_updated_at\s*\)/,
    `${label}: the stored jsonb must be constructed server-side from scalars`,
  );

  assert.match(setFn, /if eta_minutes < 1 or eta_minutes > 600 then/, `${label}: 1..600 bounds`);
  assert.match(setFn, /v_booking\.end_at <= now\(\)/, `${label}: active-or-upcoming only`);
  assert.match(setFn, /public\.is_ledger_member\(target_ledger_id\)/);
  assert.match(setFn, /v_actor_member_id := public\.current_ledger_member_id\(target_ledger_id\)/);
  assert.match(setFn, /and cb\.deleted_at is null/, `${label}: a soft-deleted booking cannot be shared`);

  // (3) member-or-creator, and explicitly NOT the admin-inclusive helper.
  assert.match(
    setFn,
    /v_actor_member_id is distinct from v_booking\.member_id\s*\n?\s*and v_actor_member_id is distinct from v_booking\.created_by_member_id then/,
    `${label}: sharing is gated to the booking's member or its creator`,
  );
  assert.doesNotMatch(
    setFn,
    /can_manage_car_booking/,
    `${label}: set_on_my_way must NOT use can_manage_car_booking — that helper admits the ` +
      'workspace admin, and an admin announcing that another person is on their way is a ' +
      'statement about where that person is',
  );

  // (2) the optimistic-concurrency token stays put.
  assert.doesNotMatch(
    setFn,
    /updated_at\s*=\s*now\(\)/,
    `${label}: set_on_my_way must not bump car_bookings.updated_at — migration 160 made it ` +
      'an optimistic-concurrency token, and a 5-minute refresh would refuse every other ' +
      "member's booking edit with GV42T",
  );

  // Its own advisory-lock infix, so it cannot stand in for 063's ':booking:',
  // 162's ':bookingcap:' or 164's ':handover:'.
  assert.match(
    setFn,
    /pg_advisory_xact_lock\(hashtext\(target_ledger_id \|\| ':onmyway:' \|\| legacy_booking_id\)\)/,
  );

  // ── (4) one feed row per share, audit rows for the refreshes ────────────────
  assert.match(
    setFn,
    /if v_first and event_title is not null then[\s\S]*?'on_my_way_started', event_title, coalesce\(event_body, ''\)/,
    `${label}: the feed row is written only on the FIRST call of a share, with the client's title`,
  );
  assert.match(
    setFn,
    /else[\s\S]*?'on_my_way_updated', 'Forventet ankomst opdateret', ''/,
    `${label}: every refresh must write the AUDIT type, not a second feed row`,
  );
  // Metadata is ids and minutes. Nothing else has any business in a row that is retained
  // for 30 days and readable by every member.
  assert.match(
    setFn,
    /jsonb_build_object\('booking_id', v_booking\.id, 'eta_minutes', eta_minutes\)/,
  );

  // ── clear_on_my_way ─────────────────────────────────────────────────────────
  const clearFn = sliceFrom(
    sql,
    'create or replace function public.clear_on_my_way',
    'revoke all on function public.clear_on_my_way',
  );
  // The deliberate asymmetry with set_on_my_way: clearing IS administrable.
  assert.match(
    clearFn,
    /if not public\.can_manage_car_booking\(v_booking\.id\) then/,
    `${label}: clearing must admit the workspace admin — it is the escape hatch for a ` +
      'share stuck on by a crashed client',
  );
  // Idempotent: a second stop returns cleared=false and writes NO event. Three auto-stop
  // triggers race by design (arrival, booking end, manual), so this is the normal path.
  assert.match(
    clearFn,
    /if v_booking\.on_my_way is null then\s*\n\s*return jsonb_build_object\([\s\S]*?'cleared', false\s*\);\s*\n\s*end if;/,
    `${label}: a clear on an already-null share must be a silent no-op`,
  );
  assert.match(clearFn, /'on_my_way_stopped', 'Deling af ankomst stoppet', ''/);
  assert.doesNotMatch(
    clearFn,
    /updated_at\s*=\s*now\(\)/,
    `${label}: clear_on_my_way must not bump car_bookings.updated_at either`,
  );
  // No deleted_at filter: a cancelled booking with a live share is exactly the case that
  // needs clearing.
  assert.doesNotMatch(
    clearFn,
    /deleted_at is null/,
    `${label}: clear must reach a soft-deleted booking — that is where a share gets stuck`,
  );

  // ── (1) no coordinate vocabulary anywhere in the feature ────────────────────
  for (const [name, body] of [['set_on_my_way', setFn], ['clear_on_my_way', clearFn], ['the shape constraint', constraint]]) {
    assert.doesNotMatch(
      body,
      COORDINATE_WORDS,
      `${label}: ${name} must not mention a coordinate — the platform never receives one`,
    );
  }

  // Grants: client-callable, anon named explicitly (migration 148's convention).
  for (const sig of ['public.set_on_my_way(text, text, integer, text, text)', 'public.clear_on_my_way(text, text)']) {
    const esc = sig.replace(/[.()]/g, (c) => `\\${c}`);
    assert.match(sql, new RegExp(`revoke all on function ${esc} from public;`));
    assert.match(sql, new RegExp(`revoke all on function ${esc} from anon;`));
    assert.match(sql, new RegExp(`grant execute on function ${esc} to authenticated;`));
  }

  // ── (5) the Realtime half ───────────────────────────────────────────────────
  // The consolidated schema carries SEVERAL guard blocks since migrations 205/206
  // (202's original, 205's presence re-declaration, 206's live-sync pair; last
  // definition wins on replay), so the slice anchors on the presence pair's own
  // drop statement (lastIndexOf) to land on the FINAL presence definitions — the
  // ones a fresh install actually ends with.
  const realtimeBlock = sliceFrom(
    sql,
    'drop policy if exists "Ledger members can read workspace presence" on realtime.messages',
    'end $$;',
  );

  // Every realtime reference must live inside a guard block, and nowhere else: the
  // schema does not exist in the plain-Postgres containers every Docker-backed guard
  // replays into (the migration-138 storage lesson, applied to a second schema).
  const guardRanges = [
    ...sql.matchAll(/if exists \(select 1 from information_schema\.schemata where schema_name = 'realtime'\) then/g),
  ].map((g) => {
    const end = sql.indexOf('end $$;', g.index);
    assert.ok(end > g.index, `${label}: every realtime guard block must close with end $$;`);
    return [g.index, end];
  });
  const realtimeMentions = [...sql.matchAll(/realtime\.(messages|topic)/g)];
  assert.ok(realtimeMentions.length >= 8, `${label}: expected the realtime policies to be present`);
  for (const m of realtimeMentions) {
    assert.ok(
      guardRanges.some(([start, end]) => m.index > start && m.index < end),
      `${label}: every realtime.* reference must sit inside the realtime-schema guard`,
    );
  }

  // Which extension list the FINAL policy definition must carry differs by target:
  // migration 202's file is history and keeps its original presence-only text, while
  // the consolidated schema must end on migration 205's widened list — Realtime's
  // join check test-writes rows for BOTH extensions in one transaction, so a
  // presence-only WITH CHECK aborts the whole check and every private join is
  // rejected "Unauthorized" (the GVM-575 root cause).
  const extensionClause =
    label === 'migration 202'
      ? "realtime\\.messages\\.extension = 'presence'"
      : "realtime\\.messages\\.extension in \\('broadcast', 'presence'\\)";
  for (const [policy, action, clause] of [
    ['Ledger members can read workspace presence', 'select', 'using'],
    ['Ledger members can track workspace presence', 'insert', 'with check'],
  ]) {
    assert.match(
      realtimeBlock,
      new RegExp(`drop policy if exists "${policy}" on realtime\\.messages`),
      `${label}: ${policy} needs its drop-if-exists (idempotent replay)`,
    );
    assert.match(
      realtimeBlock,
      new RegExp(
        `create policy "${policy}"\\s*\\n\\s*on realtime\\.messages\\s*\\n\\s*for ${action}\\s*\\n\\s*to authenticated\\s*\\n\\s*${clause} \\(\\s*\\n\\s*${extensionClause}\\s*\\n\\s*and left\\(realtime\\.topic\\(\\), 9\\) = 'presence-'\\s*\\n\\s*and public\\.is_ledger_member\\(substring\\(realtime\\.topic\\(\\) from 10\\)\\)\\s*\\n\\s*\\)`,
      ),
      `${label}: ${policy} must gate on the extension list, the literal topic prefix and ` +
        'workspace membership',
    );
  }

  // Presence needs BOTH directions. A SELECT-only pair would let a member watch the room
  // and never appear in it, which reads in the app as "nobody is online".
  assert.ok(
    /for select/.test(realtimeBlock) && /for insert/.test(realtimeBlock),
    `${label}: presence authorization needs a SELECT policy (receive) AND an INSERT policy (track)`,
  );

  // left()/substring(), never LIKE: a ledger id may contain '_', which LIKE reads as a
  // single-character wildcard.
  assert.doesNotMatch(
    realtimeBlock,
    /\blike\b/i,
    `${label}: match the topic prefix with left(), not LIKE — a ledger id can contain '_'`,
  );

  // Supabase enables RLS on realtime.messages itself, and we do not own that table.
  assert.doesNotMatch(
    sql,
    /alter table realtime\.messages enable row level security/i,
    `${label}: RLS is already enabled on realtime.messages by Supabase, and this migration ` +
      'does not own that table — issuing the ALTER would fail in the SQL Editor for nothing',
  );

  // ── (6) the photo row caps ──────────────────────────────────────────────────
  for (const [fn, table, parent, key, limit, sentence] of [
    [
      'add_vehicle_document_photo',
      'vehicle_document_photos',
      'p_document_id',
      'vehicle_document_photos:',
      5,
      'Der er plads til højst 5 sider på et dokument',
    ],
    [
      'add_incident_photo',
      'vehicle_incident_photos',
      'p_incident_id',
      'vehicle_incident_photos:',
      10,
      'Der er plads til højst 10 billeder på en skade',
    ],
  ]) {
    const body = sliceFrom(
      sql,
      `create or replace function public.${fn}`,
      `revoke all on function public.${fn}`,
    );
    assert.match(
      body,
      new RegExp(
        `perform pg_advisory_xact_lock\\(hashtext\\('${key}' \\|\\| ${parent}::text\\)\\);[\\s\\S]*?` +
          `select count\\(\\*\\)[\\s\\S]*?from public\\.${table}[\\s\\S]*?` +
          `if v_existing >= ${limit} then`,
      ),
      `${fn} in ${label}: the row cap must be counted UNDER the advisory lock — a plain ` +
        'count-then-insert is the check-then-insert race migration 184 exists to close',
    );
    assert.match(
      body,
      new RegExp(`raise exception '${sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' using errcode = '23514'`),
      `${fn} in ${label}: the refusal must be the Danish sentence under check_violation`,
    );
    // The prefix rule the cap is bolted next to must survive the re-declaration.
    assert.match(body, /left\(p_storage_path, length\(v_expected_prefix\)\) <> v_expected_prefix/);
  }
}

// ── The row caps must AGREE with migration 184's object caps ──────────────────
// If they ever disagree, one of the two limits silently becomes dead code and the other
// starts refusing uploads the UI still offers. Read the live quota trigger and compare.
const quota = sliceFrom(
  schema,
  'create or replace function public.enforce_storage_upload_quota',
  'end;\n$$;',
);
for (const [bucket, limit] of [['vehicle-documents', 5], ['incident-photos', 10]]) {
  assert.match(
    quota,
    new RegExp(`new\\.bucket_id = '${bucket}' then\\s*\\n\\s*v_limit := ${limit};`),
    `the ${bucket} ROW cap (${limit}) must equal the OBJECT cap migration 184's trigger enforces`,
  );
}

// ── GV-413: all three event types classified, and the audit pair appended LAST ─
assert.ok(
  FEED_VISIBLE_EVENT_TYPES.includes('on_my_way_started'),
  'on_my_way_started must be registered as feed-visible — it is the whole point of the feature',
);
for (const audit of ['on_my_way_updated', 'on_my_way_stopped']) {
  assert.ok(
    EVENT_TYPE_EXCLUDE.includes(audit),
    `${audit} must be in EVENT_TYPE_EXCLUDE — a refresh must never reach the feed`,
  );
  assert.ok(
    !FEED_VISIBLE_EVENT_TYPES.includes(audit),
    `${audit} must be audit-only, not feed-visible`,
  );
}
// The exclusion list is compared against govehlo-mobile's gateway with join(","), so the
// ORDER is the cross-repo contract. These two are the newest, so they go last, in this
// order, on both sides.
assert.deepEqual(
  EVENT_TYPE_EXCLUDE.slice(-2),
  ['on_my_way_updated', 'on_my_way_stopped'],
  'the two new audit types must be appended LAST and in this order — check-hotpath-mirror.mjs ' +
    "compares this list against the mobile gateway's with join(\",\")",
);

// ── Migration 205: the broadcast widening itself ──────────────────────────────
// 205 re-declares both policies with extension in ('broadcast', 'presence') and is
// self-cleaning over the TEMP diagnostic policies created while proving the fix in
// prod. Its file must keep the guard discipline (every realtime.* mention inside the
// schemata guard, every statement through EXECUTE) exactly like 202's block.
{
  const migration205 = stripComments(
    readFileSync('supabase/migrations/205_presence_policies_cover_broadcast.sql', 'utf8'),
  );
  const guardStart = migration205.indexOf(
    "if exists (select 1 from information_schema.schemata where schema_name = 'realtime') then",
  );
  const guardEnd = migration205.indexOf('end $$;', guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart, 'migration 205: realtime guard block must exist and close');
  for (const m of migration205.matchAll(/realtime\.(messages|topic)/g)) {
    assert.ok(
      m.index > guardStart && m.index < guardEnd,
      'migration 205: every realtime.* reference must sit inside the realtime-schema guard',
    );
  }
  for (const temp of ['TEMP members broadcast read', 'TEMP members broadcast write']) {
    assert.match(
      migration205,
      new RegExp(`drop policy if exists "${temp}" on realtime\\.messages`),
      `migration 205: must drop the prod diagnostic policy "${temp}" so applying it is self-cleaning`,
    );
  }
  for (const policy of ['Ledger members can read workspace presence', 'Ledger members can track workspace presence']) {
    assert.match(
      migration205,
      new RegExp(`create policy "${policy}"`),
      `migration 205: must re-declare "${policy}"`,
    );
  }
  assert.match(
    migration205,
    /realtime\.messages\.extension in \('broadcast', 'presence'\)/,
    "migration 205: policies must authorize BOTH extensions — Realtime's join check " +
      'test-writes broadcast AND presence rows in one transaction, so a presence-only ' +
      'WITH CHECK aborts the whole check (the GVM-575 root cause)',
  );
  assert.ok(
    !/realtime\.messages\.extension = 'presence'/.test(migration205),
    'migration 205: no presence-only expression may survive in the re-declaration',
  );
}

// ── Migration 206: the ledger-changes live-sync topic pair ────────────────────
// The private-channel join check is authorized against realtime.messages even for a
// listen-only postgres_changes channel, and it test-writes BOTH extensions in one
// transaction (the 205 lesson). So the live-sync prefix needs the same read+write
// pair and the same extension list as presence, in the migration AND as the final
// state of the consolidated schema.
{
  const migration206 = stripComments(
    readFileSync('supabase/migrations/206_ledger_changes_private_channel_policies.sql', 'utf8'),
  );
  const guardStart206 = migration206.indexOf(
    "if exists (select 1 from information_schema.schemata where schema_name = 'realtime') then",
  );
  const guardEnd206 = migration206.indexOf('end $$;', guardStart206);
  assert.ok(
    guardStart206 >= 0 && guardEnd206 > guardStart206,
    'migration 206: realtime guard block must exist and close',
  );
  for (const m of migration206.matchAll(/realtime\.(messages|topic)/g)) {
    assert.ok(
      m.index > guardStart206 && m.index < guardEnd206,
      'migration 206: every realtime.* reference must sit inside the realtime-schema guard',
    );
  }
  for (const [target, sql206] of [['migration 206', migration206], ['supabase-schema.sql', schema]]) {
    const block = sliceFrom(
      sql206,
      'drop policy if exists "Ledger members can read workspace live-sync" on realtime.messages',
      'end $$;',
    );
    for (const [policy, action, clause] of [
      ['Ledger members can read workspace live-sync', 'select', 'using'],
      ['Ledger members can join workspace live-sync', 'insert', 'with check'],
    ]) {
      assert.match(
        block,
        new RegExp(
          `create policy "${policy}"\\s*\\n\\s*on realtime\\.messages\\s*\\n\\s*for ${action}\\s*\\n\\s*to authenticated\\s*\\n\\s*${clause} \\(\\s*\\n\\s*realtime\\.messages\\.extension in \\('broadcast', 'presence'\\)\\s*\\n\\s*and left\\(realtime\\.topic\\(\\), 15\\) = 'ledger-changes-'\\s*\\n\\s*and public\\.is_ledger_member\\(substring\\(realtime\\.topic\\(\\) from 16\\)\\)\\s*\\n\\s*\\)`,
        ),
        `${target}: ${policy} must gate on both extensions, the 15-char ledger-changes- prefix ` +
          'and workspace membership',
      );
    }
    assert.doesNotMatch(
      block,
      /\blike\b/i,
      `${target}: match the live-sync topic prefix with left(), not LIKE — a ledger id can contain '_'`,
    );
  }
}

console.log('✅ on_my_way + private realtime contract (migrations 202 + 205 + 206) holds in both copies');
