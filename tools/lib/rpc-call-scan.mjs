// Which RPCs does the role-matrix guard exercise, and which of those does any
// client actually call? (GV-379)
//
// This module owns the two scans behind the role-matrix coverage check. It is a
// separate file so tools/test-role-matrix-coverage.mjs can unit-test the scanning
// logic without Docker and without the sibling repos — the same split GV-371 used
// for lib/markup-hex-scan.mjs, and for the same reason: a broken scanner must
// report as a broken scanner, not as a repo full of findings.
//
// ── Why this exists ───────────────────────────────────────────────────────────
//
// GV-277 (migration 114) taught payer-deactivation to suspend a member's recurring
// templates. It taught set_ledger_member_active_admin — which no client calls. Both
// clients deactivate through upsert_ledger_member_admin. The feature was dark from
// migration 114 until migration 145 fixed it, and GVM-330's entire reading half (the
// reassignment sheet, the Activity CTA, the Expenses badge) sat built and unreachable
// that whole time.
//
// The reason CI never noticed is the part worth engineering against: the ONLY caller
// of set_ledger_member_active_admin anywhere is this repo's own role-matrix guard. The
// guard exercised the fixed function, so GV-277 looked green while every real
// deactivation went through the unfixed one. A guard pointed at unreachable code is
// worse than no guard — it actively suppresses suspicion.
//
// So the role-matrix guard now announces the overlap: every function it invokes
// directly that `authenticated` may execute but that no client calls.

import fs from 'node:fs';
import path from 'node:path';

// Directories that never contain hand-written client call sites. `ios`/`android`/`Pods`
// are native build output, `_worker.bundle` is Cloudflare's compiled artifact, and the
// rest are dependency/build trees.
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.expo', '.next', 'ios', 'android', 'Pods',
  'dist', 'build', 'coverage', 'vendor', '_worker.bundle',
]);

// Source shapes a client call can live in. Deliberately broad: the mobile app is
// TS/TSX, the Cloudflare Functions are JS/MJS, and the admin console is JS in HTML.
export const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html',
]);

// The vendored generated DB types declare EVERY RPC in the schema, so they match any
// function name and are never call sites. Excluding them is what makes the scan mean
// "somebody calls this" rather than "this exists".
export const GENERATED_TYPE_FILES = /(^|\/)(database\.ts|database\.generated\.ts|database\.d\.ts|supabase-types\.ts)$/;

/**
 * Functions the role-matrix guard invokes DIRECTLY, read out of its own source.
 *
 * Reading the source (rather than the CASES array at runtime) is deliberate: the guard
 * exercises RPCs from several places — the CASES array's `op`/`setup`/`assert` strings,
 * the fixture SEED block, and the hand-rolled two-session concurrency blocks near the
 * end. One textual sweep covers all of them and cannot fall out of step with a
 * refactor that moves a case between those shapes.
 *
 * Comment lines are stripped first, in both idioms the file mixes: JS `//` and, inside
 * the SQL template literals, `--`. A function named only in prose is discussed, not
 * exercised, and must not be reported as covered.
 */
export function exercisedFunctions(source) {
  const code = source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('--') && !t.startsWith('*');
    })
    .join('\n');

  const found = new Set();
  for (const m of code.matchAll(/public\.([a-z0-9_]+)\s*\(/g)) found.add(m[1]);
  return found;
}

/** Every scannable source file under `dir`, as repo-relative forward-slash paths. */
export function walkSourceFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // isDirectory() is false for symlinks, so a symlinked dir is never followed.
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkSourceFiles(path.join(dir, entry.name), base, out);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * Does `line` invoke `fn` as an RPC?
 *
 * Both call conventions in the two clients are accepted, because a text search that
 * only knew one of them would silently mark the other's targets dead:
 *
 *   1. a quoted name — `supabase.rpc('upsert_ledger_member_admin', …)` (mobile, admin
 *      console) and `sbRpc(env, 'claim_due_confirm_reminders', …)` (Cloudflare
 *      Functions, via the shared helper in functions/api/_push.js);
 *   2. a PostgREST URL path — `fetch(\`${env.SUPABASE_URL}/rest/v1/rpc/check_owner_rate_limit\`)`,
 *      which several owner endpoints use directly with the service-role key.
 *
 * Comment lines are excluded: naming an RPC while explaining what the backend does is
 * not a call, and treating it as one is how a dead function looks alive.
 */
export function lineCallsFunction(line, fn) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('#') || t.startsWith('<!--')) return false;
  return new RegExp(`(['"\`]|/rest/v1/rpc/)${fn}(['"\`]|\\b)`).test(line);
}

/**
 * Scan a client repo for call sites of `names`.
 *
 * Returns Map(name -> [{ file, line }]). A name absent from the map (or mapped to an
 * empty array) has no call site in that repo.
 *
 * NOTE ON INDIRECTION — the known limit of this scan. Cloudflare Functions can call an
 * RPC through a variable: `functions/api/owner/workspace/[id]/lifecycle.js` does
 * `sbRpc(env, rpc, rpcArgs)` where `rpc` comes from the LIFECYCLE_ACTIONS table. Those
 * names still appear as quoted string literals at the table that defines them
 * ('admin_soft_delete_workspace', 'admin_restore_workspace'), so this scan sees them.
 * A name assembled from fragments at runtime would NOT be seen. Nothing in either repo
 * does that today (verified for GV-379); if that ever changes, this scan starts
 * reporting a live function as uncalled, and the reviewed-exception list is where that
 * gets recorded — with the call path written down — rather than silently widened.
 */
export function findClientCallers(repoDir, names) {
  const hits = new Map();
  for (const name of names) hits.set(name, []);

  for (const rel of walkSourceFiles(repoDir)) {
    if (GENERATED_TYPE_FILES.test(rel)) continue;
    let source;
    try {
      source = fs.readFileSync(path.join(repoDir, rel), 'utf8');
    } catch {
      continue;
    }
    // Cheap pre-filter: most files mention none of the names.
    const candidates = [...names].filter((n) => source.includes(n));
    if (candidates.length === 0) continue;

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const name of candidates) {
        if (!lines[i].includes(name)) continue;
        if (lineCallsFunction(lines[i], name)) hits.get(name).push({ file: rel, line: i + 1 });
      }
    }
  }
  return hits;
}
