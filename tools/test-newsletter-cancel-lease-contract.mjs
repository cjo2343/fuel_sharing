// Anti-drift contract for the cancel-mid-batch lease receipt (GV-470, migration 198).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// The durable newsletter send (179/181/185) is driven by govehlo-web's batch hook as
// claim -> mint -> Sweego fan-out -> advance. Cancelling anywhere inside that window used
// to throw away the only durable record of "these recipients have been processed": the
// cancel cleared the lease, the in-flight advance found a terminal job and moved nothing
// (181's deliberate quiet no-op), and a later retry — which resumes FROM THE CURSOR —
// re-minted and re-mailed the exact page that had already gone out. Migration 198 makes
// the surviving lease stamp a RECEIPT and hangs three behaviours off it. Every one of them
// is the kind a later tidy-up breaks without looking wrong in a diff:
//
//   1. CANCEL MUST NOT CLEAR claimed_at. It reads like leftover state; deleting that one
//      line restores the bug in full, silently, and nothing else in the schema complains.
//   2. THE RECONCILIATION MUST NOT RESURRECT. It writes the cursor of a CANCELLED job. If
//      it also moved status, or fell through to the done-branch, a cancelled campaign would
//      come back to life or would write the newsletter_send_log row 185 says it must not.
//   3. THE FENCE MUST EXPIRE. retry_ refuses while the receipt is fresh. A fence keyed on
//      anything other than a fixed past timestamp — a boolean flag, say — would strand a
//      job un-retryable forever, which is the exact GV-459 failure retry_ was added to end.
//
// And the property that ties them together is a NEGATIVE that no regex can see: after a
// cancel+advance+retry, the next mint must return the NEXT recipients, never the ones the
// cancelled batch already mailed. That needs a real Postgres, real subscribers and the real
// keyset arithmetic, so Part 2 drives the whole interleaving.
//
// ── What is pinned ──────────────────────────────────────────────────────────────
// Part 1 (static): the SHAPE of migration 198 and of its supabase-schema.sql mirror — that
//   cancel_ has no `claimed_at = null` left in it, that advance_ carries the narrow
//   `status = 'failed' and claimed_at is not null` reconciliation which clears the receipt
//   and never touches status/attempt_count, that retry_ carries the 55P03 fence with its
//   Danish sentence, the unchanged signatures, the restated ACLs, and the provenance chain
//   in the header. check-schema-equivalence proves the two files replay identically; this
//   proves the thing they both replay is the thing GV-470 decided.
// Part 2 (Docker): the BEHAVIOUR — the full t0..t7 interleaving from the migration header,
//   the cancel that has no batch in flight, the retry after a clean cancel, the fence and
//   its expiry, the retry-ceiling path that must stay fence-free, and the crashed hook that
//   must still be re-claimable.
//
// ── Modes ───────────────────────────────────────────────────────────────────────
//   node tools/test-newsletter-cancel-lease-contract.mjs            # warn on Docker
//   node tools/test-newsletter-cancel-lease-contract.mjs --strict   # umbrella / CI
//
// Without Docker the behavioural half is skipped and warns, exactly as
// test-double-completion-guard-contract.mjs does, so `npm run validate` stays
// dependency-free.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const STRICT = process.argv.includes("--strict");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = `govehlo-newsletter-cancel-${process.pid}`;
const DB = "dbnlcancel";

// The fence's SQLSTATE and its one Danish sentence, pinned so a reworded or re-coded
// refusal has to be a deliberate edit here too — govehlo-web's control endpoint maps the
// code to its own message, and a drifted code degrades to a generic 502.
const FENCE_SQLSTATE = "55P03";
const FENCE_SENTENCE = "udsendelsen har stadig en batch i gang - vent til den er afsluttet og prøv igen";

const warnings = [];
function warn(title, message) {
  if (STRICT) {
    process.stderr.write(`\n::error title=${title}::${message} (--strict)\n`);
    process.exit(1);
  }
  warnings.push(message);
  process.stdout.write(`::warning title=${title}::${message}\n`);
}

