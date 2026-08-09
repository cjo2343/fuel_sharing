// The simulator's database driver (GV-471).
//
// Every other Docker-backed guard in this repo pays one `docker exec psql` per batch,
// which is right when a run is a handful of big statements. The simulator is the
// opposite shape: hundreds of tiny statements whose INDIVIDUAL outcome and latency are
// the product. One process spawn per action would cost ~50-100 ms of Docker overhead
// against a ~1 ms RPC, so this keeps ONE psql attached to the container for the whole
// run and speaks a line protocol to it.
//
// SAFETY, inherited from tools/load-rehearsal/lib/pg-local.mjs and preserved here: no
// env file, no connection string, no URL. The only database this can address is a
// container this process started, addressed by container name. There is no code path
// that can point it at production.
//
// PROTOCOL. Each request writes the caller's SQL followed by two sentinels:
//
//     <sql>
//     \echo :SIM-END:<n>      -- stdout marker
//     \warn :SIM-END:<n>      -- stderr marker
//
// and resolves once BOTH have arrived. The stderr marker is not decoration: psql
// reports a failed statement on stderr and carries on (ON_ERROR_STOP is off), so
// without a matching marker a diagnostic could land after the reply was already
// resolved and be attributed to the NEXT action.

import { spawn } from "node:child_process";

/** SQL string literal — single quotes doubled. Rejects `$`, which would break the
 *  dollar-quoted envelope the action SQL is wrapped in (see sqlBlock below). */
export function lit(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`lit(): non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  if (text.includes("$")) throw new Error("lit(): '$' is not allowed in simulator literals");
  return `'${text.replace(/'/g, "''")}'`;
}

/** uuid literal (or null). */
export function uuidLit(value) {
  return value === null || value === undefined ? "null" : `${lit(value)}::uuid`;
}

/** uuid[] literal from an array of uuid strings. */
export function uuidArrayLit(values) {
  if (!values || values.length === 0) return "array[]::uuid[]";
  return `array[${values.map((v) => lit(v)).join(", ")}]::uuid[]`;
}

/** jsonb literal. JSON can never contain the tag, so dollar-quoting is safe. */
export function jsonLit(value) {
  return `$simjson$${JSON.stringify(value)}$simjson$::jsonb`;
}

/** Wrap an inner SQL statement for public.sim_exec's dynamic EXECUTE. */
export function sqlBlock(sql) {
  if (sql.includes("$simsql$")) throw new Error("sqlBlock(): inner SQL may not contain the envelope tag");
  return `$simsql$${sql}$simsql$`;
}

export class PsqlSession {
  constructor(container, database, index = 0) {
    this.container = container;
    this.database = database;
    /** Which of the run's sessions this is. 0 is the primary — every ordinary action
     *  and every oracle sweep runs there — and 1..n-1 exist only so a contention
     *  scenario can hold a lock in one connection while another connection walks into
     *  it. It is journalled on every line, because "which connection did this" is the
     *  first question anybody asks about an interleaved run. */
    this.index = index;
    this.child = null;
    this.counter = 0;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.pending = null;
    this.closed = false;
  }

  start() {
    this.child = spawn(
      "docker",
      [
        "exec", "-i", this.container,
        "psql", "-q", "-t", "-A", "-F", "\t", "-P", "pager=off",
        "-U", "postgres", "-d", this.database,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onData("stdout", chunk));
    this.child.stderr.on("data", (chunk) => this.#onData("stderr", chunk));
    this.child.on("exit", () => {
      this.closed = true;
      if (this.pending) {
        const { reject } = this.pending;
        this.pending = null;
        reject(new Error("psql session exited unexpectedly"));
      }
    });
  }

  #onData(stream, chunk) {
    if (stream === "stdout") this.stdoutBuffer += chunk;
    else this.stderrBuffer += chunk;
    this.#tryResolve();
  }

  #tryResolve() {
    if (!this.pending) return;
    const { marker, resolve } = this.pending;
    const outIdx = this.stdoutBuffer.indexOf(`${marker}\n`);
    const errIdx = this.stderrBuffer.indexOf(`${marker}\n`);
    if (outIdx < 0 || errIdx < 0) return;

    const stdout = this.stdoutBuffer.slice(0, outIdx);
    const stderr = this.stderrBuffer.slice(0, errIdx);
    this.stdoutBuffer = this.stdoutBuffer.slice(outIdx + marker.length + 1);
    this.stderrBuffer = this.stderrBuffer.slice(errIdx + marker.length + 1);
    this.pending = null;
    resolve({
      lines: stdout.split("\n").filter((line) => line !== ""),
      stderr: stderr.trim(),
    });
  }

