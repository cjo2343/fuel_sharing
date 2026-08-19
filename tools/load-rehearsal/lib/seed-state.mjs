// GV-494 — the seeder's resume state.
//
// Finding T3: the seeder is "resumable" in the sense that it recovers a workspace
// through `list_my_ledgers` — but that recovery needs a TOKEN, so every pass signed
// in every member of every workspace, including the ones a previous pass had
// already finished. With a ~30 sign-ins per 5 minutes limit (T4), a retry spent its
// whole budget re-verifying built workspaces and never reached the unbuilt ones:
// exercise 1 was stuck at 10–12 of 20 across 13+ rounds.
//
// The fix is a completion marker the seeder can read WITHOUT signing anybody in.
// This module is that marker file: a small JSON map, kept OUTSIDE the repo tree
// (default `~/.vehloshare-rehearsal-seed-state.json`, `--state <file>` to move it),
// written 0600 like the env file it sits next to.
//
// GDPR: the file holds no personal data and no secrets — a project ref, the seed,
// the synthetic email DOMAIN, the generated workspace names and counts. No
// addresses, no tokens, no passwords. (The fixture identities are synthetic anyway,
// but "the state file never grows a token" is a property worth keeping true.)
//
// A marker is only trusted when the plan still matches: the key carries the target
// project + seed + email domain, and the entry carries a SIGNATURE of the
// workspace's planned contents. Change `--seed`, point at a different project, or
// change the fixture generator, and every marker stops matching, so the seeder
// rebuilds rather than skipping work that was never done on THIS project.

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const SEED_STATE_VERSION = 1;
export const DEFAULT_SEED_STATE_FILENAME = ".vehloshare-rehearsal-seed-state.json";

export function defaultSeedStatePath(home = homedir()) {
  return path.join(home, DEFAULT_SEED_STATE_FILENAME);
}

// `https://abcdefgh.supabase.co` → `abcdefgh`. Anything else falls back to the
// host, so a self-hosted or proxied URL still keys the state distinctly.
export function projectRefFromUrl(url) {
  if (!url) return "unknown";
  let host;
  try {
    host = new URL(String(url)).hostname;
  } catch {
    return String(url).replace(/[^a-z0-9.-]/gi, "").slice(0, 64) || "unknown";
  }
  const m = /^([a-z0-9-]+)\.supabase\.(co|in|net)$/i.exec(host);
  return m ? m[1] : host;
}

// The state file must never live inside the repo: it is operator state about a
// throwaway project, it would be committed by accident, and the repo tree is not
// where this toolkit keeps anything run-specific (the env file is outside too).
export function assertStateOutsideRepo(filePath, repoRoot) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(repoRoot);
  const rel = path.relative(root, resolved);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to use a seed-state file inside the repo (${resolved}). ` +
        `Keep it outside the repo tree — the default is ${defaultSeedStatePath()}.`,
    );
  }
  return resolved;
}

// What the seeder promises to have built for a workspace. Two plans with the same
// signature produce the same rows, so a marker written under one is valid for the
// other; anything else (more members, more trips, a different close pattern)
// invalidates the marker.
export function workspaceSignature(ws) {
  const periods = ws.periods ?? [];
  const counts = periods.reduce(
    (acc, p) => {
      acc.trips += (p.trips ?? []).length;
      acc.fuel += (p.fuel ?? []).length;
      acc.expenses += (p.expenses ?? []).length;
      acc.messages += (p.messages ?? []).length;
      if (p.closeAfter) acc.closed++;
      return acc;
    },
    { trips: 0, fuel: 0, expenses: 0, messages: 0, closed: 0 },
  );
  return [
    `v${SEED_STATE_VERSION}`,
    `m${ws.memberCount ?? (ws.members ?? []).length}`,
    `p${periods.length}`,
    `c${counts.closed}`,
    `t${counts.trips}`,
    `f${counts.fuel}`,
    `e${counts.expenses}`,
    `r${(ws.recurring ?? []).length}`,
    `b${(ws.bookings ?? []).length}`,
    `x${counts.messages + (ws.messages ?? []).length}`,
    ws.aged ? "aged" : "small",
  ].join("-");
}

export function workspaceStateKey({ projectRef, seed, emailDomain, name }) {
  return `${projectRef}|seed${seed}|${emailDomain}|${name}`;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    // Missing or corrupt state must never stop a seed — the worst case is that the
    // pass re-verifies everything, which is exactly the old behaviour.
    return null;
  }
}

export class SeedState {
  constructor({ filePath, data = null, enabled = true } = {}) {
    this.filePath = filePath;
    this.enabled = enabled;
    this.data = data && typeof data === "object" && data.workspaces
      ? { version: SEED_STATE_VERSION, ...data }
      : { version: SEED_STATE_VERSION, workspaces: {} };
    this.loadedEntries = Object.keys(this.data.workspaces).length;
  }

  static load({ filePath, enabled = true, ignoreExisting = false } = {}) {
    const raw = ignoreExisting ? null : readJson(filePath);
    const usable = raw && raw.version === SEED_STATE_VERSION ? raw : null;
    return new SeedState({ filePath, data: usable, enabled });
  }

  isComplete(key, signature) {
    if (!this.enabled) return false;
    const entry = this.data.workspaces[key];
    return Boolean(entry && entry.signature === signature);
  }

  markComplete(key, { signature, workspace = null, members = null, at = new Date().toISOString() } = {}) {
    this.data.workspaces[key] = { signature, workspace, members, completedAt: at };
    return this.data.workspaces[key];
  }

  get completedCount() {
    return Object.keys(this.data.workspaces).length;
  }

  // Write atomically (tmp + rename) so a run interrupted mid-write cannot leave a
  // truncated file behind, and 0600 like the env file.
  save() {
    if (!this.filePath) return false;
    const dir = path.dirname(this.filePath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* the directory usually exists; a real failure surfaces on write below */
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
    return true;
  }
}
