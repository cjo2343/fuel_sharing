#!/usr/bin/env node
// Release gates — the known launch blockers, as code (GV-422).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Everything that stands between this project and a public release is currently
// written down in prose: DEPLOY-CHECKLIST.md (GV-338), the go-live gates on
// GV-104, the "Release-beslutning" paragraph in docs/gdpr/backup-restore.md, a
// square-bracket placeholder sitting in a live privacy page. Prose checklists
// have one failure mode and this project has hit it repeatedly: the item stays
// true, the document stops being read, and nothing anywhere turns red. The
// privacy page has shipped `[DATAANSVARLIG: … udfyldes før publicering]` to
// production for months; the restore drill's own doc says the saved dump "vil
// fejle med det samme"; the backup posture is still Free plan, i.e. no backups
// at all. Every one of those is a launch blocker that no CI job has an opinion
// about.
//
// This script gives them an opinion. It does not discover new problems — it
// asserts the ones we already know about, so that "we are ready to release"
// becomes a command that either exits 0 or names what is left.
//
//   node tools/check-release-gates.mjs            # local: blockers WARN, exit 0
//   node tools/check-release-gates.mjs --strict   # umbrella / pre-release: blockers FAIL
//
// ---------------------------------------------------------------------------
// THE THREE SEVERITIES (this is the whole design)
// ---------------------------------------------------------------------------
//   • blocked      — a real launch blocker is present and we can see it.
//                    WARN locally, FAIL under --strict.
//   • unavailable  — the state a gate judges lives outside this repo (a sibling
//                    checkout, an external service) and could not be read, so the
//                    gate certified NOTHING. WARN locally, FAIL under --strict.
//                    Same tolerate-missing convention as check-token-drift.mjs
//                    (GV-256) and check-hotpath-mirror.mjs (GV-393): a missing
//                    sibling can never be a hard failure by default, or
//                    fuel_sharing's own CI — which checks out this repo alone —
//                    would be red forever.
//   • error        — the evidence this script reads lives IN this repo and is
//                    missing or unparseable, or a validator it delegates to
//                    failed. That is a defect in the repo or in this guard, not
//                    a launch blocker, and it FAILS in every mode. A guard that
//                    shrugs when it cannot read its own inputs is the failure
//                    mode GV-393 documented at length.
//
// The distinction is the point. "I looked and it is broken" and "I could not
// look" must never print the same line, because the second one is how a guard
// spends a year certifying nothing (the GV-379 role-matrix coverage half, the
// GV-393 hot-path tautology).
//
// ---------------------------------------------------------------------------
// WHY IT IS NOT IN `npm run validate`
// ---------------------------------------------------------------------------
// Deliberate; see the comment beside the `scripts` array in
// tools/run-validations.mjs. These gates measure the state of the PRODUCT
// (a paid Supabase plan, a human attestation, a drill someone has to run by
// hand), not the state of the commit. Wiring them into the per-commit gate
// would make every unrelated commit red for reasons its author cannot fix,
// which is precisely how a red build stops meaning anything.
//
// ---------------------------------------------------------------------------
// THE GATES
// ---------------------------------------------------------------------------
//  1. Privacy placeholder — govehlo-web's published pages must not contain the
//     data-controller placeholder or any "udfyldes før publicering" marker.
//     (Needs the sibling checkout; unavailable without it.)
//  2. Migrations registered — every file in supabase/migrations/ is in
//     tools/test-migrations.mjs's expected array AND is INSERTed into the
//     consolidated schema's tracker. Delegated to tools/test-migrations.mjs
//     rather than reimplemented: that script (plus lib/tracker-insert-scan.mjs)
//     already answers exactly this question, and a second implementation would
//     be a second thing to keep in sync — the tautology GV-393 killed.
//  3. Backup evidence — docs/gdpr/backup-restore.md's dashboard verification is
//     no older than 90 days, and the documented plan is no longer Free. The Free
//     plan IS the blocker GV-313 tracks: the doc itself says nul-backup "er ikke
//     acceptabel til reel produktion".
//  4. Restore drill vs. schema — the drill log's `Seneste drill: migration NNN`
//     marker is within 15 migrations of the highest migration in the repo.
//     Beyond that the saved dump cannot even be restored (the drill derives its
//     freshness requirement from the same expected list, GV-325).
//  5. External attestations — app-link secrets and Sentry source maps live in
//     Apple/Google/Sentry consoles, so no repo can observe them. They are
//     attested in docs/release-attestations.json, and an attestation older than
//     30 days has stopped being evidence.
//
// Deliberately NOT a gate: this script does not try to verify CI from outside
// (whether the umbrella ran, whether a secret is set). A checker that grades its
// own CI from the outside is the least trustworthy participant in the loop; the
// umbrella's self-reporting is fixed at its source instead, in
// .github/workflows/umbrella.yml.
//
// Pure logic below is exported for tools/test-release-gates.mjs, which drives
// every gate red and green against fixtures — same pattern as
// test-hotpath-mirror-scan.mjs / test-tracker-insert-scan.mjs.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Tunables (also the numbers the messages quote) ───────────────────────────
export const BACKUP_EVIDENCE_MAX_AGE_DAYS = 90; // = the documented quarterly drill cadence
export const DRILL_MAX_MIGRATION_LAG = 15;
export const ATTESTATION_MAX_AGE_DAYS = 30;

