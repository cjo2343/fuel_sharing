// Anti-drift contract for the newsletter send's lease OWNER token (GV-491, migration 208).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// govehlo-web's batch hook drives one campaign batch per invocation: claim (a 300s lease) ->
// mint 20 -> for each chunk of 5, Sweego fan-out then advance. GV-486 introduced the
// per-chunk advance to shrink the crash-duplicate window from a batch to a chunk, because
// Sweego has NO idempotency mechanism (GV-464). But advance_newsletter_send_job had nulled
// claimed_at at EVERY call since 179, when there was one advance per invocation and releasing
// at the end was the whole point — so from GV-486 onwards the FIRST checkpoint handed the job
// back while the invocation was still mailing, the next */5 tick claimed it legitimately,
// minted from the advanced cursor, and mailed the same people a second time.
//
// Migration 208 gives the lease an OWNER: claim_ mints a lease_token, advance_ is fenced on
// it, and a mid-batch checkpoint KEEPS the lease instead of handing it away. Every part of
// that is the kind a later tidy-up breaks without looking wrong in a diff:
//
//   1. THE CHECKPOINT MUST NOT RELEASE. `claimed_at = null` reads like the obvious thing an
//      advance does — it was, for four migrations. Restoring that one line restores GV-491 in
//      full, silently, and no other object in the schema complains.
//   2. THE FENCE MUST BE ON BOTH UPDATES. A fence on the active-job UPDATE alone still lets a
//      worker that lost its lease write the cursor of a CANCELLED job through 198's
//      reconciliation branch.
//   3. A STALE OWNER MUST BE TOLD, NOT RAISED AT. The hook has to distinguish "you lost the
//      lease, stop mailing" from "the job finished" and from a transport error. An exception
//      would be indistinguishable from a failed advance and would take the invocation with it.
//   4. LEGACY CALLS MUST BE UNTOUCHED. p_lease_token null is what lets the SQL be applied
//      BEFORE the govehlo-web deploy. If a null token started fencing, or started holding the
//      lease, the currently-deployed hook would wedge every campaign for a lease window.
//
// And the property that ties them together is a NEGATIVE no regex can see: while one worker
// holds a live lease, a second tick's claim must return NOTHING, and a stale worker's advance
// must move no cursor and no counts. That needs a real Postgres and the real keyset
// arithmetic, so Part 2 drives the whole two-worker interleaving.
//
// ── What is pinned ──────────────────────────────────────────────────────────────
// Part 1 (static): the SHAPE of migration 208 and of its supabase-schema.sql mirror — the
//   lease_token column, claim_ minting one, the owner fence on BOTH of advance_'s UPDATEs,
//   the four-part hold condition, the dropped 7-argument signature with its ACLs restated on
//   the 9-argument one, retry_ nulling the token, cancel_ deliberately NOT re-declared, and
//   the provenance chain in the header. check-schema-equivalence proves the two files replay
//   identically; this proves the thing they both replay is the thing GV-491 decided.
// Part 2 (Docker): the BEHAVIOUR — a checkpoint that holds, an overlapping claim that gets
//   nothing, a stale-token advance that writes nothing and says so, an explicit release that
//   frees the job, the 198 cancel receipt reconciling for the OWNER and not for a stale
//   worker, retry_ dropping the old owner, and the legacy null-token path byte-for-byte as it
//   was.
//
// ── Modes ───────────────────────────────────────────────────────────────────────
//   node tools/test-newsletter-lease-token-contract.mjs            # warn on Docker
//   node tools/test-newsletter-lease-token-contract.mjs --strict   # umbrella / CI
//
// Without Docker the behavioural half is skipped and warns, exactly as
// test-newsletter-cancel-lease-contract.mjs does, so `npm run validate` stays
// dependency-free.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const STRICT = process.argv.includes("--strict");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = `govehlo-newsletter-lease-${process.pid}`;
const DB = "dbnllease";

// The one status string govehlo-web's hook branches on. It stops the fan-out on anything that
// is not 'advanced', but THIS value is the one that means "another worker owns the job now",
// so a rename here has to be a deliberate edit in both repos.
const STALE = "stale_lease";

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
const MIGRATION = join(ROOT, "supabase", "migrations", "208_newsletter_lease_owner_token.sql");
const CONSOLIDATED = join(ROOT, "supabase-schema.sql");
const migrationSql = readFileSync(MIGRATION, "utf8");
const consolidatedSql = readFileSync(CONSOLIDATED, "utf8");

