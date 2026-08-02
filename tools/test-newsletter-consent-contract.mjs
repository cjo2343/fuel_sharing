#!/usr/bin/env node
// Consent contract for the newsletter list (GV-366).
//
// WHY A STATIC GUARD AND NOT ONLY THE ROLE MATRIX
//
// tools/test-rls-role-matrix.mjs proves what the three RPCs DO in a real Postgres, and
// it carries the newsletter cases. It cannot prove the properties that are about what
// is ABSENT, and every legal property of this list is exactly that shape:
//
//   * nothing seeds the list from the product's own users
//   * no policy or grant opens the table to a browser role
//   * no column keeps an address after the person asked us to stop
//
// A matrix case can only exercise a path that exists. "There is no path from
// auth.users to this table" is not a path, so no case can fail when one appears — the
// mutation that would matter here is an ADDITION, and the only guard that catches an
// addition is one that reads the file. That is this file, and it is deliberately
// Docker-free so it runs on every commit rather than only in the heavy job.
//
// Both copies are checked — the migration and the consolidated schema — because
// supabase-schema.sql is what a fresh install replays, so a property that holds in one
// and not the other is not a property.
//
// WHAT THIS DOES NOT CLAIM. It does not check the newsletter FLOW, which lives in
// govehlo-web (functions/api/newsletter/**, pinned by that repo's own tests). It checks
// the database contract those Functions are written against.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCES = [
  ["supabase/migrations/161_newsletter_subscribers.sql", null],
  // The consolidated schema carries every migration; slice out the 161 block so the
  // absence assertions below are not answered by unrelated parts of a 40 000-line file.
  ["supabase-schema.sql", "-- Migration 161: standalone double-opt-in newsletter list (GV-366)"],
];

const TABLE = "public.newsletter_subscribers";
const RPCS = [
  "public.newsletter_request_subscription",
  "public.newsletter_confirm_subscription",
  "public.newsletter_unsubscribe",
];

function load([file, marker]) {
  const raw = readFileSync(file, "utf8");
  if (marker === null) return { file, sql: raw };
  const at = raw.indexOf(marker);
  assert.notEqual(
    at,
    -1,
    `${file}: migration 161's block is missing entirely — the mirror is what a fresh ` +
      "install replays, so an unmirrored migration is a schema that only exists in production",
  );
  return { file, sql: raw.slice(at) };
}

// Three things are removed before anything is asserted, and all three are prose rather
// than executable schema. The absence assertions below scan for table NAMES, and this
// migration documents at length WHY it never touches those tables — so without this
// step the guard's first casualty would be the guard's own rationale, and the fix
// someone reached for would be deleting the explanation.
//
//   * `-- …` line comments (the file header).
//   * `comment on … is '…';` — the table and column comments, which say in Danish law's
//     terms what may never be joined here.
//   * the fuel_ledger_schema_migrations tracker INSERT, whose description string is the
//     same argument a third time.
//
// Stripping quoted strings wholesale is NOT an option: the status literals and the
// check-constraint regexes asserted below are quoted strings too. Dollar-quoted
// function BODIES are kept verbatim — a seeding query hidden inside an RPC is precisely
// the mutation this file exists to catch.
function schemaStatementsOnly(sql) {
  const trackerAt = sql.indexOf("insert into public.fuel_ledger_schema_migrations");
  return (trackerAt === -1 ? sql : sql.slice(0, trackerAt))
    .replace(/\bcomment on [\s\S]*?\bis\s*'(?:[^']|'')*'\s*;/g, "")
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