export const ATTESTATION_FILE = "docs/release-attestations.json";
export const BACKUP_DOC = "docs/gdpr/backup-restore.md";

/** Directories never worth walking in a sibling checkout. */
const SKIP_DIRS = new Set([
  ".git",
  ".wrangler",
  ".claude",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "_worker.bundle", // generated Pages bundle — a copy of files already scanned
]);

// The placeholder markers. `[DATAANSVARLIG` is the exact one live in
// govehlo-web/privatliv/index.html; the second is the generic "fill this in
// before publishing" marker the same authoring pass leaves behind elsewhere.
export const PLACEHOLDER_MARKERS = ["[DATAANSVARLIG", "udfyldes før publicering"];

// ── Result helpers ───────────────────────────────────────────────────────────

export const SEVERITY = { PASS: "pass", BLOCKED: "blocked", UNAVAILABLE: "unavailable", ERROR: "error" };

function pass(id, title, detail) {
  return { id, title, severity: SEVERITY.PASS, details: detail ? [detail] : [] };
}
function blocked(id, title, details) {
  return { id, title, severity: SEVERITY.BLOCKED, details };
}
function unavailable(id, title, details) {
  return { id, title, severity: SEVERITY.UNAVAILABLE, details };
}
function error(id, title, details) {
  return { id, title, severity: SEVERITY.ERROR, details };
}

// ── Gate 1: privacy / publication placeholders ───────────────────────────────

/**
 * Every published page in a govehlo-web checkout, as repo-relative paths.
 *
 * `.html` is the published surface; `functions/**\/*.js` is included because the
 * join route and the error pages are SERVER-RENDERED HTML that never exists as a
 * .html file — exactly the blind spot the GV-371 markup scan found for colours.
 */
export function collectPublishedPages(webRoot) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      // isDirectory() is false for symlinks, so a symlinked dir is never followed.
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(webRoot, abs).split(sep).join("/");
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".html" || ext === ".htm" || (rel.startsWith("functions/") && ext === ".js")) {
        out.push(rel);
      }
    }
  };
  walk(webRoot);
  return out.sort();
}

/**
 * One finding per offending LINE, not per marker: the live placeholder in
 * privatliv/index.html contains both markers on the same line, and reporting it
 * twice makes one problem look like two.
 *
 * @param {{file: string, source: string}[]} entries
 * @returns {{file: string, line: number, markers: string[], text: string}[]}
 */
