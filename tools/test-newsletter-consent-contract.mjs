#!/usr/bin/env node
// Consent contract for the newsletter list (GV-366) and its send flow (GV-430).
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
//   * no raw unsubscribe token is stored, and no send log keeps a recipient (GV-430)
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
import { readFileSync, readdirSync } from "node:fs";

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

// ── 6. The properties hold GLOBALLY, not only inside the 161 block ───────────
//
// Everything above scans the 161 block: the migration file, and the consolidated
// schema from the block's marker down to its tracker insert. During the GV-366 audit,
// a `grant select … to service_role` and an auth.users seeding INSERT appended AFTER
// that tracker — which is exactly where migration 162, 163, … will land in
// supabase-schema.sql — passed untouched. The block scan protects 161 from being
// EDITED; the additions the header promises to catch arrive OUTSIDE the block.
//
// So this section rescans every migration file and the whole consolidated schema for
// the properties that are safe to assert globally. It cannot use the forbidden-table
// scan globally (auth.users and ledger_members appear legitimately everywhere), so
// seeding is caught by shape instead: any statement that writes newsletter_subscribers,
// and any function whose body touches the table, is examined individually.
{
  const globAll = (dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => `${dir}/${f}`);
  const files = [...globAll("supabase/migrations"), "supabase-schema.sql"];
  const FORBIDDEN_SOURCES = ["auth.users", "ledger_members", "public.ledgers", "expo_push_tokens"];
  const ALLOWED_FUNCTIONS = new Set([
    ...RPCS,
    // GV-431 (migration 163): operator-only COUNTS for admin Health. Returns two
    // integers and nothing else; a count enumerates nobody. This line is the
    // deliberate decision the allowlist exists to force.
    "public.newsletter_subscriber_counts",
    // GV-433 (migration 165): the daily retention sweep deletes EXPIRED PENDING rows
    // (confirmed_at is null, older than the promised 7 days) and counts them. It can
    // never read an address out, and confirmed subscribers are untouched.
    "public.run_operational_retention",
    // GV-430 (migration 173): the send. This is the ONE function that reads addresses
    // OUT of the list, and the allowlist is doing exactly the job it was written for by
    // making that a line somebody had to add on purpose. It is admitted because a send
    // is the only operation that genuinely needs them, and because the alternative is
    // worse in law rather than merely in taste: markedsfoeringsloven paragraph 10 wants
    // every marketing mail to carry an opt-out that actually stops the mail, and an
    // exported address list is a copy nobody unsubscribes FROM. It is contained by the
    // grants (service_role only — see section 7) and it mints a FRESH unsubscribe token
    // per recipient rather than reading a stored one, because there is no stored one.
    "public.mint_newsletter_send_tokens",
  ]);

  // Prose stripped like the block scan strips it, but WITHOUT schemaStatementsOnly:
  // that helper truncates at the first tracker insert, which is correct for a sliced
  // block and cuts a whole file off at migration 001. Here every tracker insert is
  // removed in place instead (161's description argues about auth.users at length;
  // the standard skeleton always ends `applied_at = now();`, the anchor used here),
  // and comments go the same way as in the block scan.
  const stripGlobal = (sql) =>
    sql
      .replace(/insert into public\.fuel_ledger_schema_migrations[\s\S]*?applied_at = now\(\);/g, "")
      .replace(/\bcomment on [\s\S]*?\bis\s*'(?:[^']|'')*'\s*;/g, "")
      .split("\n")
      .map((line) => {
        const at = line.indexOf("--");
        return at === -1 ? line : line.slice(0, at);
      })
      .join("\n");

  for (const file of files) {
    const sql = stripGlobal(readFileSync(file, "utf8"));
    if (!/newsletter_subscribers/i.test(sql)) continue;
    const where = (what) => `${file}: ${what}`;

    // No grant on the table, to ANY role, anywhere.
    const grants = [
      ...sql.matchAll(/grant\s+[\s\S]{0,80}?\s+on\s+(?:table\s+)?(?:public\.)?newsletter_subscribers\s+to\s+(\w+)/gi),
    ];
    assert.deepEqual(
      grants.map((m) => m[1]),
      [],
      where("a GRANT on newsletter_subscribers (deny-all is the design, service_role included)"),
    );

    // No policy near the table name, anywhere.
    assert.ok(
      !/create\s+policy[\s\S]{0,400}newsletter_subscribers/i.test(sql),
      where("a policy on newsletter_subscribers — the table is not client-facing"),
    );

    // No tombstone column, anywhere, under any spelling that includes the word.
    assert.ok(
      !/unsubscribed_at/i.test(sql),
      where("an unsubscribed_at column — unsubscribing hard-deletes, it never flags"),
    );

    // Every statement that writes the table must not read a forbidden source. 800
    // chars bounds a single INSERT … SELECT; a seeding path too long for the window
    // would have to be a function, which the allowlist below catches.
    for (const m of sql.matchAll(/insert\s+into\s+(?:public\.)?newsletter_subscribers[\s\S]{0,800}?;/gi)) {
      for (const forbidden of FORBIDDEN_SOURCES) {
        assert.ok(
          !m[0].includes(forbidden),
          where(`a statement writes newsletter_subscribers from ${forbidden} — the list is never seeded from product users`),
        );
      }
    }

    // Every function whose body touches the table must be one of the three RPCs. A
    // seeding path, an export helper or an enumeration RPC added later is a NEW name.
    for (const m of sql.matchAll(/create\s+or\s+replace\s+function\s+((?:public\.)?[a-z0-9_]+)\s*\(([\s\S]*?)\$\$;/gi)) {
      const name = m[1].startsWith("public.") ? m[1] : `public.${m[1]}`;
      if (!/newsletter_subscribers/i.test(m[2])) continue;
      assert.ok(
        ALLOWED_FUNCTIONS.has(name),
        where(
          `function ${name} touches newsletter_subscribers. Only the three GV-366 RPCs may — ` +
            "a new function on this table is an owner decision and a new ticket, and it must be " +
            "added to ALLOWED_FUNCTIONS here on purpose",
        ),
      );
    }

    // The three RPCs stay server-only everywhere, including future re-declarations.
    assert.ok(
      !/grant execute on function (?:public\.)?newsletter_[a-z_]+\([^)]*\) to (anon|authenticated)\s*;/i.test(sql),
      where("a newsletter RPC granted to a browser role — only service_role may call these"),
    );
  }

  // Self-test: plant the two audit mutations at END OF FILE, where the block scan
  // cannot see them, and require the global scan to catch both.
  const schema = readFileSync("supabase-schema.sql", "utf8");
  const planted = {
    grant: stripGlobal(schema + "\ngrant select on public.newsletter_subscribers to service_role;\n"),
    seed: stripGlobal(
      schema +
        "\ninsert into public.newsletter_subscribers (email, consent_text_version, unsubscribe_token_hash)\n" +
        "select u.email, 'v1', md5(u.id::text || u.email) from auth.users u;\n",
    ),
  };
  assert.notDeepEqual(
    [...planted.grant.matchAll(/grant\s+[\s\S]{0,80}?\s+on\s+(?:table\s+)?(?:public\.)?newsletter_subscribers\s+to\s+(\w+)/gi)].map((m) => m[1]),
    [],
    "self-test: the global grant scan must fire on an EOF grant",
  );
  const seededWrites = [...planted.seed.matchAll(/insert\s+into\s+(?:public\.)?newsletter_subscribers[\s\S]{0,800}?;/gi)];
  assert.ok(
    seededWrites.some((m) => m[0].includes("auth.users")),
    "self-test: the global seeding scan must fire on an EOF insert-select from auth.users",
  );
}