let checked = 0;
function pin(label, fn) {
  fn();
  checked += 1;
  process.stdout.write(`  ok - ${label}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part 1: the SHAPE (needs nothing)
// ═══════════════════════════════════════════════════════════════════════════════
const MIGRATION = join(ROOT, "supabase", "migrations", "198_newsletter_cancel_lease_safety.sql");
const CONSOLIDATED = join(ROOT, "supabase-schema.sql");
const migrationSql = readFileSync(MIGRATION, "utf8");
const consolidatedSql = readFileSync(CONSOLIDATED, "utf8");

// The consolidated schema carries every historical definition of these three functions, so
// a bare search proves nothing about which one WINS. Last definition wins on replay, so
// read only the tail from 198's own mirror header.
const mirrorIdx = consolidatedSql.lastIndexOf("-- ── Migration 198:");
assert.notEqual(mirrorIdx, -1, "supabase-schema.sql is missing the migration 198 mirror block");
// Bounded at 198's own tracker insert rather than end-of-file, so migration 199 appending
// after it neither leaks its statements into these assertions nor lets a later re-declaration
// of these three functions be judged by 198's copy. Slicing to EOF is only ever correct while
// the block under test is the newest one, which is a property that expires on the next PR —
// this file inherited that lesson from what 198 itself did to the migration-197 contract.
const mirrorEnd = consolidatedSql.indexOf("insert into public.fuel_ledger_schema_migrations", mirrorIdx);
assert.notEqual(mirrorEnd, -1, "supabase-schema.sql: migration 198's mirror has no tracker insert");

const sqlSources = {
  "migration 198": migrationSql,
  "supabase-schema.sql (198 tail)": consolidatedSql.slice(mirrorIdx, mirrorEnd),
};

/** One function's text, from its CREATE to the `$$;` that closes its body. */
function functionBody(sql, fn, name) {
  const at = sql.indexOf(`create or replace function public.${fn}(`);
  assert.notEqual(at, -1, `${name}: ${fn} is not declared here`);
  const end = sql.indexOf("\n$$;", at);
  assert.notEqual(end, -1, `${name}: ${fn}'s body is unterminated`);
  return sql.slice(at, end);
}

process.stdout.write("\nSQL shape (migration 198 + its supabase-schema.sql mirror):\n");
for (const [name, sql] of Object.entries(sqlSources)) {
  const cancel = functionBody(sql, "cancel_newsletter_send_job", name);
  const advance = functionBody(sql, "advance_newsletter_send_job", name);
  const retry = functionBody(sql, "retry_newsletter_send_job", name);

  pin(`${name}: cancel_ leaves the lease stamp alone — the whole fix rests on this line NOT existing`, () => {
    assert.ok(
      !/claimed_at\s*=\s*null/i.test(cancel),
      "cancel_newsletter_send_job must not clear claimed_at. A cleared lease is a lost receipt: the " +
        "in-flight worker's advance then finds a terminal job, the cursor never moves, and retry_ " +
        "re-mails the batch that already went out. This is the entire GV-470 bug in one assignment",
    );
    assert.match(
      cancel,
      /update public\.newsletter_send_jobs j\s*\n\s*set status = 'failed',\s*\n\s*updated_at = now\(\)/,
      "cancel must still be immediate and total — status flips to failed in one UPDATE, so claim_ " +
        "(pending/sending only) never touches the job again and the single-active slot frees at once",
    );
    assert.match(
      cancel,
      /'status', 'cancelled'/,
      "the 'status' key must survive verbatim — govehlo-web's control endpoint reads only that one",
    );
    assert.match(cancel, /'in_flight', v_in_flight/, "the console needs to know a batch was in flight");
  });

  pin(`${name}: advance_ reconciles a CANCELLED job — narrow, cursor-advancing, receipt-clearing`, () => {
    // The predicate is the whole safety argument: only a job that is terminal AND still
    // carries a lease stamp may be written by this branch. Widen it to any failed job and a
    // stray advance could push the cursor past recipients nobody ever mailed.
    assert.match(
      advance,
      /where j\.id = p_campaign_id\s*\n\s*and j\.status = 'failed'\s*\n\s*and j\.claimed_at is not null;/,
      "the reconciliation must key on the receipt — status = 'failed' AND claimed_at is not null — " +
        "because that combination means 'a worker was mid-batch when this was cancelled' and nothing else",
    );
    // It must move the cursor: that is the point. And it must use the SAME strictly-advancing
    // test as the active path, or a retried advance would move the cursor backwards.
    const reconcileAt = advance.indexOf("and j.status = 'failed'");
    const reconcile = advance.slice(advance.lastIndexOf("update public.newsletter_send_jobs j", reconcileAt), reconcileAt);
    assert.match(
      reconcile,
      /cursor_confirmed_at = case when p_last_confirmed_at is not null/,
      "the reconciliation must advance the cursor — a cancelled job whose cursor stays put is exactly " +
        "the state that makes retry_ re-mail an already-sent batch",
    );
    assert.match(
      reconcile,
      /\(p_last_confirmed_at, p_last_id\) > \(j\.cursor_confirmed_at, j\.cursor_id\)/,
      "the same strictly-advancing keyset test as the active path — a retried advance must add and move nothing",
    );
    assert.match(reconcile, /claimed_at = null/, "landing the batch clears the receipt, which lifts retry_'s fence");
    assert.ok(
      !/\bstatus = /.test(reconcile),
      "the reconciliation must NOT write status. It accounts for a batch; it does not un-cancel a campaign",
    );
    assert.ok(
      !/attempt_count|next_attempt_at/.test(reconcile),
      "a terminal job has no ticks left to count — touching the GV-459 retry bookkeeping here would " +
        "let a cancelled job's backoff leak into the retry that follows",
    );
  });

  pin(`${name}: a reconciled advance returns BEFORE the done-branch — no send-log row for a cancelled send`, () => {
    const reconciledReturn = advance.indexOf("if v_reconciled > 0 then");
    const doneBranch = advance.indexOf("insert into public.newsletter_send_log");
    assert.notEqual(reconciledReturn, -1, "the reconciliation must report whether it matched");
    assert.notEqual(doneBranch, -1, "the done-branch must still write the one send-log row");
    assert.ok(
      reconciledReturn < doneBranch,
      "the reconciliation must return before the done-branch. 185 is explicit that a cancelled campaign " +
        "did not complete and writes no newsletter_send_log row — however p_done arrives",
    );
    // ...and the absent-id error must still be reachable, after the reconciliation misses.
    assert.match(
      advance.slice(reconciledReturn),
      /raise exception 'no newsletter_send_jobs row for %', p_campaign_id using errcode = 'P0002';/,
      "a genuinely absent campaign id must still raise P0002 — the reconciliation may not swallow it",
    );
  });

  pin(`${name}: retry_ refuses while the receipt is fresh, under ${FENCE_SQLSTATE}, and the fence EXPIRES`, () => {
    assert.match(
      retry,
      new RegExp(
        `if v_claimed_at is not null and v_claimed_at > now\\(\\) - make_interval\\(secs => 300\\) then\\s*\\n\\s*raise exception '${FENCE_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' using errcode = '${FENCE_SQLSTATE}';`,
      ),
      "the fence must be a wall-clock comparison against the lease window. Keyed on anything that does " +
        "not lapse on its own — a boolean, a status — it would strand a job un-retryable forever, which " +
        "is the GV-459 failure retry_ exists to prevent",
    );
    // Ordering: a job that is not failed at all must still hear 22023 first, not the fence.
    assert.ok(
      retry.indexOf("kun en fejlet udsendelse kan genstartes") < retry.indexOf("v_claimed_at > now()"),
      "the not-failed refusal must still speak first — the fence is about WHEN, not about WHETHER",
    );
    assert.match(
      retry,
      /set status = 'pending',[\s\S]{0,200}?claimed_at = null/,
      "re-queueing still clears the lease, so a stale receipt cannot outlive the retry that consumed it",
    );
  });

  pin(`${name}: three unchanged signatures, restated ACLs, nothing dropped`, () => {
    // A second candidate signature is PGRST203 — PostgREST resolves neither and every hook
    // call fails. This migration adds no parameter, so create-or-replace is the whole change.
    assert.match(
      advance,
      /create or replace function public\.advance_newsletter_send_job\(\s*\n\s*p_campaign_id uuid,\s*\n\s*p_last_confirmed_at timestamptz,\s*\n\s*p_last_id uuid,\s*\n\s*p_sent_delta integer,\s*\n\s*p_failed_delta integer,\s*\n\s*p_done boolean,\s*\n\s*p_status_code integer default null\s*\n\)/,
    );
    for (const fn of ["cancel_newsletter_send_job", "retry_newsletter_send_job"]) {
      assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(\\s*\\n\\s*p_campaign_id uuid\\s*\\n\\)\\s*\\nreturns jsonb`));
      assert.doesNotMatch(sql, new RegExp(`^drop function.*${fn}`, "im"));
    }
    assert.doesNotMatch(sql, /^drop function.*advance_newsletter_send_job/im);
    for (const fn of ["advance_newsletter_send_job", "cancel_newsletter_send_job", "retry_newsletter_send_job"]) {
      for (const role of ["public", "anon", "authenticated"]) {
        assert.ok(
          new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from ${role};`).test(sql),
          `148's ACL convention: a re-declaration resets nothing, so revoke ${fn} from ${role} must be restated`,
        );
      }
      assert.ok(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`).test(sql),
        `${fn} must stay service_role only — these are hook/operator RPCs, never browser-callable`,
      );
      assert.ok(
        !new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to (anon|authenticated);`).test(sql),
        `${fn} must never be granted to a browser role`,
      );
    }
  });
}