export function findPlaceholders(entries) {
  const found = [];
  for (const { file, source } of entries) {
    const lines = source.split("\n");
    for (const [i, line] of lines.entries()) {
      const markers = PLACEHOLDER_MARKERS.filter((marker) => line.includes(marker));
      if (markers.length === 0) continue;
      found.push({ file, line: i + 1, markers, text: line.trim().slice(0, 140) });
    }
  }
  return found;
}

function gatePrivacyPlaceholders(webRoot) {
  const id = "privacy-placeholder";
  const title = "govehlo-web publishes no unfilled placeholder";
  if (!webRoot || !existsSync(webRoot)) {
    return unavailable(id, title, [
      `govehlo-web not found at ${webRoot} — the published pages were NOT scanned.`,
      "Check the sibling repo out alongside fuel_sharing (or run in the umbrella workflow) to make this gate real.",
    ]);
  }
  const files = collectPublishedPages(webRoot);
  if (files.length === 0) {
    return error(id, title, [
      `no published pages found under ${webRoot} — the scanner found nothing to read, which is a scanner or path bug, not a clean bill of health.`,
    ]);
  }
  const entries = files.map((file) => ({ file, source: readFileSync(join(webRoot, file), "utf8") }));
  const findings = findPlaceholders(entries);
  if (findings.length === 0) {
    return pass(id, title, `${files.length} published pages scanned, no placeholder markers.`);
  }
  return blocked(id, title, [
    "govehlo-web still publishes unfilled placeholder text:",
    ...findings.map((f) => `  - ${f.file}:${f.line}: ${f.text}`),
    "Fill in the real controller identity (GV-177 — blocked on the CVR) and remove the marker before public release.",
  ]);
}

// ── Gate 2: every migration registered ───────────────────────────────────────

function gateMigrationsRegistered(repoRoot, runMigrationValidator) {
  const id = "migrations-registered";
  const title = "every migration is registered and mirrored";
  try {
    runMigrationValidator(repoRoot);
    const count = listMigrationFiles(repoRoot).length;
    return pass(id, title, `tools/test-migrations.mjs passed (${count} migrations registered + tracker-mirrored).`);
  } catch (e) {
    return error(id, title, [
      "tools/test-migrations.mjs failed — a migration is missing from the `expected` array in that file,",
      "or its id is never INSERTed into supabase-schema.sql's tracker. See DEPLOY-CHECKLIST.md §1.",
      ...String(e.stdout || e.message || e)
        .trim()
        .split("\n")
        .slice(0, 12)
        .map((line) => `  ${line}`),
    ]);
  }
}

