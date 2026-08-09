// The run journal (GV-471) — one append-only JSONL stream, two consumers.
//
// The dashboard and the end-of-run report read the SAME file. That is the point: a
// live view that is fed by one code path and a report built by another drift, and the
// first thing anyone asks about a fuzzer finding is "what did the dashboard actually
// show". Here the dashboard IS the file, replayed; opening it after the run replays
// the whole run from line 1 and then follows.
//
// Line kinds:
//   run      — the header: seed, config, epoch, workspaces. Always line 1.
//   action   — one attempted action and how the database answered.
//   oracle   — one invariant sweep (per invariant × workspace).
//   violation— an oracle failure or an unclassified rejection.
//   note     — anything a human should see in the ticker (chaos injection, seeding).
//   end      — the run summary. Always the last line.
//
// `ts` (wall clock) and `ms` (measured RPC latency) are the only non-deterministic
// fields and are excluded from the determinism digest by digestOf() below.

import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export class Journal {
  constructor(filePath) {
    this.path = filePath;
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "");
    this.lines = [];
  }

  write(record) {
    // Date.now() here is a display timestamp for the live ticker, never an input to a
    // decision. See lib/prng.mjs for the rule.
    const line = { ts: Date.now(), ...record };
    this.lines.push(line);
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    return line;
  }

  /** The last `n` records, for the violation dump. */
  tail(n) {
    return this.lines.slice(-n);
  }
}

/** Read a journal file back into records (report mode, and the determinism check). */
export function readJournal(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * The determinism digest.
 *
 * Covers the DECISION SEQUENCE — which workspace, which actor, which persona, which
 * action, at which simulated minute, and how the database answered — and deliberately
 * omits `ts`, `ms`, and any uuid the database minted, none of which a replay can or
 * should reproduce. Two runs of the same seed and configuration must produce the same
 * digest; that is what makes the one-line repro in a violation report true.
 *
 * GV-478 ADDED THREE FIELDS, and the tuple changed shape rather than being extended
 * quietly, because a tick is no longer one statement:
 *
 *   dup      — a duplicate send is a separate line with the same tick and action as the
 *              first send. Without this the two would hash identically and a run that
 *              double-sent could not be told from one that did not.
 *   session  — which psql session the statement went to. A contention scenario's three
 *              sub-steps differ only in session and step.
 *   step     — the sub-step: `holder` / `contender` / `holder_commit`, `dup:idempotent`,
 *              `offline-queue@N`, `offline-flush@N`. The offline ones carry the DECISION
 *              tick, so two runs of one seed must agree not merely on what was flushed
 *              but on how long each statement had been waiting.
 *
 * What is NOT in here, on purpose: the simulated weekday and clock label. Both are
 * derived from `--epoch`, which varies with the day a default run happens, while
 * `simOffsetMin` is the epoch-independent half and is already covered.
 */
export function digestOf(records) {
  const hash = createHash("sha256");
  for (const record of records) {
    if (record.kind !== "action") continue;
    hash.update([
      record.tick,
      record.simOffsetMin,
      record.ws,
      record.actorSlot,
      record.persona,
      record.action,
      record.outcome,
      record.guardKind ?? "",
      record.dup ? "dup" : "",
      record.session ?? 0,
      record.step ?? "",
    ].join("|"));
    hash.update("\n");
  }
  return hash.digest("hex");
}
