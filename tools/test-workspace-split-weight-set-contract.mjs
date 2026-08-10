#!/usr/bin/env node
// Anti-drift contract for the workspace's named split weight set (GVM-563, migration 199).
//
// WHY A STATIC GUARD AND NOT ONLY THE ROLE MATRIX
//
// tools/test-rls-role-matrix.mjs proves what the RPC and the settlement function DO in a
// real Postgres, and it carries this feature's cases (the admin gate, the validation
// refusals, the inheritance, the stale fallback, the event). What it cannot prove is the
// set of properties that are about something ABSENT or about the SHAPE of the SQL, and
// three of the four things most likely to be undone here have exactly that form:
//
//   1. The stale-fingerprint fallback resolves to 'equal'. A matrix case pins the NUMBER;
//      it passes just as happily if a future edit deletes the explicit rule rewrite and
//      leans on the zero-total-weight path in expense_cents instead. Those two produce the
//      same answer TODAY and are one careless change apart from not doing so — and the
//      client mirrors the explicit branch, not the implicit one. So the branch itself is
//      pinned here, in text.
//   2. The fingerprint's ORDERING RULE. `order by lm.id::text collate "C"` is what makes
//      the SQL string character-identical to the client's `ids.sort().join(',')`. Drop the
//      collate and Postgres orders by the database's collation, which for a
//      non-C-collated database is not byte order — a fingerprint that mismatches for no
//      reason, so every workspace's set silently goes stale and every inherited split
//      becomes equal. No numeric assertion notices: "stale" is a valid state.
//   3. No re-normalisation, anywhere. The owner decision (2026-08-10) is that a changed
//      member list invalidates rather than rescales. A helpful future edit that divides
//      the weights by their sum, or spreads a leaver's weight over the rest, would pass
//      every behavioural case that only checks "the shares sum to the amount".
//
// Plus the one property this file is uniquely placed to check: the event classification.
// Migration 199 reuses the EXISTING 'settings_changed' type precisely so GV-413's register
// needs no change — but that is only true while it writes no OTHER event_type, and a later
// edit introducing one would sail past a matrix case that only counts settings_changed
// rows. So the block is scanned for every event_type it writes and each is required to be
// classified already.
//
// Both copies are read — the migration and the consolidated schema — because
// supabase-schema.sql is what a fresh install replays, so a property that holds in one and
// not the other is not a property.
//
// Docker-free on purpose, so it runs on every commit in `npm run validate` rather than
// only in the heavy jobs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FEED_VISIBLE_EVENT_TYPES } from "./ledger-event-visibility.mjs";
import { EVENT_TYPE_EXCLUDE } from "./load-rehearsal/lib/hotpaths.mjs";

const MIGRATION = "supabase/migrations/199_workspace_split_weight_set.sql";
const MIRROR_MARKER =
  "-- ── Migration 199: a named workspace weight set as the expense-split default (GVM-563) ─────";

function load(file, marker) {
  const raw = readFileSync(file, "utf8");
  if (marker === null) return { file, sql: raw };
  const at = raw.indexOf(marker);
  assert.notEqual(
    at,
    -1,
    `${file}: migration 199's block is missing entirely — the mirror is what a fresh ` +
      "install replays, so an unmirrored migration is a schema that only exists in production",
  );
  return { file, sql: raw.slice(at) };
}

const SOURCES = [
  load(MIGRATION, null),
  load("supabase-schema.sql", MIRROR_MARKER),
];

/** The body of one `create or replace function public.<name>(` … `$$;` block. */
function functionBody(sql, name) {
  const open = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(open, -1, `${name}: definition missing`);
  const end = sql.indexOf("\n$$;", open);
  assert.notEqual(end, -1, `${name}: unterminated definition`);
  return sql.slice(open, end);
}