function defaultMigrationValidator(repoRoot) {
  execFileSync(process.execPath, ["tools/test-migrations.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function listMigrationFiles(repoRoot) {
  const dir = join(repoRoot, "supabase", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export function highestMigrationNumber(files) {
  let highest = 0;
  for (const file of files) {
    const m = /^(\d{3})_/.exec(file);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return highest;
}

// ── Gates 3 + 4: backup evidence + restore drill ─────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * `Dashboard-verifikation udført **YYYY-MM-DD**` + `- Plan: **X**.`
 * Returns nulls rather than throwing; the caller decides what a missing field means.
 */
export function parseBackupEvidence(markdown) {
  const dateMatch = /Dashboard-verifikation udført\s+\*\*(\d{4}-\d{2}-\d{2})\*\*/.exec(markdown);
  const planMatch = /^-\s*Plan:\s*\*\*([^*]+)\*\*/m.exec(markdown);
  return {
    verifiedOn: dateMatch ? dateMatch[1] : null,
    plan: planMatch ? planMatch[1].trim() : null,
  };
}

export function evaluateBackupEvidence({ verifiedOn, plan }, today, maxAgeDays = BACKUP_EVIDENCE_MAX_AGE_DAYS) {
  const problems = [];
  const errors = [];
  if (!verifiedOn || !ISO_DATE.test(verifiedOn)) {
    errors.push(
      `could not read the verification date — ${BACKUP_DOC} must contain a line of the form ` +
        '"Dashboard-verifikation udført **YYYY-MM-DD**".',
    );
  } else {
    const age = daysBetween(verifiedOn, today);
    if (age > maxAgeDays) {
      problems.push(
        `backup posture last verified ${verifiedOn} — ${age} days ago, over the ${maxAgeDays}-day limit. ` +
          "Re-check the Supabase dashboard and update the doc; stale evidence is not evidence.",
      );
    }
  }
  if (!plan) {
    errors.push(`could not read the documented plan — ${BACKUP_DOC} must contain a line of the form "- Plan: **Pro**.".`);
  } else if (/^free$/i.test(plan)) {
    problems.push(
      "the documented Supabase plan is still **Free**, which means there are NO managed backups and no PITR — " +
        "the doc's own Release-beslutning calls that unacceptable for real production. Upgrade to at least Pro (GV-313).",
    );
  }
  return { problems, errors, verifiedOn, plan };
}

function gateBackupEvidence(repoRoot, today) {
  const id = "backup-evidence";
  const title = "backup posture is current and not Free-plan";
  const docPath = join(repoRoot, BACKUP_DOC);
  if (!existsSync(docPath)) {
    return error(id, title, [`${BACKUP_DOC} is missing — the backup evidence this gate reads does not exist.`]);
  }
  const parsed = parseBackupEvidence(readFileSync(docPath, "utf8"));
  const { problems, errors } = evaluateBackupEvidence(parsed, today);
  if (errors.length > 0) return error(id, title, errors);
  if (problems.length > 0) return blocked(id, title, problems);
  return pass(id, title, `plan ${parsed.plan}, dashboard verified ${parsed.verifiedOn}.`);
}

/**
 * `Seneste drill: migration NNN (YYYY-MM-DD)` — the single machine-readable line in
 * the drill log. Before GV-422 the same fact was only in prose ("kørte på et dump ved
 * migration 133"), which is why nothing could check it.
 */
export function parseDrillMarker(markdown) {
  const m = /^Seneste drill:\s*migration\s*(\d{1,4})\s*\((\d{4}-\d{2}-\d{2})\)/m.exec(markdown);
  if (!m) return { migration: null, date: null };
  return { migration: Number(m[1]), date: m[2] };
}

export function evaluateDrillLag({ migration, date }, highest, maxLag = DRILL_MAX_MIGRATION_LAG) {
  const problems = [];
  const errors = [];
  if (migration === null) {
    errors.push(
      `could not read the last drill's migration — ${BACKUP_DOC}'s drill log must carry a line of the form ` +
        '"Seneste drill: migration NNN (YYYY-MM-DD)".',
    );
    return { problems, errors };
  }
  if (!highest) {
    errors.push("could not determine the highest migration in supabase/migrations/ — nothing to compare the drill against.");
    return { problems, errors };
  }
  const lag = highest - migration;
  if (lag > maxLag) {
    problems.push(
      `the last restore drill (${date}) ran at migration ${migration}; the repo is at ${highest} — ${lag} migrations behind, ` +
        `over the ${maxLag}-migration limit. The saved dump would fail the drill's own freshness assert (GV-325), so there is ` +
        "currently no proof that a production backup can be restored. Take a fresh pg_dump and run `npm run drill:restore`.",
    );
  }
  return { problems, errors, lag };
}

function gateRestoreDrill(repoRoot, migrationFiles) {
  const id = "restore-drill-freshness";
  const title = "restore drill is close to the current schema";
  const docPath = join(repoRoot, BACKUP_DOC);
  if (!existsSync(docPath)) {
    return error(id, title, [`${BACKUP_DOC} is missing — the drill log this gate reads does not exist.`]);
  }
  const marker = parseDrillMarker(readFileSync(docPath, "utf8"));
  const highest = highestMigrationNumber(migrationFiles);
  const { problems, errors, lag } = evaluateDrillLag(marker, highest);
  if (errors.length > 0) return error(id, title, errors);
  if (problems.length > 0) return blocked(id, title, problems);
  return pass(id, title, `last drill at migration ${marker.migration} (${marker.date}), repo at ${highest} — ${lag} behind.`);
}

// ── Gate 5: external attestations ────────────────────────────────────────────

/**
 * The attestation file is the only honest way to gate state that exists in no
 * repo: an Apple/Google app-link association served from a console, a Sentry
 * release whose source maps were uploaded by a build machine. The rule is that
 * a human writes down what they verified and when, and the claim expires.
 */
export function evaluateAttestations(doc, today, maxAgeDays = ATTESTATION_MAX_AGE_DAYS) {
  const problems = [];
  const errors = [];
  if (!doc || typeof doc !== "object" || typeof doc.attestations !== "object" || doc.attestations === null) {
    errors.push(`${ATTESTATION_FILE} must be a JSON object with an "attestations" object.`);
    return { problems, errors };
  }
  const entries = Object.entries(doc.attestations);
  if (entries.length === 0) {
    errors.push(`${ATTESTATION_FILE} lists no attestations — an empty list would pass this gate while proving nothing.`);
    return { problems, errors };
  }
  for (const [key, entry] of entries) {
    if (!entry || typeof entry !== "object") {
      errors.push(`${key}: entry must be an object with state / verified_on / attested_by / note.`);
      continue;
    }
    if (typeof entry.note !== "string" || entry.note.trim().length < 30) {
      errors.push(`${key}: "note" must say what is being attested, to a reader with no context.`);
      continue;
    }
    if (entry.state !== "verified") {
      problems.push(
        `${key}: state is "${entry.state}" — not attested. ${entry.note.trim()} ` +
          `Verify it, then set state/verified_on/attested_by in ${ATTESTATION_FILE}.`,
      );
      continue;
    }
    if (typeof entry.attested_by !== "string" || entry.attested_by.trim() === "") {
      errors.push(`${key}: state is "verified" but "attested_by" is empty — an unsigned attestation is not one.`);
      continue;
    }
    if (typeof entry.verified_on !== "string" || !ISO_DATE.test(entry.verified_on)) {
      errors.push(`${key}: state is "verified" but "verified_on" is not a YYYY-MM-DD date.`);
      continue;
    }
    const age = daysBetween(entry.verified_on, today);
    if (age > maxAgeDays) {
      problems.push(
        `${key}: attested ${entry.verified_on} by ${entry.attested_by} — ${age} days ago, over the ${maxAgeDays}-day limit. ` +
          "Re-verify and re-date it; an expired attestation describes a state nobody has looked at since.",
      );
    }
  }
  return { problems, errors };
}

function gateAttestations(repoRoot, today) {
  const id = "external-attestations";
  const title = "app-link secrets + Sentry source maps are attested";
  const filePath = join(repoRoot, ATTESTATION_FILE);
  if (!existsSync(filePath)) {
    return error(id, title, [
      `${ATTESTATION_FILE} is missing — this gate has nothing to read, so nothing is attested.`,
      "Recreate it (see the _README block in the version this ticket added) rather than deleting the gate.",
    ]);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    return error(id, title, [`${ATTESTATION_FILE} is not valid JSON: ${e.message}`]);
  }
  const { problems, errors } = evaluateAttestations(doc, today);
  if (errors.length > 0) return error(id, title, errors);
  if (problems.length > 0) return blocked(id, title, problems);
  return pass(id, title, `${Object.keys(doc.attestations).length} attestations verified and in date.`);
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run every gate and return the results. All inputs are injectable so
 * tools/test-release-gates.mjs can drive each gate red and green against
 * fixtures without touching the real repo.
 */
// ── Gate 6: the mobile build's schema generation vs what prod has APPLIED ──────
//
// GV-429 (external review P2): nothing automatic proved that a mobile build is not
// released AHEAD of its own migration. The merge-order discipline (SQL before client)
// is process, and PGRST202 parking makes the failure soft — but a gate should catch
// the day the process slips. The proxy for "applied in prod" is deliberately LOCAL:
// govehlo-web's EXPECTED_LATEST_MIGRATION moves only in the post-apply bump PR (the
// deferred pattern every migration follows), so the sibling checkout's constant is a
// floor on what production has run. A stale web checkout can only make this gate
// falsely BLOCK (constant too low), never falsely pass — the conservative direction.
// No network: this tool judges checkouts, like every gate above it.
//
// GV-434 (external review P2, the known trade-off written into the paragraph above):
// the constant is a discipline FLOOR, not proof of applied SQL. When the operator
// opts in — RELEASE_GATE_SUPABASE_URL + RELEASE_GATE_SUPABASE_SERVICE_ROLE_KEY in the
// environment — the gate reads public.fuel_ledger_schema_migrations itself and judges
// against what production has ACTUALLY applied. Three deliberate boundaries:
//
//   • The env names are DEDICATED. The load-rehearsal env file exports plain
//     SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY for a throwaway project; generic names
//     here would let a sourced rehearsal shell silently point "prod applied" at the
//     wrong database. Nothing short of the RELEASE_GATE_ prefix may activate this.
//   • No CI secret. The ticket parks that decision explicitly — a service key in CI
//     is its own attack surface — so these variables belong on the owner's machine
//     (and nowhere else) until that decision is made deliberately. Without them the
//     gate is byte-for-byte the offline floor it always was.
//   • Configured-but-broken is NOT the same as unconfigured. If the variables are
//     set and the lookup fails, the operator asked for live verification and did not
//     get it: the gate reports UNAVAILABLE (fails --strict) rather than quietly
//     re-certifying via the floor — "I could not look" must never print as "I looked".

/** Max applied migration number out of PostgREST rows of {migration_id}, or null. */
export function parseAppliedFromRows(rows) {
  if (!Array.isArray(rows)) return null;
  let max = null;
  for (const row of rows) {
    const m = /^(\d+)/.exec(String(row && row.migration_id ? row.migration_id : ""));
    if (!m) continue;
    const n = Number(m[1]);
    if (max == null || n > max) max = n;
  }
  return max;
}

/**
 * Resolve the live applied-migration number, or describe why we could not.
 * Returns null when the gate is not configured for live lookup (the default),
 * { applied, host } on success, { error } on any failure with the variables set.
 */
export async function fetchAppliedMigration(env = process.env, fetchImpl = globalThis.fetch) {
  const url = env.RELEASE_GATE_SUPABASE_URL;
  const key = env.RELEASE_GATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!url && !key) return null;
  if (!url || !key) {
    return {
      error:
        "half-configured: exactly one of RELEASE_GATE_SUPABASE_URL / " +
        "RELEASE_GATE_SUPABASE_SERVICE_ROLE_KEY is set. Set both or neither.",
    };
  }
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return { error: "RELEASE_GATE_SUPABASE_URL is not a URL." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/rest/v1/fuel_ledger_schema_migrations?select=migration_id`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) return { error: `tracker lookup returned HTTP ${res.status} (host ${host}).` };
    const applied = parseAppliedFromRows(await res.json());
    if (applied == null) {
      return { error: `tracker lookup succeeded but no migration_id parsed (host ${host}) — wrong project?` };
    }
    return { applied, host };
  } catch (e) {
    return { error: `tracker lookup failed: ${e.name === "AbortError" ? "timed out after 10s" : e.message} (host ${host}).` };
  } finally {
    clearTimeout(timer);
  }
}

/** DB_TYPES_GENERATION.migration out of the mobile sibling, or null. */
export function parseMobileGeneration(source) {
  const m = /migration:\s*(\d+)\s*,/.exec(source);
  return m ? Number(m[1]) : null;
}

/** EXPECTED_LATEST_MIGRATION out of the web sibling, or null. */
export function parseWebExpected(source) {
  const m = /EXPECTED_LATEST_MIGRATION\s*=\s*(\d+)/.exec(source);
  return m ? Number(m[1]) : null;
}

function gateMobileSchemaVsApplied(webRoot, mobileRoot, live = null) {
  const title = "Mobile build does not run ahead of the applied schema";
  const mobilePath = join(mobileRoot, "src", "types", "database-generation.ts");
  const webPath = join(webRoot, "functions", "api", "owner", "migrations.js");
  if (!existsSync(mobilePath) || !existsSync(webPath)) {
    const missing = [
      existsSync(mobilePath) ? null : "govehlo-mobile",
      existsSync(webPath) ? null : "govehlo-web",
    ].filter(Boolean);
    return unavailable("mobile-schema-vs-applied", title, [
      `Sibling checkout missing: ${missing.join(", ")} — the build-vs-applied comparison did not run.`,
    ]);
  }
  const generation = parseMobileGeneration(readFileSync(mobilePath, "utf8"));
  const expected = parseWebExpected(readFileSync(webPath, "utf8"));
  if (generation == null || expected == null) {
    return error("mobile-schema-vs-applied", title, [
      generation == null
        ? `Could not parse DB_TYPES_GENERATION.migration from ${mobilePath} — the file lost its format.`
        : `Could not parse EXPECTED_LATEST_MIGRATION from ${webPath} — the file lost its format.`,
    ]);
  }
  const floorBlocked = generation > expected;
  const floorDetail =
    `The mobile build was generated against migration ${generation}, but the applied-schema floor ` +
    `(govehlo-web's post-apply constant) is ${expected}. Releasing this build ships RPC arguments ` +
    `production does not have. Apply the platform SQL and merge the drift-bump PR first — or pull ` +
    `the govehlo-web sibling if it is simply behind origin/main.`;

  // GV-434: live lookup was configured but failed. The floor verdict still stands
  // for what it can certify, but this run must not read as a completed live check.
  if (live && live.error) {
    if (floorBlocked) return blocked("mobile-schema-vs-applied", title, [floorDetail, `Live lookup also failed: ${live.error}`]);
    return unavailable("mobile-schema-vs-applied", title, [
      `Live tracker lookup was configured but failed: ${live.error}`,
      `The local floor alone is satisfied (generation ${generation} ≤ floor ${expected}) — that certifies ` +
        `the merge-order discipline, not what production has applied. Fix the lookup or unset the ` +
        `RELEASE_GATE_* variables to run the offline floor deliberately.`,
    ]);
  }

  // GV-434: live truth available — judge against it, and audit the floor with it.
  if (live && live.applied != null) {
    const details = [];
    if (generation > live.applied) {
      details.push(
        `The mobile build was generated against migration ${generation}, but production has APPLIED ` +
          `only ${live.applied} (live tracker read, host ${live.host}). Apply the platform SQL first.`,
      );
    }
    if (expected > live.applied) {
      details.push(
        `govehlo-web's EXPECTED_LATEST_MIGRATION (${expected}) is AHEAD of what production has applied ` +
          `(${live.applied}, live) — the drift-bump merged before its SQL ran, so the local floor now ` +
          `overstates production and every offline run of this gate trusts a lie. Apply the SQL, or ` +
          `revert the bump until it is applied.`,
      );
    }
    if (details.length > 0) return blocked("mobile-schema-vs-applied", title, details);
    return pass(
      "mobile-schema-vs-applied",
      title,
      `Mobile generation ${generation} ≤ applied ${live.applied} (LIVE tracker read, host ${live.host}); ` +
        `local floor ${expected} consistent.`,
    );
  }

  if (floorBlocked) return blocked("mobile-schema-vs-applied", title, [floorDetail]);
  return pass(
    "mobile-schema-vs-applied",
    title,
    `Mobile generation ${generation} ≤ applied floor ${expected}.`,
  );
}

export function runGates({
  repoRoot = REPO_ROOT,
  webRoot = join(repoRoot, "..", "govehlo-web"),
  mobileRoot = join(repoRoot, "..", "govehlo-mobile"),
  today = new Date().toISOString().slice(0, 10),
  runMigrationValidator = defaultMigrationValidator,
  // GV-434: resolved BEFORE this sync runner (see main) so every gate stays a pure
  // function of its inputs and the test harness never has to mock the network.
  liveApplied = null,
} = {}) {
  const migrationFiles = listMigrationFiles(repoRoot);
  return [
    gatePrivacyPlaceholders(webRoot),
    gateMigrationsRegistered(repoRoot, runMigrationValidator),
    gateBackupEvidence(repoRoot, today),
    gateRestoreDrill(repoRoot, migrationFiles),
    gateAttestations(repoRoot, today),
    gateMobileSchemaVsApplied(webRoot, mobileRoot, liveApplied),
  ];
}

export function summarise(results, strict) {
  const counts = { pass: 0, blocked: 0, unavailable: 0, error: 0 };
  for (const r of results) counts[r.severity] += 1;
  const failed = counts.error > 0 || (strict && (counts.blocked > 0 || counts.unavailable > 0));
  return { counts, failed };
}

async function main() {
  const strict = process.argv.includes("--strict");
  // GV-434: the only async step, resolved up front. null = not configured (the
  // default offline run); the gate itself never touches the network.
  const liveApplied = await fetchAppliedMigration();
  const results = runGates({ liveApplied });
  const { counts, failed } = summarise(results, strict);

  // ONE stream, ONE write. The first CI run of this script split pass lines onto
  // stdout and failure lines onto stderr, and GitHub's log merge interleaved them:
  // the "158 migrations registered" detail printed under the RESTORE-DRILL heading,
  // attributing a pass to a blocked gate. A report about misleading output must not
  // be misleading output.
  const icon = { pass: "✓", blocked: "✗", unavailable: "?", error: "!" };
  const out = [];
  for (const r of results) {
    out.push(`${icon[r.severity]} [${r.severity.toUpperCase()}] ${r.id}: ${r.title}`);
    for (const detail of r.details) out.push(`    ${detail}`);
  }

  out.push(
    `\ncheck-release-gates: ${counts.pass} pass, ${counts.blocked} blocked, ` +
      `${counts.unavailable} unavailable, ${counts.error} error (mode: ${strict ? "strict" : "advisory"}).`,
  );

  if (counts.unavailable > 0 && !strict) {
    out.push(
      "⚠ check-release-gates: at least one gate could not read the state it judges — it certified NOTHING. " +
        "Check the sibling repo(s) out alongside fuel_sharing for a complete run.",
    );
  }
  if (counts.blocked > 0 && !strict) {
    out.push(
      "⚠ check-release-gates: known launch blockers are present (listed above). This run is advisory; " +
        "`--strict` — which is what the umbrella workflow runs — fails on them.",
    );
  }

  if (failed) {
    out.push(
      "\nRelease gates FAILED. Each line above names the state to change, not the check to delete; " +
        "the gates exist because the same items sat unnoticed in prose checklists (DEPLOY-CHECKLIST.md, GV-104).",
    );
    process.stdout.write(`${out.join("\n")}\n`);
    process.exit(1);
  }
  // Advisory mode exits 0 with blockers outstanding — but it must never claim they
  // are absent. "Exit code 0" and "ready to release" are different statements, and
  // conflating them is the whole bug class this script was written for.
  out.push(
    counts.blocked > 0 || counts.unavailable > 0
      ? "check-release-gates: advisory run complete — NOT release-ready; the items above are still open. " +
        "Re-run with --strict once they are cleared."
      : "check-release-gates: OK — no known launch blocker detected.",
  );
  process.stdout.write(`${out.join("\n")}\n`);
}

// Only run when invoked directly, so the unit test can import the pure logic.
if (process.argv[1] && process.argv[1].endsWith("check-release-gates.mjs")) {
  main().catch((e) => {
    process.stderr.write(`check-release-gates: unexpected failure: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