// ── 7. The send (GV-430, migration 173) ──────────────────────────────────────
//
// Sending is where a consent design usually springs a leak, because a send is the one
// operation that needs the addresses and it is therefore the one place somebody reaches
// for "just export the list". Migration 173 refuses that and mints instead: a fresh
// unsubscribe token per recipient, the digest stored over the old one, the RAW token
// returned and written nowhere.
//
// Four properties carry that, and all four are the ABSENT shape section 1's header
// describes — a stored raw token, a browser-callable grant, an unconfirmed recipient, a
// recipient address in the audit log. None of them can be caught by a matrix case,
// because each would arrive as an addition. So they are read out of the file, here, in
// the migration and in the consolidated mirror alike.
{
  const SEND_SOURCES = [
    ["supabase/migrations/173_newsletter_send_tokens.sql", null],
    [
      "supabase-schema.sql",
      "-- Migration 173: mint per-send unsubscribe tokens + a counts-only send log (GV-430)",
    ],
  ];
  const SEND_LOG = "public.newsletter_send_log";
  const MINT = "public.mint_newsletter_send_tokens";

  // The signature govehlo-web's send endpoint is written against. Pinned verbatim
  // because a rename or a reordered parameter is a PGRST202 the platform CI cannot see
  // — only the umbrella can, and only after both halves have merged.
  const MINT_SIGNATURE =
    "create or replace function public.mint_newsletter_send_tokens(\n" +
    "  p_operator_email text,\n" +
    "  p_headline text\n" +
    ")\n" +
    "returns table(email text, unsubscribe_token text)";

  // Top-level column names of a create-table block. Used to assert what the send log
  // holds POSITIVELY — "no column called recipient_email" is a game of whack-a-mole,
  // "these five and nothing else" is the property.
  //
  // Everything from the first `constraint` line onward is dropped rather than filtered
  // line by line: a named check constraint wraps over several lines, and its
  // continuations ("and operator_email ~ …") would otherwise read as columns called
  // `and`. Columns before constraints is the ordering this schema already uses
  // everywhere, and an added column that hides after a constraint fails this assertion
  // rather than sneaking past it, which is the right way round.
  function tableColumns(sql, table) {
    const at = sql.indexOf(`create table if not exists ${table} (`);
    assert.notEqual(at, -1, `${table} is not created here`);
    const end = sql.indexOf("\n);", at);
    assert.notEqual(end, -1, `${table}'s create-table block is unterminated`);
    const lines = sql
      .slice(sql.indexOf("(", at) + 1, end)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("--"));
    const firstConstraint = lines.findIndex((line) => line.startsWith("constraint"));
    return (firstConstraint === -1 ? lines : lines.slice(0, firstConstraint)).map((line) => line.split(/\s+/)[0]);
  }

  let sendChecked = 0;
  for (const source of SEND_SOURCES) {
    const { file, sql: raw } = load(source);
    const sql = schemaStatementsOnly(raw);
    const where = (what) => `${file}: ${what}`;

    // (a) The grants. service_role only — this is the containment for admitting a
    // function that reads addresses out at all, and restating anon explicitly is the
    // migration 148 pattern: Supabase's default privileges grant EXECUTE on new
    // functions to anon AND authenticated, so a missing revoke is a public endpoint.
    assert.ok(sql.includes(MINT_SIGNATURE), where(`${MINT}'s signature has changed — govehlo-web's send endpoint is written against it verbatim`));
    assert.match(
      sql,
      new RegExp(`create or replace function ${MINT}\\([\\s\\S]*?security\\s+definer[\\s\\S]*?set\\s+search_path\\s*=\\s*public`, "i"),
      where(`${MINT} must be security definer with a pinned search_path — both tables deny its callers`),
    );
    for (const role of ["public", "anon", "authenticated"]) {
      assert.match(
        sql,
        new RegExp(`revoke all on function ${MINT}\\([^)]*\\) from ${role}\\s*;`, "i"),
        where(`${MINT} is still executable by ${role}. It hands out every confirmed address on the list`),
      );
    }
    assert.match(
      sql,
      new RegExp(`grant execute on function ${MINT}\\([^)]*\\) to service_role\\s*;`, "i"),
      where(`${MINT} must be granted to service_role — the operator endpoint's identity`),
    );
    assert.ok(
      !new RegExp(`grant execute on function ${MINT}\\([^)]*\\) to (anon|authenticated)\\s*;`, "i").test(sql),
      where(
        `${MINT} is granted to a browser role. Only the server may mint a send — and keeping ` +
          "it off authenticated is also what keeps it outside the GV-379 role-matrix coverage " +
          "scope, which tracks authenticated-executable functions",
      ),
    );

    // (b) Minting ROTATES. The stored digest is overwritten by a digest of freshly
    // generated bytes, so the previous send's links stop working — and, the half that
    // matters for a dump, the raw token is never what gets stored.
    assert.match(
      sql,
      /encode\(extensions\.gen_random_bytes\(32\), 'hex'\) as raw_token/,
      where("the mint no longer generates a fresh token — a send that reuses the stored digest cannot, since the raw token it came from was never kept"),
    );
    assert.match(
      sql,
      /as materialized \(/,
      where(
        "the token CTE is no longer MATERIALIZED. An inlined CTE evaluates the random " +
          "expression twice, storing the digest of a token the caller never receives — a " +
          "subscriber whose unsubscribe link does not work",
      ),
    );
    const assignments = [...sql.matchAll(/unsubscribe_token_hash\s*=\s*([^\n]*)/g)].map((m) => m[1].trim());
    assert.notEqual(assignments.length, 0, where("nothing writes unsubscribe_token_hash — the mint is not rotating anything"));
    for (const value of assignments) {
      assert.ok(
        value.startsWith("encode(extensions.digest("),
        where(
          `unsubscribe_token_hash is assigned '${value}'. It may only ever hold a digest: the ` +
            "raw token exists in the result set and nowhere else, which is what keeps a database " +
            "dump unable to unsubscribe anybody (migration 161)",
        ),
      );
    }
    assert.ok(
      !/insert\s+into\s+(?:public\.)?newsletter_subscribers/i.test(sql),
      where("the send writes rows INTO the subscriber list. A send may only rotate a digest; it may never add an address"),
    );

    // (c) Only confirmed rows are handed out. An unconfirmed row is somebody who never
    // clicked the link — quite possibly an address a third party typed — and mailing
    // them anything but that one confirmation is what the double opt-in exists to stop.
    // There is no unsubscribed state to exclude: migration 161 hard-deletes.
    assert.match(
      sql,
      /from public\.newsletter_subscribers ns\s+where ns\.confirmed_at is not null/,
      where("the mint no longer restricts itself to CONFIRMED subscribers — that is the double opt-in undone at the last step"),
    );
    assert.ok(
      !/confirmed_at is null/i.test(sql),
      where("the send block reasons about UNCONFIRMED rows. Nothing in a send may touch them"),
    );

    // (d) Deny-all, on the audit table as much as on the list it audits.
    assert.match(
      sql,
      new RegExp(`alter\\s+table\\s+${SEND_LOG}\\s+enable\\s+row\\s+level\\s+security`, "i"),
      where("RLS must be enabled on the send log"),
    );
    assert.ok(
      !/create\s+policy[\s\S]{0,400}newsletter_send_log/i.test(sql),
      where("a policy on newsletter_send_log — the audit trail of a marketing programme is not client-facing"),
    );
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.match(
        sql,
        new RegExp(`revoke\\s+all\\s+on\\s+${SEND_LOG}\\s+from\\s+${role}\\s*;`, "i"),
        where(
          `revoke all on ${SEND_LOG} from ${role} is missing` +
            (role === "service_role"
              ? " — service_role runs the marketing programme, and the code that runs it must not be able to rewrite its own audit trail"
              : ""),
        ),
      );
    }
    for (const table of [TABLE, SEND_LOG]) {
      const grants = [...sql.matchAll(new RegExp(`grant\\s+[\\s\\S]{0,80}?\\s+on\\s+(?:table\\s+)?${table}\\s+to\\s+(\\w+)`, "gi"))];
      assert.deepEqual(grants.map((m) => m[1]), [], where(`a GRANT on ${table}. Both tables are deny-all, service_role included`));
    }

    // (e) The audit row is COUNTS ONLY. A per-recipient send log would rebuild the
    // mailing history migration 161 declined to keep, and — worse — it would survive the
    // unsubscribe DELETE, which is the one thing that must never happen to the address
    // of somebody who asked us to stop.
    assert.deepEqual(
      tableColumns(sql, SEND_LOG),
      ["id", "operator_email", "headline", "recipient_count", "created_at"],
      where(
        "newsletter_send_log's columns have changed. It records who sent, what it was " +
          "called, HOW MANY and when — and nothing else. No recipient address, no foreign " +
          "key to the list, no token",
      ),
    );
    const logInserts = [...sql.matchAll(/insert into public\.newsletter_send_log \(([^)]*)\)/g)].map((m) =>
      m[1].split(",").map((c) => c.trim()),
    );
    assert.deepEqual(
      logInserts,
      [["operator_email", "headline", "recipient_count"]],
      where("the send log is written with a different column list than the counts-only three"),
    );

    sendChecked++;
  }
  assert.equal(sendChecked, SEND_SOURCES.length, "the send flow must be checked in the migration AND the consolidated mirror");

  // The send log's deny-all posture, GLOBALLY — same reasoning as section 6. The block
  // scan protects 173 from being edited; a `grant select on newsletter_send_log to
  // service_role` appended by migration 180 lands outside it.
  {
    const files = [
      ...readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).map((f) => `supabase/migrations/${f}`),
      "supabase-schema.sql",
    ];
    for (const file of files) {
      const sql = readFileSync(file, "utf8")
        .replace(/insert into public\.fuel_ledger_schema_migrations[\s\S]*?applied_at = now\(\);/g, "")
        .replace(/\bcomment on [\s\S]*?\bis\s*'(?:[^']|'')*'\s*;/g, "")
        .split("\n")
        .map((line) => (line.indexOf("--") === -1 ? line : line.slice(0, line.indexOf("--"))))
        .join("\n");
      if (!/newsletter_send_log/i.test(sql)) continue;
      const grants = [...sql.matchAll(/grant\s+[\s\S]{0,80}?\s+on\s+(?:table\s+)?(?:public\.)?newsletter_send_log\s+to\s+(\w+)/gi)];
      assert.deepEqual(grants.map((m) => m[1]), [], `${file}: a GRANT on newsletter_send_log (deny-all is the design, service_role included)`);
      assert.ok(
        !/create\s+policy[\s\S]{0,400}newsletter_send_log/i.test(sql),
        `${file}: a policy on newsletter_send_log — it is not client-facing`,
      );
      // The block scan pins the column list where the table is created; the way a
      // recipient column arrives LATER is an ALTER in migration 180.
      assert.ok(
        !/alter\s+table\s+(?:public\.)?newsletter_send_log\s+add\s+column/i.test(sql),
        `${file}: a column is added to newsletter_send_log. The audit row is counts only — a per-recipient column here would outlive the unsubscribe DELETE, which is the one thing that must never happen to the address of somebody who asked us to stop`,
      );
      assert.ok(
        !/grant execute on function (?:public\.)?mint_newsletter_send_tokens\([^)]*\) to (anon|authenticated)\s*;/i.test(sql),
        `${file}: the send RPC is granted to a browser role — only service_role may mint a send`,
      );
    }
  }

  // Self-test, same contract as the one above section 6: every assertion passes on a
  // clean tree, which is also what a typo in a regex produces. So plant the three
  // mutations that would actually hurt and require the scanners to see them.
  {
    const clean = schemaStatementsOnly(readFileSync("supabase/migrations/173_newsletter_send_tokens.sql", "utf8"));

    const stored = clean.replace(
      "set unsubscribe_token_hash = encode(extensions.digest(f.raw_token, 'sha256'), 'hex')",
      "set unsubscribe_token_hash = f.raw_token",
    );
    assert.ok(
      [...stored.matchAll(/unsubscribe_token_hash\s*=\s*([^\n]*)/g)].some((m) => !m[1].trim().startsWith("encode(extensions.digest(")),
      "self-test: storing the RAW token must be visible to the assignment scan",
    );

    const widened = clean.replace("where ns.confirmed_at is not null", "where true");
    assert.ok(
      !/from public\.newsletter_subscribers ns\s+where ns\.confirmed_at is not null/.test(widened),
      "self-test: dropping the confirmed-only predicate must fail the recipient scan",
    );

    const leaky = clean.replace(
      "  recipient_count integer not null,",
      "  recipient_count integer not null,\n  recipient_email text,",
    );
    assert.notDeepEqual(
      tableColumns(leaky, "public.newsletter_send_log"),
      ["id", "operator_email", "headline", "recipient_count", "created_at"],
      "self-test: a recipient address added to the send log must fail the column-list assertion",
    );
  }
}

console.log(
  "✅ test-newsletter-consent-contract: newsletter list is standalone, deny-all and tombstone-free; " +
    "the send mints rotating tokens, hands out confirmed addresses only, and logs counts.",
);