  /**
   * Run SQL and collect its tuple output.
   *
   * `ms` is WALL-CLOCK and therefore the one non-deterministic field the simulator
   * produces. It never feeds a decision; it is reported and excluded from the
   * determinism digest.
   */
  async send(sql, { timeoutMs = 120000 } = {}) {
    if (this.closed) throw new Error("psql session is closed");
    if (this.pending) throw new Error("psql session is not re-entrant");
    this.counter += 1;
    const marker = `:SIM-END:${this.counter}:`;
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`psql did not answer within ${timeoutMs} ms for:\n${sql.slice(0, 2000)}`));
      }, timeoutMs);
      this.pending = {
        marker,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n\\warn ${marker}\n`);
    });
    return { ...result, ms: Date.now() - started };
  }

  /** Run SQL expecting one JSON value on the first output line. */
  async json(sql, what = "query") {
    const res = await this.send(sql);
    if (res.lines.length === 0) {
      throw new Error(`${what}: expected one row, got none${res.stderr ? `\n${res.stderr}` : ""}`);
    }
    try {
      return JSON.parse(res.lines[0]);
    } catch {
      throw new Error(`${what}: output was not JSON: ${res.lines[0].slice(0, 400)}`);
    }
  }

  /** Run SQL expecting one scalar on the first output line (null when absent). */
  async value(sql, what = "query") {
    const res = await this.send(sql);
    if (res.stderr) throw new Error(`${what} failed:\n${res.stderr}`);
    return res.lines.length > 0 ? res.lines[0] : null;
  }

  /** Run SQL for effect; any stderr is a failure. */
  async exec(sql, what = "statement") {
    const res = await this.send(sql);
    if (res.stderr) throw new Error(`${what} failed:\n${res.stderr}`);
    return res.lines;
  }

  stop() {
    if (this.child && !this.closed) {
      try { this.child.stdin.end("\\q\n"); } catch { /* already gone */ }
    }
  }
}

/**
 * N persistent psql sessions against the SAME container (GV-478 Phase B, feature 4).
 *
 * WHY MORE THAN ONE. Phase A held exactly one connection, which meant every write the
 * fuzzer made was serialised by construction — and the whole class of bug that only
 * exists because two people press a button at the same moment was structurally out of
 * reach. Two connections make it reachable.
 *
 * WHY THEY ARE DRIVEN IN LOCKSTEP AND NEVER CONCURRENTLY. A genuine race is scheduled
 * by the OS, which means it is not reproducible, which means a finding could not be
 * handed back as a repro command — and determinism is this tool's product. So the
 * scenarios in lib/interleave.mjs step the sessions one statement at a time, in an
 * order the PRNG chose: session B takes a lock and stays in its transaction, session A
 * walks into it, B resolves. Same collision, deterministic ordering.
 *
 * THE HANG THIS WOULD OTHERWISE BE. A single-threaded driver that sends A's blocking
 * statement and waits has deadlocked itself: B cannot commit, because the driver is
 * blocked waiting for A. lib/interleave.mjs answers that by running A under
 * `SET LOCAL lock_timeout`, so a lock conflict resolves as SQLSTATE 55P03 within a few
 * hundred milliseconds and becomes a classifiable outcome instead of a stall.
 *
 * SAFETY is unchanged: every session is another `docker exec` into the container this
 * process started, addressed by container name. There is still no URL anywhere.
 */
export class SessionPool {
  constructor(container, database, count = 1) {
    this.sessions = [];
    for (let i = 0; i < Math.max(1, count); i += 1) {
      this.sessions.push(new PsqlSession(container, database, i));
    }
  }

  /** The session every ordinary action and every oracle sweep uses. */
  get primary() {
    return this.sessions[0];
  }

  get size() {
    return this.sessions.length;
  }

  at(index) {
    return this.sessions[index % this.sessions.length];
  }

  startAll() {
    for (const session of this.sessions) session.start();
  }

  stopAll() {
    for (const session of this.sessions) session.stop();
  }

  /** Roll back anything a scenario left open. Called defensively after every scenario
   *  and once before each oracle sweep: an open transaction on a secondary session
   *  would hold locks the sweep's own reads could sit behind. */
  async rollbackSecondaries() {
    for (const session of this.sessions.slice(1)) {
      if (session.closed) continue;
      try { await session.send("rollback;"); } catch { /* nothing was open */ }
    }
  }
}

// ── The scratch surface the harness owns (never part of the product schema) ──
//
// sim_exec is the whole reason a fuzzer can run against real RPCs at all: it turns a
// raised exception into DATA (sqlstate + message) instead of an aborted script, so the
// tick loop can classify the rejection as an expected guard or as a finding and keep
// going. It is SECURITY INVOKER on purpose — the caller runs it as role
// `authenticated`, so RLS and table grants apply to anything the action touches
// directly, exactly as they would for a PostgREST request.
export const SIM_SCRATCH_DDL = `
create table if not exists public.sim_state (k text primary key, v text);
create table if not exists public.sim_members (
  ws int,
  slot int,
  member_id uuid,
  sub uuid,
  email text,
  primary key (ws, slot)
);

-- GV-478: the mapping stampDeterministicMemberIds() rewrites ledger_members.id through.
-- Harness scratch, like everything else in this block; never part of the product schema.
create table if not exists public.sim_member_remap (
  old_id uuid primary key,
  new_id uuid not null
);

create or replace function public.sim_exec(p_claims text, p_sqls text[])
returns jsonb
language plpgsql
as $simexec$
declare
  v_sql text;
  v_result jsonb;
begin
  -- LOCAL: the claims die with the statement's implicit transaction, so one action
  -- can never leak its identity into the next.
  perform set_config('request.jwt.claims', p_claims, true);
  -- An action may be several statements (the period close is: request every
  -- outstanding pair, THEN close). They share one transaction, so a failed close
  -- rolls its own preparation back — exactly what a client retry would see. The last
  -- statement's value is the action's result.
  foreach v_sql in array p_sqls loop
    execute v_sql into v_result;
  end loop;
  return jsonb_build_object('ok', true, 'result', v_result);
exception when others then
  return jsonb_build_object(
    'ok', false,
    'sqlstate', sqlstate,
    'message', sqlerrm
  );
end;
$simexec$;

grant execute on function public.sim_exec(text, text[]) to authenticated;
`;

/**
 * One action, as SQL: become `authenticated`, run it through sim_exec, commit.
 *
 * The explicit transaction is what makes `set local role` scoped to this action; the
 * COMMIT still happens when the RPC raised, because sim_exec swallowed the exception
 * and the outer transaction never entered the aborted state.
 */
export function actionSql(claimsJson, innerStatements, { lockTimeoutMs = null, leaveOpen = false } = {}) {
  const statements = Array.isArray(innerStatements) ? innerStatements : [innerStatements];
  const array = `array[${statements.map((sql) => sqlBlock(sql)).join(", ")}]::text[]`;
  return [
    "begin;",
    "set local role authenticated;",
    // GV-478. `lock_timeout` is USERSET and applies to heavyweight locks of every kind,
    // advisory locks included — which matters, because the RPCs this tool drives
    // serialise themselves with pg_advisory_xact_lock far more often than with row
    // locks. Without it the harness's single thread would sit on a lock its own other
    // session is holding, forever. With it, a collision comes back as 55P03 in a few
    // hundred milliseconds and lib/actions.mjs classifies it as `contention`.
    lockTimeoutMs === null ? "" : `set local lock_timeout = '${Number(lockTimeoutMs)}ms';`,
    `select public.sim_exec(${lit(claimsJson)}, ${array});`,
    // `leaveOpen` is the lock HOLDER's half of a contention scenario: the transaction
    // stays open, and therefore so do its locks, until the scenario sends commit or
    // rollback on the same session. Nothing else in the tool leaves a transaction open.
    leaveOpen ? "" : "commit;",
  ].filter(Boolean).join("\n");
}

/** The claims a member's requests carry — the shape a real Supabase JWT presents. */
export function claimsFor({ sub, email }) {
  return JSON.stringify({ sub, email, role: "authenticated" });
}