for (const { file, sql } of SOURCES) {
  const where = (msg) => `${file}: ${msg}`;

  // ── 1. The three columns, all nullable, all on ledgers ──────────────────────────────
  // Nullable is the contract, not an oversight: "this workspace has no named set" is all
  // three null, which is every workspace the moment 199 is applied. A NOT NULL DEFAULT
  // here would make an empty set indistinguishable from an unconfigured one.
  for (const column of [
    "default_split_set_name text",
    "default_split_weights jsonb",
    "default_split_member_fingerprint text",
  ]) {
    assert.ok(
      sql.includes(`add column if not exists ${column};`),
      where(`ledgers must gain a nullable \`${column}\` — found no bare 'add column if not exists ${column};'`),
    );
  }

  // ── 2. The fingerprint's ordering rule ──────────────────────────────────────────────
  const fingerprint = functionBody(sql, "active_member_fingerprint");
  assert.match(
    fingerprint,
    /string_agg\(lm\.id::text, ',' order by lm\.id::text collate "C"\)/,
    where(
      "active_member_fingerprint must join the ACTIVE member ids in C (byte) order. The " +
        'collate "C" is what makes this string character-identical to the client\'s ' +
        "ids.sort().join(','); without it Postgres uses the database collation, the two " +
        "sides disagree for no reason, and every workspace's weight set silently reads as " +
        "stale — which no numeric assertion can notice, because stale is a valid state",
    ),
  );
  assert.match(
    fingerprint,
    /and lm\.is_active = true/,
    where("active_member_fingerprint must be over ACTIVE members only — an inactive member is not in the split universe"),
  );
  assert.ok(
    !/grant execute on function public\.active_member_fingerprint/.test(sql),
    where(
      "active_member_fingerprint must NOT be granted to a browser role: it is an internal " +
        "helper with no client caller, and both of its callers are SECURITY DEFINER. A grant " +
        "here would also make the role-matrix coverage check fail as an uncalled RPC (GV-379)",
    ),
  );

  // ── 3. Save is admin-only, and the fingerprint is stamped server-side ───────────────
  const setter = functionBody(sql, "set_workspace_split_weight_set");
  assert.match(
    setter,
    /if not public\.is_ledger_admin\(target_ledger_id\) then\s*\n\s*raise exception '[^']*' using errcode = '42501';/,
    where("set_workspace_split_weight_set must refuse a non-admin with 42501 — this is a workspace setting"),
  );
  assert.match(
    setter,
    /security definer/,
    where("set_workspace_split_weight_set must be SECURITY DEFINER (it gates itself; ledgers has no member write policy)"),
  );
  assert.match(
    setter,
    /new_fingerprint := case when clearing then null\s*\n\s*else public\.active_member_fingerprint\(target_ledger_id\) end;/,
    where(
      "the fingerprint must be stamped from the LIVE active members inside the RPC, never " +
        "accepted from the caller. A client-supplied fingerprint could bless a set against a " +
        "member list the database no longer has",
    ),
  );
  assert.ok(
    !/set_name_value text,\s*\n\s*weights_value jsonb,\s*\n\s*\w*fingerprint/.test(setter),
    where("set_workspace_split_weight_set must not take a fingerprint parameter"),
  );
  assert.match(
    setter,
    /and lm\.is_active = true\s*\n\s*and lm\.id::text = weight_key/,
    where("every weight key must be checked against an ACTIVE member of THIS ledger before the set is stored"),
  );
  assert.match(
    setter,
    /if positive_count = 0 then/,
    where("a set where every weight is zero must be refused — it is indistinguishable from a stale one at settle time"),
  );

  // ── 4. Validity, and the stale → EQUAL fallback, written out explicitly ─────────────
  const settlement = functionBody(sql, "calculate_period_settlement");
  assert.match(
    settlement,
    /l\.default_split_member_fingerprint\s*\n\s*= public\.active_member_fingerprint\(target_ledger_id\)/,
    where(
      "calculate_period_settlement must decide validity by comparing the STORED fingerprint " +
        "against the live one — the whole point of computing staleness rather than stamping it " +
        "is that a join/leave/deactivate needs no trigger and no write",
    ),
  );
  assert.match(
    settlement,
    /case when pe\.raw_rule = 'custom'\s*\n\s*and pe\.own_config is null\s*\n\s*and pe\.workspace_weights is null\s*\n\s*then 'equal'/,
    where(
      "the stale/absent-set fallback must REWRITE the rule to 'equal' in period_expenses. " +
        "Leaning on the zero-total-weight path in expense_cents gives the same number today " +
        "and is one careless edit away from not doing so — and the mobile engine mirrors this " +
        "explicit branch, not the implicit one, so a divergence here refuses a period close",
    ),
  );
  assert.match(
    settlement,
    /case when pe\.raw_rule = 'custom'\s*\n\s*then coalesce\(pe\.own_config, pe\.workspace_weights\)\s*\n\s*else pe\.own_config end as split_config/,
    where(
      "an expense's OWN split_config must win over the workspace set, and the set must only " +
        "fill in for an INHERITED custom rule. The workspace default never overrides weights " +
        "somebody typed on the entry",
    ),
  );

  // ── 5. No re-normalisation, ever (the 2026-08-10 owner decision) ────────────────────
  // The invalidate-and-fall-back rule is a product decision, not an implementation detail:
  // rescaling 40/30/30 over a group that has gained or lost a person invents a number
  // nobody agreed to and then charges money against it. Nothing in this feature may divide
  // the stored weights by their own sum.
  for (const forbidden of [
    /sum\s*\(\s*weight\s*\)\s*(?:over|\/)/i,
    /normalis[ez]e[_ ]weights/i,
    /rescale/i,
  ]) {
    assert.ok(
      !forbidden.test(setter),
      where(
        `set_workspace_split_weight_set must not normalise or rescale the stored weights ` +
          `(matched ${forbidden}). Weights are stored exactly as the group typed them; the ` +
          `proportional division happens per expense, in the largest-remainder chain`,
      ),
    );
  }

  // ── 6. The write is visible to the group ────────────────────────────────────────────
  assert.match(
    setter,
    /insert into public\.ledger_events \(/,
    where(
      "saving the set must write a ledger_events row: an RPC that logs no event does not " +
        "live-sync to the other members' clients (the migration 087 lesson), and this one " +
        "changes how everybody's money is divided",
    ),
  );
  assert.match(
    setter,
    /actor_id := public\.current_ledger_member_id\(target_ledger_id\);/,
    where("the event's actor must come from current_ledger_member_id (the 051/052 pattern)"),
  );
  assert.match(
    setter,
    /if old_name is not distinct from .*\n(?:.*\n)*?\s*return;/,
    where("a re-save that changes nothing must emit no event (the GV-292 no-op suppression rule)"),
  );

  // ── 7. Data minimisation in the event row ───────────────────────────────────────────
  // The metadata may name the SET (group-chosen text, shown to that group in their own
  // feed) and count the members. It must not carry the weights or a member id: an event
  // row is retained far longer than a settings change is interesting.
  const metadata = setter.slice(setter.indexOf("jsonb_build_object(\n      'field'"));
  assert.ok(
    !/weights_value|default_split_weights/.test(metadata),
    where("the event metadata must not embed the weights object"),
  );
}