// The consolidated schema carries every historical definition of these functions, so a bare
// search proves nothing about which one WINS. Last definition wins on replay, so read only
// the tail from 208's own mirror header — and bound it at 208's tracker insert rather than
// end-of-file, so a later migration appending after it neither leaks into these assertions
// nor gets judged by 208's copy (the lesson this file inherits from the 198 contract).
const mirrorIdx = consolidatedSql.lastIndexOf("-- ── Migration 208:");
assert.notEqual(mirrorIdx, -1, "supabase-schema.sql is missing the migration 208 mirror block");
const mirrorEnd = consolidatedSql.indexOf("insert into public.fuel_ledger_schema_migrations", mirrorIdx);
assert.notEqual(mirrorEnd, -1, "supabase-schema.sql: migration 208's mirror has no tracker insert");

const sqlSources = {
  "migration 208": migrationSql,
  "supabase-schema.sql (208 tail)": consolidatedSql.slice(mirrorIdx, mirrorEnd),
};

/** One function's text, from its CREATE to the `$$;` that closes its body. */
function functionBody(sql, fn, name) {
  const at = sql.indexOf(`create or replace function public.${fn}(`);
  assert.notEqual(at, -1, `${name}: ${fn} is not declared here`);
  const end = sql.indexOf("\n$$;", at);
  assert.notEqual(end, -1, `${name}: ${fn}'s body is unterminated`);
  return sql.slice(at, end);
}