let checked = 0;
for (const source of SOURCES) {
  const { file, sql: raw } = load(source);
  const sql = schemaStatementsOnly(raw);
  const where = (what) => `${file}: ${what}`;

  // ── 1. The list is standalone ──────────────────────────────────────────────
  //
  // The single legal property everything else rests on. A product account is not
  // marketing consent, so there must be no statement anywhere in this block that reads
  // the product's own user tables. Written as a scan for the table NAMES rather than
  // for an insert-select, because the shape a future seeding path takes cannot be
  // predicted and its table names can.
  for (const forbidden of ["auth.users", "ledger_members", "public.ledgers", "expo_push_tokens"]) {
    assert.ok(
      !sql.includes(forbidden),
      where(
        `the newsletter block references ${forbidden}. This list may never be seeded from ` +
          "the product's own users — consent to use GoVehlo is not consent to be marketed to " +
          "(markedsfoeringsloven paragraph 10). If you need a genuinely new relationship here, " +
          "that is a decision for the owner and a new ticket, not a join",
      ),
    );
  }

  // ── 2. Nothing browser-facing can reach the table ──────────────────────────
  assert.match(
    sql,
    new RegExp(`alter\\s+table\\s+${TABLE}\\s+enable\\s+row\\s+level\\s+security`, "i"),
    where("RLS must be enabled on the subscriber list"),
  );
  assert.ok(
    !/create\s+policy[\s\S]{0,400}newsletter_subscribers/i.test(sql),
    where(
      "a policy on newsletter_subscribers. The table is not client-facing: deny-all with " +
        "no policy is the design, and the three security-definer RPCs are the only surface",
    ),
  );
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    assert.match(
      sql,
      new RegExp(`revoke\\s+all\\s+on\\s+${TABLE}\\s+from\\s+${role}\\s*;`, "i"),
      where(
        `revoke all on ${TABLE} from ${role} is missing. Supabase's default privileges ` +
          "grant ALL on new tables to anon/authenticated/service_role, so a table with no " +
          "explicit revoke is a table every role can read" +
          (role === "service_role"
            ? " — and service_role is the key the Cloudflare Functions hold, which is exactly " +
              "the reader this design refuses"
            : ""),
      ),
    );
  }
  // The inverse of the four revokes: no grant may hand the table back to anybody. A
  // later `grant select … to service_role` would leave every revoke above intact and
  // still open the list, so the revokes alone are not the property.
  const tableGrants = [...sql.matchAll(new RegExp(`grant\\s+[\\s\\S]{0,80}?\\s+on\\s+${TABLE}\\s+to\\s+(\\w+)`, "gi"))];
  assert.deepEqual(
    tableGrants.map((m) => m[1]),
    [],
    where(
      "a GRANT on newsletter_subscribers. Every role is revoked on purpose, service_role " +
        "included; reads and writes go through the RPCs so that no code path can enumerate " +
        "the address list",
    ),
  );

  // ── 3. The consent proof exists and the tokens are hashes ──────────────────
  for (const column of ["requested_at", "confirmed_at", "consent_text_version"]) {
    assert.match(
      sql,
      new RegExp(`^\\s+${column}\\s`, "m"),
      where(`${column} is missing — the three columns together ARE the consent proof`),
    );
  }
  // sha256 hex shape, enforced by the database rather than trusted from the caller. A
  // raw token stored by mistake fails the constraint instead of sitting in the table.
  for (const column of ["confirm_token_hash", "unsubscribe_token_hash"]) {
    assert.match(
      sql,
      new RegExp(`check\\s*\\(${column}[\\s\\S]{0,80}\\^\\[0-9a-f\\]\\{64\\}\\$`, "i"),
      where(`${column} has no sha256-hex check constraint — the raw token must never be storable`),
    );
  }
  // The single-use invariant, at the schema level rather than in a status column.
  assert.match(
    sql,
    /check\s*\(\(confirmed_at is null\) = \(confirm_token_hash is not null\)\)/i,
    where(
      "the single-use invariant is gone. A pending row HAS a confirm token and a confirmed " +
        "row has none; that equivalence is what makes a replayed confirmation link match nothing",
    ),
  );

  // ── 4. Unsubscribing deletes, and leaves nothing behind ────────────────────
  assert.ok(
    !/unsubscribed_at/i.test(sql),
    where(
      "an unsubscribed_at column. Unsubscribing hard-deletes the row: a tombstone would " +
        "retain the address of precisely the person who asked us to stop holding it, and the " +
        "re-import risk that normally justifies a suppression list does not exist here",
    ),
  );
  assert.match(
    sql,
    new RegExp(`delete\\s+from\\s+${TABLE}\\s+ns\\s+where\\s+ns\\.unsubscribe_token_hash`, "i"),
    where("newsletter_unsubscribe must DELETE the row, not flag it"),
  );

  // ── 5. The RPCs are the only surface, and only the server may call them ────
  for (const fn of RPCS) {
    const declaration = new RegExp(`create or replace function ${fn}\\(([\\s\\S]*?)\\)\\s*returns`, "i");
    assert.match(sql, declaration, where(`${fn} is missing`));
    assert.match(
      sql,
      new RegExp(`create or replace function ${fn}\\([\\s\\S]*?security\\s+definer[\\s\\S]*?set\\s+search_path\\s*=\\s*public`, "i"),
      where(`${fn} must be security definer with a pinned search_path — the table denies its callers`),
    );
    for (const role of ["public", "anon", "authenticated"]) {
      assert.match(
        sql,
        new RegExp(`revoke all on function ${fn}\\([^)]*\\) from ${role}\\s*;`, "i"),
        where(`${fn} is still executable by ${role} (Supabase grants EXECUTE by default)`),
      );
    }
    assert.match(
      sql,
      new RegExp(`grant execute on function ${fn}\\([^)]*\\) to service_role\\s*;`, "i"),
      where(`${fn} must be granted to service_role — it is the Pages Functions' identity`),
    );
    assert.ok(
      !new RegExp(`grant execute on function ${fn}\\([^)]*\\) to (anon|authenticated)\\s*;`, "i").test(sql),
      where(`${fn} is granted to a browser role. Only the server may touch the list`),
    );
  }

  // The subscribe RPC decides whether a mail is warranted; an endpoint that mailed on
  // every submit would be a mail bomb aimed at any address an attacker picks.
  assert.match(
    sql,
    /'status',\s*'already_confirmed',\s*'send_mail',\s*false/i,
    where(
      "newsletter_request_subscription no longer suppresses the mail for an already-confirmed " +
        "address. The database decides, because the endpoint must render the same reassurance " +
        "either way and therefore cannot know",
    ),
  );
  // Expiry, from the confirming end. Without the window a pending row could be
  // confirmed years later, which is a consent record that says nothing.
  assert.match(
    sql,
    /and ns\.requested_at >= now\(\) - v_ttl/i,
    where("newsletter_confirm_subscription no longer refuses an expired pending token"),
  );
  // ...and from the purging end.
  assert.match(
    sql,
    new RegExp(
      `delete\\s+from\\s+${TABLE}\\s+ns\\s+where\\s+ns\\.confirmed_at is null\\s+and ns\\.requested_at < now\\(\\) - v_ttl`,
      "i",
    ),
    where("the expired-pending sweep in newsletter_request_subscription is gone"),
  );

  checked++;
}