// ── 8. Event classification (GV-413) ──────────────────────────────────────────────────
// Reusing 'settings_changed' is what keeps the register unchanged — but only while this
// block writes nothing else. Read every event_type it actually writes and require each to
// be classified already; a NEW one has to be a deliberate entry in one of the two lists,
// not a silent arrival in every member's feed.
{
  const { sql } = SOURCES[0];
  const written = new Set();
  for (const match of sql.matchAll(/\n\s*'([a-z][a-z0-9_]*)',\s*\n\s*'[^']*',\s*\n/g)) {
    // The 051/052 insert shape: (…) values (ledger, '<event_type>', '<title>', …)
    written.add(match[1]);
  }
  const classified = new Set([...FEED_VISIBLE_EVENT_TYPES, ...EVENT_TYPE_EXCLUDE]);
  for (const type of written) {
    assert.ok(
      classified.has(type),
      `${MIGRATION}: event_type '${type}' is written but not classified (GV-413). Put it in ` +
        "FEED_VISIBLE_EVENT_TYPES (tools/ledger-event-visibility.mjs) or in EVENT_TYPE_EXCLUDE " +
        "(tools/load-rehearsal/lib/hotpaths.mjs AND the mobile gateway's filter, same order)",
    );
  }
  assert.ok(
    written.has("settings_changed"),
    `${MIGRATION}: the weight-set save should reuse the existing feed-visible 'settings_changed' ` +
      "type — if it deliberately moved to a new type, this assertion is the place to record that",
  );
  assert.ok(
    FEED_VISIBLE_EVENT_TYPES.includes("settings_changed"),
    "settings_changed must stay feed-visible: a change to how expenses are divided is news for " +
      "the whole group, not an audit row",
  );
}

// ── Self-test ─────────────────────────────────────────────────────────────────────────
// The assertions above are regexes over SQL, and a regex that has quietly stopped matching
// anything reads exactly like a passing guard. Plant the two mutations this file exists to
// catch and require it to fail on both.
{
  const raw = readFileSync(MIGRATION, "utf8");

  const collateDropped = raw.replace(
    `order by lm.id::text collate "C"`,
    "order by lm.id::text",
  );
  assert.notEqual(collateDropped, raw, "self-test: the collate anchor no longer appears in the migration");
  assert.throws(
    () =>
      assert.match(
        collateDropped,
        /string_agg\(lm\.id::text, ',' order by lm\.id::text collate "C"\)/,
      ),
    "self-test: dropping the C collation must fail the fingerprint-ordering assertion",
  );

  const fallbackDropped = raw.replace(
    "                then 'equal'\n                else pe.raw_rule end as rule",
    "                then pe.raw_rule\n                else pe.raw_rule end as rule",
  );
  assert.notEqual(fallbackDropped, raw, "self-test: the fallback anchor no longer appears in the migration");
  assert.throws(
    () =>
      assert.match(
        fallbackDropped,
        /case when pe\.raw_rule = 'custom'\s*\n\s*and pe\.own_config is null\s*\n\s*and pe\.workspace_weights is null\s*\n\s*then 'equal'/,
      ),
    "self-test: removing the explicit stale → 'equal' rewrite must fail the fallback assertion",
  );
}

console.log(
  "✅ test-workspace-split-weight-set-contract: the named weight set is admin-written with a " +
    "server-stamped active-member fingerprint, never re-normalised, and a stale set falls back to " +
    "an explicit equal split in the same branch the mobile engine mirrors; the save is feed-visible " +
    "through the already-classified settings_changed type.",
);