process.stdout.write("\nSQL shape (migration 208 + its supabase-schema.sql mirror):\n");
for (const [name, sql] of Object.entries(sqlSources)) {
  const claim = functionBody(sql, "claim_due_newsletter_send_job", name);
  const advance = functionBody(sql, "advance_newsletter_send_job", name);
  const retry = functionBody(sql, "retry_newsletter_send_job", name);

  pin(`${name}: the lease_token column exists and every claim mints a fresh one`, () => {
    assert.match(
      sql,
      /alter table public\.newsletter_send_jobs\s*\n\s*add column if not exists lease_token uuid;/,
      "the owner token is a column on the job — a lease that lives only in the worker's memory " +
        "cannot be checked by the database that has to enforce it",
    );
    assert.match(
      claim,
      /set status = 'sending',\s*\n\s*claimed_at = now\(\),[\s\S]{0,400}?lease_token = gen_random_uuid\(\),/,
      "claim_ must mint a NEW token on every claim. Re-using or omitting it would leave a " +
        "re-claimed job writable by the worker whose lease just expired",
    );
    assert.ok(
      !/lease_token = null/.test(claim),
      "a claim takes ownership; it never clears it",
    );
  });

  pin(`${name}: advance_ fences BOTH updates on the lease owner`, () => {
    const fence = /\(p_lease_token is null or j\.lease_token = p_lease_token\)/g;
    assert.equal(
      (advance.match(fence) || []).length,
      2,
      "the owner fence must guard the ACTIVE-job UPDATE and 198's cancelled-job reconciliation " +
        "alike. Fenced on one only, a worker that lost its lease can still write the cursor of a " +
        "cancelled job through the branch GV-470 added",
    );
    // `p_lease_token is null or …` is the legacy escape hatch and it is load-bearing: it is
    // what lets this SQL be applied before the govehlo-web deploy that starts sending tokens.
    assert.match(
      advance,
      /and j\.status in \('pending', 'sending'\)\s*\n\s*and \(p_lease_token is null or j\.lease_token = p_lease_token\)/,
      "the active-job UPDATE keeps its status guard and gains the owner fence beneath it",
    );
    assert.match(
      advance,
      /and j\.status = 'failed'\s*\n\s*and j\.claimed_at is not null\s*\n\s*and \(p_lease_token is null or j\.lease_token = p_lease_token\)/,
      "198's receipt predicate is unchanged and the owner fence is added to it — the receipt now " +
        "names WHICH worker was mid-batch",
    );
  });

  pin(`${name}: the lease is held ONLY by a fenced, non-releasing, non-done call with a cursor`, () => {
    assert.match(
      advance,
      /v_hold := p_lease_token is not null\s*\n\s*and not coalesce\(p_release, true\)\s*\n\s*and not coalesce\(p_done, false\)\s*\n\s*and p_last_confirmed_at is not null;/,
      "all four conjuncts are load-bearing. Drop the token test and an unfenced legacy caller " +
        "could hold a lease it cannot prove; drop the p_done test and a finished job keeps a " +
        "lease forever; drop the cursor test and GV-459's pure lease-release (which is what " +
        "fails a stuck job on its fifth tick) would leave claimed_at set — turning a " +
        "ceiling-failed job into something indistinguishable from migration 198's cancel receipt",
    );
    assert.match(
      advance,
      /claimed_at = case when v_hold then j\.claimed_at else null end,\s*\n\s*lease_token = case when v_hold then j\.lease_token else null end,/,
      "the token is released with the lease and never on its own — a claimed_at without its " +
        "token, or the reverse, is a state no branch in this function knows how to read",
    );
    assert.match(
      advance,
      /claimed_at = null,\s*\n\s*lease_token = null,\s*\n\s*updated_at = now\(\)\s*\n\s*where j\.id = p_campaign_id\s*\n\s*and j\.status = 'failed'/,
      "the reconciliation always releases: it accounts for the last batch of a job that is " +
        "already terminal, and holding a lease on it would re-fence retry_ forever",
    );
  });

  pin(`${name}: a stale owner is ANSWERED, not raised at — and an absent id still raises`, () => {
    assert.match(
      advance,
      new RegExp(
        `if p_lease_token is not null\\s*\\n\\s*and v_status in \\('pending', 'sending'\\)\\s*\\n\\s*and v_token is distinct from p_lease_token then\\s*\\n\\s*return jsonb_build_object\\('status', '${STALE}'\\);`,
      ),
      "a worker that lost the lease must get a value it can branch on. An exception here would " +
        "be indistinguishable from a transport failure and would take the whole invocation down " +
        "with it — while the safe response is simply to stop mailing",
    );
    assert.match(
      advance,
      /raise exception 'no newsletter_send_jobs row for %', p_campaign_id using errcode = 'P0002';/,
      "a genuinely absent campaign id is still an ERROR — the stale/no-op answers must not swallow it",
    );
    for (const status of ["advanced", "done", "reconciled", "noop"]) {
      assert.ok(
        advance.includes(`jsonb_build_object('status', '${status}')`),
        `the '${status}' outcome must be distinguishable — the hook branches on all four`,
      );
    }
  });

  pin(`${name}: the 7-argument signature is DROPPED, and the 9-argument one restates every ACL`, () => {
    // Two candidate signatures is PGRST203: PostgREST resolves neither and every hook call
    // fails. `create or replace` cannot add a parameter or change void -> jsonb, so the old
    // signature has to go explicitly.
    assert.match(
      sql,
      /drop function if exists public\.advance_newsletter_send_job\(uuid, timestamptz, uuid, integer, integer, boolean, integer\);/,
      "the 7-argument advance_ must be dropped, or it survives beside the 9-argument one and " +
        "PostgREST answers PGRST203 to the hook's 7-key call",
    );
    assert.match(
      advance,
      /create or replace function public\.advance_newsletter_send_job\(\s*\n\s*p_campaign_id uuid,\s*\n\s*p_last_confirmed_at timestamptz,\s*\n\s*p_last_id uuid,\s*\n\s*p_sent_delta integer,\s*\n\s*p_failed_delta integer,\s*\n\s*p_done boolean,\s*\n\s*p_status_code integer default null,\s*\n\s*p_lease_token uuid default null,\s*\n\s*p_release boolean default true\s*\n\)\s*\nreturns jsonb/,
      "both new parameters must be DEFAULTED and trailing: that is what keeps the currently " +
        "deployed 7-key hook call resolving, which is what makes apply-before-deploy safe",
    );
    const NEW_SIG = "uuid, timestamptz, uuid, integer, integer, boolean, integer, uuid, boolean";
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(
        sql.includes(`revoke all on function public.advance_newsletter_send_job(${NEW_SIG}) from ${role};`),
        `a DROP takes the old signature's ACLs with it, so revoke from ${role} must be restated ` +
          "on the new one — a function created fresh is EXECUTE-to-public by default",
      );
    }
    assert.ok(
      sql.includes(`grant execute on function public.advance_newsletter_send_job(${NEW_SIG}) to service_role;`),
      "advance_ stays service_role only — it is a scheduler RPC, never browser-callable",
    );
    assert.ok(
      !new RegExp(`grant execute on function public\\.advance_newsletter_send_job\\([^)]*\\) to (anon|authenticated);`).test(sql),
      "advance_ must never be granted to a browser role",
    );
    for (const fn of ["claim_due_newsletter_send_job", "retry_newsletter_send_job"]) {
      for (const role of ["public", "anon", "authenticated"]) {
        assert.ok(
          new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from ${role};`).test(sql),
          `148's ACL convention: a re-declaration resets nothing, so revoke ${fn} from ${role} must be restated`,
        );
      }
      assert.ok(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`).test(sql),
        `${fn} must stay service_role only`,
      );
    }
  });

  pin(`${name}: retry_ drops the old owner with the lease`, () => {
    assert.match(
      retry,
      /set status = 'pending',[\s\S]{0,400}?claimed_at = null,[\s\S]{0,300}?lease_token = null,/,
      "a re-queued job that kept a live token is writable by the worker that still holds it — " +
        "its advance would match `status in (pending, sending) and lease_token = <its token>` and " +
        "push the cursor past recipients the NEW tick has not mailed",
    );
    // 198's fence must survive verbatim; this migration only adds an assignment.
    assert.match(
      retry,
      /if v_claimed_at is not null and v_claimed_at > now\(\) - make_interval\(secs => 300\) then\s*\n\s*raise exception 'udsendelsen har stadig en batch i gang - vent til den er afsluttet og prøv igen' using errcode = '55P03';/,
      "migration 198's cancel-mid-batch fence is untouched — GV-491 adds an owner, it does not " +
        "reopen GV-470",
    );
  });

  pin(`${name}: cancel_ is deliberately NOT re-declared — 198's receipt is left exactly as it is`, () => {
    assert.ok(
      !sql.includes("create or replace function public.cancel_newsletter_send_job("),
      "cancel_ never wrote lease_token and must not start: leaving BOTH halves of the receipt in " +
        "place is what lets the owning worker's advance still reconcile the page it already " +
        "mailed (GV-470), which is the one behaviour this migration must not disturb",
    );
    assert.ok(
      !/drop function[^\n]*cancel_newsletter_send_job/i.test(sql),
      "and it is certainly not dropped",
    );
  });
}

pin("the header carries the provenance chain a re-declaration must be based on (GV-202)", () => {
  // The header is hard-wrapped prose, so match it unwrapped: strip the comment markers and
  // collapse whitespace. Otherwise this pin would be a test of where the lines happen to break.
  const header = migrationSql
    .slice(0, migrationSql.indexOf("alter table public.newsletter_send_jobs"))
    .replace(/^--\s?/gm, "")
    .replace(/\s+/g, " ");
  assert.match(
    header,
    /advance_newsletter_send_job: 179 -> 181 -> 185 -> 198/,
    "the chain must be written down: advance_'s newest prior definition is 198, and re-declaring " +
      "off 185 would silently drop GV-470's cancelled-job reconciliation",
  );
  assert.match(
    header,
    /claim_due_newsletter_send_job: 179 -> 185/,
    "claim_'s newest is 185 — 198 left it alone",
  );
  assert.match(header, /retry_newsletter_send_job: 185 -> 198/);
  assert.match(
    header,
    /cancel_newsletter_send_job \(newest 198\), mint_ and create_ \(newest 181\) and the two readers \(180, 191\) are NOT touched/,
    "the untouched functions must be named, so the next author knows the blast radius was considered",
  );
  assert.match(
    header,
    /applied BEFORE the govehlo-web deploy/,
    "the apply order is a property of the fix, not a deployment detail: legacy p_lease_token-null " +
      "calls behave exactly as before precisely so the SQL can land first",
  );
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
    "Newsletter lease-token behaviour not checked",
    "Docker is unavailable, so the two-worker claim/checkpoint/stale-advance interleaving was NOT " +
      "executed. The held lease, the refused overlapping claim, the stale-owner no-op and the " +
      "legacy null-token path were skipped on this run.",
  );
  report();
} else {
  let finished = false;
  process.on("exit", () => {
    if (!finished) removeContainer(CONTAINER);
  });

  function fail(message) {
    process.stderr.write(`\n❌ newsletter lease-token contract: ${message}\n`);
    removeContainer(CONTAINER);
    process.exit(1);
  }

  function raw(sql, args = []) {
    const res = psql(CONTAINER, DB, [...args, "-c", sql]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
    return res.stdout.trim();
  }
  const scalar = (sql) => raw(sql, ["-t", "-A"]);

  /**
   * Evaluate a jsonb-returning expression. Returns { sqlstate, payload } — 'OK' plus the
   * returned jsonb as text when it succeeded, the SQLSTATE and message when it raised.
   */
  function call(expr) {
    const wrapped = `
do $$
declare v_result jsonb;
begin
  v_result := ${expr};
  raise notice 'GVSTATE:OK|%', coalesce(v_result::text, 'NULL');
exception when others then
  raise notice 'GVSTATE:%|%', sqlstate, sqlerrm;
end $$;`;
    const res = psql(CONTAINER, DB, ["-c", wrapped]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${wrapped}`);
    const match = `${res.stdout}\n${res.stderr}`.match(/GVSTATE:([^|]*)\|(.*)/);
    if (!match) fail(`Could not read a SQLSTATE back from:\n${wrapped}`);
    return { sqlstate: match[1].trim(), payload: match[2].trim() };
  }

  /** The `status` key of a successful advance, or `<SQLSTATE>` when it raised. */
  function statusOf(result) {
    if (result.sqlstate !== "OK") return result.sqlstate;
    return JSON.parse(result.payload).status;
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
  // Eight confirmed subscribers a minute apart, so a page of two is a clean, checkable
  // keyset step and the cursor means something. Seeded directly rather than through the
  // signup RPCs because this suite is about the LEASE, not consent.
  {
    const res = psql(CONTAINER, DB, [
      "-c",
      `insert into public.newsletter_subscribers (email, requested_at, confirmed_at, consent_text_version)
       select 'sub' || n || '@example.dk', now() - interval '2 days',
              now() - interval '1 day' + (n || ' minute')::interval, '2026-08-01'
       from generate_series(1, 8) as n;`,
    ]);
    if (res.status !== 0) fail(`Seeding subscribers failed:\n${res.stderr}`);
  }

  const OPERATOR = "cjo@govehlo.dk";
  const NIL_TOKEN = "00000000-0000-0000-0000-0000000000aa";

  const createJob = (headline) =>
    scalar(`select public.create_newsletter_send_job('${headline}', 'Hej', '[]'::jsonb, '${OPERATOR}');`);
  /** One scheduler tick's claim. Returns { id, token } — both '' when nothing was due. */
  function claim() {
    const row = scalar(
      `select coalesce((select id::text || '~' || coalesce(lease_token::text, 'NULL')
                          from public.claim_due_newsletter_send_job(300)), '');`,
    );
    if (!row) return { id: "", token: "" };
    const [id, token] = row.split("~");
    return { id, token };
  }
  /** The next keyset page, as the hook mints it: from the job's OWN cursor. */
  function mint(job, limit = 2) {
    const rows = scalar(
      `select coalesce(string_agg(email || '~' || subscriber_confirmed_at::text || '~' || subscriber_id::text, '|'
                       order by subscriber_confirmed_at, subscriber_id), '')
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
  const tokenArg = (token) => (token === null ? "null" : `'${token}'::uuid`);
  /** A chunk checkpoint: cursor moves, lease is KEPT (p_release false). */
  const checkpoint = (job, batch, token, { sent = batch.length, failed = 0 } = {}) => {
    const last = batch[batch.length - 1];
    return call(
      `public.advance_newsletter_send_job('${job}'::uuid, '${last.confirmedAt}'::timestamptz,
         '${last.id}'::uuid, ${sent}, ${failed}, false, null, ${tokenArg(token)}, false)`,
    );
  };
  /** The final chunk of a batch: cursor moves AND the lease is handed back. */
  const finalChunk = (job, batch, token, { sent = batch.length, failed = 0 } = {}) => {
    const last = batch[batch.length - 1];
    return call(
      `public.advance_newsletter_send_job('${job}'::uuid, '${last.confirmedAt}'::timestamptz,
         '${last.id}'::uuid, ${sent}, ${failed}, false, null, ${tokenArg(token)}, true)`,
    );
  };
  /** The hook's pure lease-release after a template/mint/fan-out failure. */
  const releaseLease = (job, token, code = "null") =>
    call(`public.advance_newsletter_send_job('${job}'::uuid, null, null, 0, 0, false, ${code}, ${tokenArg(token)}, true)`);
  /** The hook's drained/done advance. */
  const advanceDone = (job, token) =>
    call(`public.advance_newsletter_send_job('${job}'::uuid, null, null, 0, 0, true, null, ${tokenArg(token)}, true)`);
  /** The PRE-208 call shape, exactly as the currently deployed hook makes it. */
  const legacyAdvance = (job, batch) => {
    const last = batch[batch.length - 1];
    return call(
      `public.advance_newsletter_send_job('${job}'::uuid, '${last.confirmedAt}'::timestamptz,
         '${last.id}'::uuid, ${batch.length}, 0, false, null)`,
    );
  };

  const cancel = (job) => scalar(`select public.cancel_newsletter_send_job('${job}'::uuid)::text;`);
  const retry = (job) => call(`public.retry_newsletter_send_job('${job}'::uuid)`);
  const jobField = (job, column) =>
    scalar(`select coalesce(${column}::text, 'NULL') from public.newsletter_send_jobs where id = '${job}'::uuid;`);
  /** Push a job's lease stamp into the past — a worker that died and never reported. */
  const ageLease = (job, seconds) =>
    raw(`update public.newsletter_send_jobs set claimed_at = now() - make_interval(secs => ${seconds})
           where id = '${job}'::uuid;`);

  // ── 1. The bug, as an interleaving: a checkpoint must not hand the job away ──
  process.stdout.write("\nt0..t7 — a mid-batch checkpoint keeps the lease:\n");

  const job1 = createJob("Nyhedsbrev A");
  let leaseA;
  let batch1;

  pin("t0: the claim hands back an owner token, not just a timestamp", () => {
    const claimed = claim();
    assert.equal(claimed.id, job1);
    assert.match(claimed.token, /^[0-9a-f-]{36}$/, "claim_ must mint a uuid the worker can prove ownership with");
    assert.equal(jobField(job1, "status"), "sending");
    assert.equal(jobField(job1, "lease_token"), claimed.token, "and it is the one stored on the job");
    leaseA = claimed.token;
  });

  pin("t1..t3: the first chunk advances the cursor and KEEPS claimed_at (the whole fix)", () => {
    batch1 = mint(job1);
    assert.deepEqual(batch1.map((r) => r.email), ["sub1@example.dk", "sub2@example.dk"]);
    assert.equal(statusOf(checkpoint(job1, batch1, leaseA)), "advanced");
    assert.equal(jobField(job1, "cursor_id"), batch1[1].id, "the chunk that was mailed is recorded");
    assert.equal(jobField(job1, "sent_count"), "2");
    assert.notEqual(
      jobField(job1, "claimed_at"),
      "NULL",
      "before migration 208 this was NULL, and the job was up for grabs while the invocation was " +
        "still mailing the rest of its page",
    );
    assert.equal(jobField(job1, "lease_token"), leaseA, "and the same worker still owns it");
  });

  pin("t4: THE FIX — an overlapping tick's claim gets NOTHING while the batch is in flight", () => {
    assert.equal(
      claim().id,
      "",
      "this is the double send. Before 208 the checkpoint above released the lease, so the next */5 " +
        "tick claimed the same job, minted from the advanced cursor, and mailed the chunk this " +
        "worker was still sending",
    );
  });

  pin("the last chunk of the batch releases explicitly — and only then is the job claimable", () => {
    const batch2 = mint(job1);
    assert.deepEqual(batch2.map((r) => r.email), ["sub3@example.dk", "sub4@example.dk"]);
    assert.equal(statusOf(finalChunk(job1, batch2, leaseA)), "advanced");
    assert.equal(jobField(job1, "claimed_at"), "NULL", "an explicit release frees the lease");
    assert.equal(jobField(job1, "lease_token"), "NULL", "and the owner with it");
    assert.equal(jobField(job1, "sent_count"), "4");
    const next = claim();
    assert.equal(next.id, job1, "the next tick takes over cleanly");
    assert.notEqual(next.token, leaseA, "with a token of its own");
    leaseA = next.token;
  });

  pin("the campaign still drains and completes exactly once, with ONE send-log row", () => {
    for (const expected of [["sub5@example.dk", "sub6@example.dk"], ["sub7@example.dk", "sub8@example.dk"]]) {
      const batch = mint(job1);
      assert.deepEqual(batch.map((r) => r.email), expected);
      assert.equal(statusOf(finalChunk(job1, batch, leaseA)), "advanced");
      leaseA = claim().token;
    }
    assert.deepEqual(mint(job1), [], "drained");
    assert.equal(statusOf(advanceDone(job1, leaseA)), "done");
    assert.equal(jobField(job1, "status"), "done");
    assert.equal(jobField(job1, "sent_count"), "8", "every subscriber counted exactly once");
    assert.equal(scalar(`select count(*) from public.newsletter_send_log where headline = 'Nyhedsbrev A';`), "1");
  });

  // ── 2. The stale owner ──────────────────────────────────────────────────────
  process.stdout.write("\nThe worker whose lease was re-claimed under it:\n");

  pin("a stale token advances NOTHING and answers stale_lease", () => {
    const job = createJob("Nyhedsbrev B");
    const first = claim();
    const batch = mint(job);
    // The invocation outlives its own lease (a slow fan-out, a stalled subrequest), so the
    // next tick legitimately takes the job over and mints its own page.
    ageLease(job, 301);
    const second = claim();
    assert.equal(second.id, job, "past the lease window the job IS re-claimable — that must not change");
    assert.notEqual(second.token, first.token, "and the re-claim mints a fresh owner token");

    const stale = checkpoint(job, batch, first.token);
    assert.equal(statusOf(stale), STALE, "the loser is TOLD, so the hook can stop mailing");
    assert.equal(jobField(job, "cursor_id"), "NULL", "and it moved no cursor");
    assert.equal(jobField(job, "sent_count"), "0", "and no counts");
    assert.equal(jobField(job, "lease_token"), second.token, "the real owner still holds the job");
    assert.notEqual(jobField(job, "claimed_at"), "NULL", "and its lease was not freed by a worker that lost it");

    // ...and the same worker's RELEASE is refused too. Freeing a lease it no longer holds
    // would hand the job to a third tick while the real owner is mid-batch.
    assert.equal(statusOf(releaseLease(job, first.token, 502)), STALE);
    assert.notEqual(jobField(job, "claimed_at"), "NULL");
    assert.equal(jobField(job, "attempt_count"), "0", "and it did not spend one of the real owner's five ticks");

    // The real owner is unaffected and finishes normally.
    assert.equal(statusOf(finalChunk(job, batch, second.token)), "advanced");
    assert.equal(jobField(job, "cursor_id"), batch[1].id);
    JSON.parse(cancel(job));
  });

  pin("a token that names no job at all is stale, never a silent write", () => {
    const job = createJob("Nyhedsbrev C");
    const owner = claim();
    assert.equal(owner.id, job);
    const batch = mint(job);
    assert.equal(statusOf(checkpoint(job, batch, NIL_TOKEN)), STALE);
    assert.equal(jobField(job, "cursor_id"), "NULL");
    JSON.parse(cancel(job));
  });

  // ── 3. Migration 198's cancel receipt, now with an owner ────────────────────
  process.stdout.write("\nGV-470's cancel receipt still reconciles — for the OWNER only:\n");

  pin("the owning worker's advance still lands the page it already mailed on a CANCELLED job", () => {
    const job = createJob("Nyhedsbrev D");
    const owner = claim();
    const batch = mint(job);
    const cancelled = JSON.parse(cancel(job));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.in_flight, true);
    assert.equal(jobField(job, "lease_token"), owner.token, "cancel leaves BOTH halves of the receipt");

    assert.equal(retry(job).sqlstate, "55P03", "198's fence still holds while the batch is unaccounted for");
    assert.equal(statusOf(checkpoint(job, batch, owner.token)), "reconciled");
    assert.equal(jobField(job, "cursor_id"), batch[1].id, "the mailed page is recorded, so a retry resumes PAST it");
    assert.equal(jobField(job, "status"), "failed", "reconciliation is not resurrection");
    assert.equal(jobField(job, "claimed_at"), "NULL", "the receipt is consumed...");
    assert.equal(jobField(job, "lease_token"), "NULL", "...both halves of it");
    assert.equal(statusOf(retry(job)), "pending", "which lifts the fence at once");

    // And the retry drops the old owner: that worker's next advance writes nothing.
    assert.equal(
      statusOf(checkpoint(job, mint(job), owner.token)),
      STALE,
      "a re-queued job that kept its old token would be writable by the worker that still holds it",
    );
    assert.equal(jobField(job, "cursor_id"), batch[1].id, "so the cursor did not move");
    JSON.parse(cancel(job));
  });

  pin("a worker that had ALREADY lost the lease cannot reconcile someone else's cancelled batch", () => {
    const job = createJob("Nyhedsbrev E");
    const first = claim();
    ageLease(job, 301);
    const second = claim();
    const batch = mint(job);
    JSON.parse(cancel(job));
    assert.equal(
      statusOf(checkpoint(job, batch, first.token)),
      "noop",
      "the receipt names the SECOND worker, so the first one's advance matches neither UPDATE",
    );
    assert.equal(jobField(job, "cursor_id"), "NULL", "and it records a page it may not have mailed all of");
    assert.equal(statusOf(checkpoint(job, batch, second.token)), "reconciled", "the real owner still lands");
    assert.equal(jobField(job, "cursor_id"), batch[1].id);
  });

  // ── 4. GV-459's retry ceiling and the failed-tick path are untouched ────────
  process.stdout.write("\nThe stuck job that fails itself (GV-459) must still leave NO receipt:\n");

  pin("five no-progress ticks still fail the job, with claimed_at AND lease_token null", () => {
    const job = createJob("Nyhedsbrev F");
    for (let tick = 1; tick <= 5; tick += 1) {
      const owner = claim();
      assert.equal(owner.id, job, `tick ${tick} must be claimable`);
      assert.equal(statusOf(releaseLease(job, owner.token, 502)), "advanced");
      raw(`update public.newsletter_send_jobs set next_attempt_at = null where id = '${job}'::uuid;`);
    }
    assert.equal(jobField(job, "status"), "failed", "the ceiling still frees the single-active slot");
    assert.equal(jobField(job, "attempt_count"), "5");
    assert.equal(
      jobField(job, "claimed_at"),
      "NULL",
      "a pure lease-release NEVER holds, whatever p_release says — otherwise a ceiling-failed job " +
        "would be indistinguishable from migration 198's cancel receipt and retry_ would fence it",
    );
    assert.equal(jobField(job, "lease_token"), "NULL");
    assert.equal(statusOf(retry(job)), "pending", "and retry is available with no wait");
    JSON.parse(cancel(job));
  });

  pin("a fenced call with p_release false but NO cursor still releases — the hold needs all four", () => {
    const job = createJob("Nyhedsbrev G");
    const owner = claim();
    const res = call(
      `public.advance_newsletter_send_job('${job}'::uuid, null, null, 0, 0, false, null, ${tokenArg(owner.token)}, false)`,
    );
    assert.equal(statusOf(res), "advanced");
    assert.equal(jobField(job, "claimed_at"), "NULL", "no cursor means this tick made no progress: it is a failed tick");
    assert.equal(jobField(job, "attempt_count"), "1");
    JSON.parse(cancel(job));
  });

  // ── 5. The legacy call shape — what the deployed hook sends today ───────────
  process.stdout.write("\nThe currently deployed 7-key hook call, unchanged:\n");

  pin("a legacy advance resolves against the 9-argument function and behaves exactly as before", () => {
    const job = createJob("Nyhedsbrev H");
    const owner = claim();
    assert.notEqual(owner.token, "NULL", "the job is claimed with a token even though the caller ignores it");
    const batch = mint(job);
    assert.equal(statusOf(legacyAdvance(job, batch)), "advanced");
    assert.equal(jobField(job, "cursor_id"), batch[1].id, "no token means no fence — the cursor moves");
    assert.equal(
      jobField(job, "claimed_at"),
      "NULL",
      "and no token means no hold: the pre-208 release-at-every-advance behaviour is exactly preserved, " +
        "which is what lets this SQL be applied before the govehlo-web deploy",
    );
    assert.equal(jobField(job, "lease_token"), "NULL");
    assert.equal(claim().id, job, "so the next tick can claim it, exactly as it does today");
    JSON.parse(cancel(job));
  });

  pin("an advance for a campaign id that does not exist still raises P0002", () => {
    const unknown = call(
      `public.advance_newsletter_send_job('00000000-0000-0000-0000-0000000000ff'::uuid, null, null, 0, 0, false, null,
         ${tokenArg(NIL_TOKEN)}, false)`,
    );
    assert.equal(unknown.sqlstate, "P0002", "being told about an id that does not exist is not an outcome");
  });

  pin("an advance at a long-terminal job with no receipt is still the quiet no-op", () => {
    const job = createJob("Nyhedsbrev I");
    const owner = claim();
    const batch = mint(job);
    JSON.parse(cancel(job));
    raw(`update public.newsletter_send_jobs set claimed_at = null, lease_token = null where id = '${job}'::uuid;`);
    assert.equal(statusOf(checkpoint(job, batch, owner.token)), "noop", "not an error under an at-least-once scheduler");
    assert.equal(jobField(job, "cursor_id"), "NULL", "and with no receipt it writes nothing");
  });

  finished = true;
  removeContainer(CONTAINER);
  report();
}

function report() {
  process.stdout.write(`\n✅ newsletter lease-token contract: ${checked} pins held.\n`);
  if (warnings.length > 0) {
    process.stdout.write(`⚠️  ${warnings.length} half(s) could not be checked on this run.\n`);
  }
}