pin("the header carries the provenance chain a re-declaration must be based on (GV-202)", () => {
  // The header is hard-wrapped prose, so match it unwrapped: strip the comment markers and
  // collapse whitespace. Otherwise this pin would be a test of where the lines happen to break.
  const header = migrationSql
    .slice(0, migrationSql.indexOf("create or replace function"))
    .replace(/^--\s?/gm, "")
    .replace(/\s+/g, " ");
  assert.match(
    header,
    /advance_newsletter_send_job: 179 -> 181 -> 185/,
    "the chain must be written down: advance_'s newest prior definition is 185, and re-declaring off " +
      "181 would silently drop GV-456's removed token prune and GV-459's retry ceiling",
  );
  assert.match(header, /cancel_ and retry_ were both introduced in 185/);
  assert.match(
    header,
    /claim_ \(newest 185\), mint_ and create_ \(newest 181\) and the two readers \(180, 191\) are NOT touched/,
    "the untouched functions must be named, so the next author knows the blast radius was considered",
  );
});

pin("no column, index, policy or grant change — this is bodies only, so types/database.ts is unchanged", () => {
  for (const forbidden of [/\balter table\b/i, /\bcreate (unique )?index\b/i, /\bcreate policy\b/i, /\badd column\b/i]) {
    assert.ok(
      !forbidden.test(migrationSql.replace(/^--.*$/gm, "").replace(/insert into public\.fuel_ledger_schema_migrations[\s\S]*$/, "")),
      `migration 198 must not ${forbidden} — a schema change here would need regenerated + re-vendored types, ` +
        "and the fix deliberately encodes the receipt in a column that already exists",
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2: behaviour, on a real Postgres
// ═══════════════════════════════════════════════════════════════════════════════
let dockerUp = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
  dockerUp = true;
} catch {
  dockerUp = false;
}

if (!dockerUp) {
  warn(
    "Newsletter cancel-lease behaviour not checked",
    "Docker is unavailable, so the claim/mint/cancel/advance/retry interleaving was NOT executed. The " +
      "double-send refusal, the fence and its expiry, and the untouched retry-ceiling path were skipped " +
      "on this run.",
  );
  report();
} else {
  let finished = false;
  process.on("exit", () => {
    if (!finished) removeContainer(CONTAINER);
  });

  function fail(message) {
    process.stderr.write(`\n❌ newsletter cancel-lease contract: ${message}\n`);
    removeContainer(CONTAINER);
    process.exit(1);
  }

  function raw(sql, args = []) {
    const res = psql(CONTAINER, DB, [...args, "-c", sql]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
    return res.stdout.trim();
  }
  const scalar = (sql) => raw(sql, ["-t", "-A"]);

  /** Run `sql`; returns { sqlstate, message } — 'OK' for both when it passed. */
  function attempt(sql) {
    const wrapped = `
do $$
begin
  ${sql}
  raise notice 'GVSTATE:OK|OK';
exception when others then
  raise notice 'GVSTATE:%|%', sqlstate, sqlerrm;
end $$;`;
    const res = psql(CONTAINER, DB, ["-c", wrapped]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${wrapped}`);
    const match = `${res.stdout}\n${res.stderr}`.match(/GVSTATE:([^|]*)\|(.*)/);
    if (!match) fail(`Could not read a SQLSTATE back from:\n${wrapped}`);
    return { sqlstate: match[1].trim(), message: match[2].trim() };
  }

  try {
    startPostgres(CONTAINER, ROOT);
    createDbWithPrelude(CONTAINER, DB);
  } catch (error) {
    fail(error.message);
  }

  {
    const applied = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
    if (applied.status !== 0) fail(`Consolidated schema failed to apply:\n${applied.stderr}`);
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────────
  // Six confirmed subscribers, confirmed one minute apart so the keyset ordering is
  // unambiguous and a batch of two is a clean, checkable page. They are seeded directly
  // rather than through the signup RPCs because this suite is about the JOB, not consent —
  // and confirmed_at has to be a controlled, spread-out sequence for the cursor to mean
  // anything. postgres owns the table, so RLS and the revokes do not stand in the way.
  const seed = `
insert into public.newsletter_subscribers (email, requested_at, confirmed_at, consent_text_version)
select
  'sub' || n || '@example.dk',
  now() - interval '2 days',
  now() - interval '1 day' + (n || ' minute')::interval,
  '2026-08-01'
from generate_series(1, 6) as n;
`;
  {
    const res = psql(CONTAINER, DB, ["-c", seed]);
    if (res.status !== 0) fail(`Seeding subscribers failed:\n${res.stderr}`);
  }

  const OPERATOR = "cjo@govehlo.dk";

  /** Create a campaign and return its id. */
  function createJob(headline) {
    return scalar(
      `select public.create_newsletter_send_job('${headline}', 'Hej', '[]'::jsonb, '${OPERATOR}');`,
    );
  }
  /** One scheduler tick's claim. Returns the claimed job id, or '' for nothing due. */
  function claim() {
    return scalar(`select coalesce((select id::text from public.claim_due_newsletter_send_job(300)), '');`);
  }
  /**
   * One tick's mint, as the hook does it: read the job's own cursor, take the next page.
   * Returns the batch as an array of { email, confirmedAt, id }.
   */
  function mint(job, limit = 2) {
    const rows = scalar(
      `select coalesce(string_agg(email || '~' || subscriber_confirmed_at::text || '~' || subscriber_id::text, '|' order by subscriber_confirmed_at, subscriber_id), '')
         from public.mint_newsletter_send_batch(
           '${job}'::uuid,
           (select cursor_confirmed_at from public.newsletter_send_jobs where id = '${job}'::uuid),
           (select cursor_id from public.newsletter_send_jobs where id = '${job}'::uuid),
           (select ceiling_at from public.newsletter_send_jobs where id = '${job}'::uuid),
           ${limit});`,
    );
    if (!rows) return [];
    return rows.split("|").map((row) => {
      const [email, confirmedAt, id] = row.split("~");
      return { email, confirmedAt, id };
    });
  }
  /** The hook's cursor advance after a mailed batch. */
  function advanceBatch(job, batch, { sent = batch.length, failed = 0 } = {}) {
    const last = batch[batch.length - 1];
    return attempt(
      `perform public.advance_newsletter_send_job('${job}'::uuid, '${last.confirmedAt}'::timestamptz,
         '${last.id}'::uuid, ${sent}, ${failed}, false, null);`,
    );
  }
  /** The hook's pure lease-release (a tick that mailed nobody). */
  const releaseLease = (job, code = "null") =>
    attempt(`perform public.advance_newsletter_send_job('${job}'::uuid, null, null, 0, 0, false, ${code});`);
  /** The hook's drained/done advance. */
  const advanceDone = (job) =>
    attempt(`perform public.advance_newsletter_send_job('${job}'::uuid, null, null, 0, 0, true, null);`);

  const cancel = (job) => scalar(`select public.cancel_newsletter_send_job('${job}'::uuid)::text;`);
  const retry = (job) => attempt(`perform public.retry_newsletter_send_job('${job}'::uuid);`);
  const jobField = (job, column) =>
    scalar(`select coalesce(${column}::text, 'NULL') from public.newsletter_send_jobs where id = '${job}'::uuid;`);
  const sendLogRows = (headline) =>
    scalar(`select count(*) from public.newsletter_send_log where headline = '${headline}';`);
  /** Push a job's lease stamp into the past — a worker that died and never reported. */
  const ageLease = (job, seconds) =>
    raw(`update public.newsletter_send_jobs set claimed_at = now() - make_interval(secs => ${seconds})
           where id = '${job}'::uuid;`);

  // ── 1. The interleaving from the migration header, end to end ───────────────
  process.stdout.write("\nt0..t7 — cancel lands between the fan-out and the advance:\n");

  const job1 = createJob("Nyhedsbrev A");
  let batch1;

  pin("t0/t1: the tick claims the job and mints the first page of two", () => {
    assert.equal(claim(), job1);
    assert.equal(jobField(job1, "status"), "sending");
    batch1 = mint(job1);
    assert.deepEqual(
      batch1.map((r) => r.email),
      ["sub1@example.dk", "sub2@example.dk"],
      "the keyset starts at the oldest confirmation",
    );
  });

  pin("t3: the operator cancels — immediate, terminal, and it KEEPS the lease stamp", () => {
    const result = JSON.parse(cancel(job1));
    assert.equal(result.status, "cancelled");
    assert.equal(result.in_flight, true, "the console must be told a batch was still running");
    assert.ok(result.retry_after, "and when it may retry");
    assert.equal(jobField(job1, "status"), "failed", "the single-active slot frees at once");
    assert.notEqual(jobField(job1, "claimed_at"), "NULL", "the receipt is what makes the rest of this possible");
    assert.equal(claim(), "", "and claim_ never touches a terminal job again — no further batch is minted");
  });

  pin("t5-early: retry is REFUSED while the batch is unaccounted for", () => {
    const refused = retry(job1);
    assert.equal(refused.sqlstate, FENCE_SQLSTATE);
    assert.equal(refused.message, FENCE_SENTENCE);
    assert.equal(jobField(job1, "status"), "failed", "a refused retry re-activates nothing");
  });

  pin("t4: the in-flight advance still lands — the cursor moves on a CANCELLED job", () => {
    assert.deepEqual(advanceBatch(job1, batch1), { sqlstate: "OK", message: "OK" });
    assert.equal(jobField(job1, "cursor_id"), batch1[1].id, "the page that was mailed is now recorded");
    assert.equal(jobField(job1, "sent_count"), "2");
    assert.equal(jobField(job1, "status"), "failed", "reconciliation is not resurrection");
    assert.equal(jobField(job1, "claimed_at"), "NULL", "and the receipt is consumed");
    assert.equal(jobField(job1, "attempt_count"), "0", "the GV-459 tick bookkeeping is left alone");
  });

  pin("t5: retry is allowed the moment the batch is accounted for", () => {
    assert.deepEqual(retry(job1), { sqlstate: "OK", message: "OK" });
    assert.equal(jobField(job1, "status"), "pending");
  });

  pin("t6: THE FIX — the next mint returns the NEXT recipients, not the ones already mailed", () => {
    assert.equal(claim(), job1);
    const batch2 = mint(job1);
    assert.deepEqual(
      batch2.map((r) => r.email),
      ["sub3@example.dk", "sub4@example.dk"],
      "before migration 198 the cancelled cursor stayed at zero and this page was sub1+sub2 — the same " +
        "two people receiving the campaign a second time",
    );
    assert.deepEqual(advanceBatch(job1, batch2), { sqlstate: "OK", message: "OK" });
  });

  pin("the cancelled-then-resumed campaign still completes exactly once, with ONE send-log row", () => {
    const batch3 = mint(job1);
    assert.deepEqual(batch3.map((r) => r.email), ["sub5@example.dk", "sub6@example.dk"]);
    assert.deepEqual(advanceBatch(job1, batch3), { sqlstate: "OK", message: "OK" });
    assert.deepEqual(mint(job1), [], "drained");
    assert.deepEqual(advanceDone(job1), { sqlstate: "OK", message: "OK" });
    assert.equal(jobField(job1, "status"), "done");
    assert.equal(sendLogRows("Nyhedsbrev A"), "1", "one row per campaign, cancel or no cancel");
    assert.equal(jobField(job1, "sent_count"), "6", "and every subscriber counted once");
  });

  // ── 2. A cancelled campaign never writes a send-log row ─────────────────────
  process.stdout.write("\nA cancel that is never retried:\n");

  pin("a done advance arriving after a cancel neither completes the job nor writes a log row", () => {
    const job = createJob("Nyhedsbrev B");
    assert.equal(claim(), job);
    JSON.parse(cancel(job));
    assert.deepEqual(advanceDone(job), { sqlstate: "OK", message: "OK" }, "the hook's drained tick is not an error");
    assert.equal(jobField(job, "status"), "failed", "p_done must not resurrect a cancelled campaign");
    assert.equal(sendLogRows("Nyhedsbrev B"), "0", "185: a cancelled campaign did not complete");
    assert.equal(jobField(job, "claimed_at"), "NULL", "but the receipt is still consumed, so retry is unblocked");
    assert.deepEqual(retry(job), { sqlstate: "OK", message: "OK" });
    JSON.parse(cancel(job));
  });

  // ── 3. Cancel with nothing in flight — the common case, unchanged ───────────
  process.stdout.write("\nCancel with no batch claimed:\n");

  pin("a pending job cancelled before any tick reports no receipt and retries immediately", () => {
    const job = createJob("Nyhedsbrev C");
    const result = JSON.parse(cancel(job));
    assert.equal(result.status, "cancelled");
    assert.equal(result.in_flight, false, "nothing was ever claimed, so nothing is unaccounted for");
    assert.equal(result.retry_after, null);
    assert.equal(jobField(job, "claimed_at"), "NULL");
    assert.deepEqual(retry(job), { sqlstate: "OK", message: "OK" }, "no fence, no wait");
    assert.equal(jobField(job, "status"), "pending");
    assert.equal(jobField(job, "cursor_id"), "NULL", "and it resumes from the start, because nothing went out");
    JSON.parse(cancel(job));
  });

  pin("cancelling an already-terminal job is still the quiet noop, and an unknown id still raises", () => {
    const job = createJob("Nyhedsbrev D");
    JSON.parse(cancel(job));
    assert.equal(JSON.parse(cancel(job)).status, "noop");
    const unknown = attempt(
      `perform public.cancel_newsletter_send_job('00000000-0000-0000-0000-0000000000ff'::uuid);`,
    );
    assert.equal(unknown.sqlstate, "P0002");
  });

  // ── 4. The fence expires — no job is ever stranded ──────────────────────────
  process.stdout.write("\nThe worker that never reported:\n");

  pin("a receipt older than the lease window stops fencing, so retry always becomes possible", () => {
    const job = createJob("Nyhedsbrev E");
    assert.equal(claim(), job);
    JSON.parse(cancel(job));
    assert.equal(retry(job).sqlstate, FENCE_SQLSTATE, "fresh receipt: wait");
    ageLease(job, 301);
    assert.deepEqual(
      retry(job),
      { sqlstate: "OK", message: "OK" },
      "past the lease window the worker is presumed dead — exactly as claim_ presumes when it re-claims " +
        "a stale lease. A fence that could not lapse would strand the job un-retryable forever (GV-459)",
    );
    assert.equal(jobField(job, "claimed_at"), "NULL", "and the retry consumes the stale receipt");
    JSON.parse(cancel(job));
  });

  pin("an advance from a long-dead worker whose receipt was consumed is still a quiet no-op", () => {
    const job = createJob("Nyhedsbrev F");
    assert.equal(claim(), job);
    const batch = mint(job);
    JSON.parse(cancel(job));
    raw(`update public.newsletter_send_jobs set claimed_at = null where id = '${job}'::uuid;`);
    assert.deepEqual(advanceBatch(job, batch), { sqlstate: "OK", message: "OK" }, "not an error under at-least-once");
    assert.equal(jobField(job, "cursor_id"), "NULL", "and with no receipt it writes nothing — the narrow predicate holds");
    JSON.parse(cancel(job));
  });

  pin("an advance for a campaign id that does not exist still raises P0002", () => {
    const unknown = attempt(
      `perform public.advance_newsletter_send_job('00000000-0000-0000-0000-0000000000ff'::uuid,
         null, null, 0, 0, false, null);`,
    );
    assert.equal(unknown.sqlstate, "P0002");
  });

  // ── 5. GV-459's retry ceiling is untouched ──────────────────────────────────
  process.stdout.write("\nThe stuck job that fails itself (GV-459), which must not grow a fence:\n");

  pin("five no-progress ticks still fail the job — and it carries no receipt, so retry is immediate", () => {
    const job = createJob("Nyhedsbrev G");
    for (let tick = 1; tick <= 5; tick += 1) {
      assert.equal(claim(), job, `tick ${tick} must be claimable`);
      assert.deepEqual(releaseLease(job, 502), { sqlstate: "OK", message: "OK" });
      // The GV-459 backoff pushes next_attempt_at out; a real scheduler waits, this does not.
      raw(`update public.newsletter_send_jobs set next_attempt_at = null where id = '${job}'::uuid;`);
    }
    assert.equal(jobField(job, "status"), "failed", "the ceiling still frees the single-active slot");
    assert.equal(jobField(job, "attempt_count"), "5");
    assert.equal(
      jobField(job, "claimed_at"),
      "NULL",
      "the UPDATE that failed it cleared the lease, so a ceiling-failed job is NOT a cancelled-mid-batch job",
    );
    assert.deepEqual(retry(job), { sqlstate: "OK", message: "OK" }, "and retry is available with no wait");
    assert.equal(jobField(job, "attempt_count"), "0");
    JSON.parse(cancel(job));
  });

  pin("a crashed hook that never cancelled is still re-claimable once its lease expires", () => {
    const job = createJob("Nyhedsbrev H");
    assert.equal(claim(), job);
    mint(job); // ...and then the Worker dies. No advance, no cancel.
    assert.equal(claim(), "", "inside the lease the job is nobody else's");
    ageLease(job, 301);
    assert.equal(claim(), job, "past it the next tick takes over — a crash delays a send, it never wedges one");
    assert.equal(jobField(job, "status"), "sending", "and it is still an ACTIVE job, so no receipt semantics apply");
    JSON.parse(cancel(job));
  });

  pin("retry on a job that is still running is refused as not-retryable, not as fenced", () => {
    const job = createJob("Nyhedsbrev I");
    assert.equal(claim(), job);
    const refused = retry(job);
    assert.equal(refused.sqlstate, "22023", "an ACTIVE job is not a failed one — the fence must not shadow this");
    assert.equal(refused.message, "kun en fejlet udsendelse kan genstartes");
    JSON.parse(cancel(job));
  });

  finished = true;
  removeContainer(CONTAINER);
  report();
}

function report() {
  process.stdout.write(`\n✅ newsletter cancel-lease contract: ${checked} pins held.\n`);
  if (warnings.length > 0) {
    process.stdout.write(`⚠️  ${warnings.length} half(s) could not be checked on this run.\n`);
  }
}