assert.equal(checked, SOURCES.length, "both the migration and the consolidated mirror must be checked");

// ── Self-test: the scanner still recognises what it was built for ────────────
//
// Every assertion above passes on a clean tree, which is also what a broken regex
// produces. So run the two that carry the most weight against planted mutations.
{
  const clean = readFileSync("supabase/migrations/161_newsletter_subscribers.sql", "utf8");

  const seeded = schemaStatementsOnly(
    clean.replace(
      "  return jsonb_build_object('status', 'pending', 'send_mail', true);\nend;",
      "  insert into public.newsletter_subscribers (email, consent_text_version, confirm_token_hash, unsubscribe_token_hash)\n" +
        "  select lm.email, 'legacy', v_confirm, v_unsubscribe from public.ledger_members lm;\n" +
        "  return jsonb_build_object('status', 'pending', 'send_mail', true);\nend;",
    ),
  );
  assert.ok(seeded.includes("ledger_members"), "the planted seeding mutation must survive comment stripping");

  const reopened = schemaStatementsOnly(
    clean.replace(
      "revoke all on public.newsletter_subscribers from service_role;",
      "grant select on public.newsletter_subscribers to service_role;",
    ),
  );
  assert.match(
    reopened,
    new RegExp(`grant\\s+[\\s\\S]{0,80}?\\s+on\\s+${TABLE}\\s+to\\s+service_role`, "i"),
    "the grant scanner must still fire on a re-opened table",
  );
  assert.ok(
    !new RegExp(`revoke\\s+all\\s+on\\s+${TABLE}\\s+from\\s+service_role\\s*;`, "i").test(reopened),
    "the revoke assertion must fail when the revoke is replaced by a grant",
  );

  // A comment naming ledger_members is prose, not a join — the header argues about
  // exactly that. Getting this wrong makes the guard unusable and it would be silenced.
  assert.ok(
    !schemaStatementsOnly("-- never seeded from public.ledger_members or auth.users\nselect 1;").includes("ledger_members"),
    "prose in a line comment must not read as a seeding path",
  );
}

console.log("✅ test-newsletter-consent-contract: newsletter list is standalone, deny-all and tombstone-free.");
