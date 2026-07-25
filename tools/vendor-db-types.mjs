#!/usr/bin/env node
// Fan the canonical shared DB/RPC types out to the two client repos (GV-391).
//
// `npm run gen:db-types` writes ONE artifact — fuel_sharing/types/database.ts — and
// fuel_sharing's own CI (check:db-types) proves it is fresh against the consolidated
// schema. That is only half the GV-223 contract. Each client repo vendors a
// byte-identical copy at a FIXED path, and nothing in fuel_sharing's own CI can see
// those copies, because it checks this repo out alone. The umbrella workflow is the
// only place all three repos coexist, so it is the only place the copies are compared.
//
// ── Why this script exists (the failure it is closing) ────────────────────────
//
// govehlo-web's copy sat three migrations stale (143 vs 146) and the umbrella was red
// for 18 consecutive runs before anyone noticed. The interesting part is WHY, because
// it was not carelessness:
//
//   Every migration already ships a govehlo-web commit — the /new-migration checklist
//   makes you bump EXPECTED_LATEST_MIGRATION in functions/api/owner/migrations.js.
//   Through migration 143, that same commit also re-vendored types/database.ts:
//     f12da71 "sync migration 143 contract"  -> migrations.js + types/database.ts
//     bce163e "sync migration 142 contract"  -> migrations.js + types/database.ts
//   From 144 on, the constant was bumped and the types were not:
//     4bb1f51 "expect migration 144"         -> migrations.js only
//     ca7f0e9 "expect migration 145"         -> migrations.js only
//     9a59e58 "expect migration 146"         -> migrations.js only
//
// The carrier commit never went missing; the second artifact fell out of it, because
// the written checklist (CLAUDE.md step 5, /new-migration step 7) names the constant
// and does not name the vendored types. Whoever did 144-146 followed the documented
// procedure exactly and still produced drift. govehlo-mobile stays in sync for a
// reason that is luck, not process: mobile feature tickets CALL the new RPCs, so the
// types get refreshed as a side effect of work that would not compile otherwise. Web
// calls almost none of them, so nothing local ever pushes back.
//
// A checklist step is only as good as how cheap it is to do. Hence one command that
// knows both destination paths — including the one that is easy to get wrong: mobile's
// copy is `database.generated.ts`, NOT `database.ts` (src/types/database.ts is a
// pre-existing hand-written file that predates GV-223 and must never be overwritten).
//
//   npm run vendor:db-types      # copy canonical -> both client repos
//   npm run vendor:db-types -- --check   # report drift, exit 1 if any (CI mode)
//
// --strict makes an ABSENT sibling repo a failure instead of a warning — same
// convention, same reason, as tools/check-token-drift.mjs and
// tools/test-rls-role-matrix.mjs: outside the umbrella the siblings are legitimately
// not checked out, so their absence cannot be red by default. The umbrella runs
// `--check --strict`, where all three repos are guaranteed present.
//
// A vendored copy that is MISSING entirely stays a warning even under --strict: that
// is the GV-223 phase-2 tolerance (a client that has not vendored yet is not drift),
// and --strict here means "every sibling repo must be checked out", nothing more.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO = process.cwd();
const CANONICAL = path.join(REPO, "types", "database.ts");

const CHECK = process.argv.includes("--check");
const STRICT = process.argv.includes("--strict");
const IN_ACTIONS = Boolean(process.env.GITHUB_ACTIONS);

// The phase-2 contract: exact vendored paths, one per client repo. Changing either
// path here without changing it in the client repo silently disarms the check, so
// these two lines are the contract — keep them and the umbrella comment in step.
const CLIENTS = [
  { label: "govehlo-mobile", dir: "../govehlo-mobile", copy: "src/types/database.generated.ts" },
  { label: "govehlo-web", dir: "../govehlo-web", copy: "types/database.ts" },
];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// GitHub annotations surface in the run summary, not just the log body — the point of
// this ticket is that a warning nobody scrolls to is a warning that does not exist.
function warn(title, msg) {
  log(IN_ACTIONS ? `::warning title=${title}::${msg}` : `⚠ ${msg}`);
}

function error(title, msg) {
  log(IN_ACTIONS ? `::error title=${title}::${msg}` : `❌ ${msg}`);
}

function md5(file) {
  return createHash("md5").update(fs.readFileSync(file)).digest("hex");
}

if (!fs.existsSync(CANONICAL)) {
  error(
    "Canonical DB types missing",
    `${CANONICAL} does not exist — run \`npm run gen:db-types\` in fuel_sharing and commit the result.`,
  );
  process.exit(1);
}

const canonicalSum = md5(CANONICAL);
const canonicalBytes = fs.readFileSync(CANONICAL);
const provenance = (canonicalBytes.toString("utf8").split("\n").find((l) => l.startsWith("// Source:")) ?? "").trim();

log(`Canonical: types/database.ts  md5 ${canonicalSum}`);
if (provenance) log(`           ${provenance.replace(/^\/\/\s*/, "")}`);
log("");

let failed = false;
const stale = [];

for (const { label, dir, copy } of CLIENTS) {
  const repoDir = path.join(REPO, dir);
  const dest = path.join(repoDir, copy);

  if (!fs.existsSync(repoDir)) {
    // Not checked out. Unknowable, not clean — never report this as a pass.
    if (STRICT) {
      failed = true;
      error(
        `Sibling repo missing (${label})`,
        `--strict requires ${label} to be checked out at ${dir}; the vendored copy could not be compared.`,
      );
    } else {
      warn(
        `Sibling repo missing (${label})`,
        `${label} not found at ${dir} — its vendored copy was NOT checked. Check it out alongside fuel_sharing, or run with --strict to make this a failure.`,
      );
    }
    continue;
  }

  if (CHECK) {
    if (!fs.existsSync(dest)) {
      // GV-223 phase-2 tolerance: never vendored is not the same as drifted.
      warn(
        `DB types not vendored (${label})`,
        `${label} has no vendored copy at ${copy} yet. Vendor it byte-identically at that exact path (npm run vendor:db-types) to arm this check.`,
      );
      continue;
    }
    const sum = md5(dest);
    if (sum === canonicalSum) {
      log(`  ok    ${label}: ${copy} matches canonical (md5 ${sum})`);
    } else {
      failed = true;
      stale.push(label);
      error(
        `DB type drift (${label})`,
        `${label}/${copy} (md5 ${sum}) differs from the canonical fuel_sharing/types/database.ts (md5 ${canonicalSum}). Fix: in fuel_sharing, with the sibling repos checked out, run \`npm run vendor:db-types\` and commit the refreshed copy in ${label}.`,
      );
    }
    continue;
  }

  // Write mode.
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const before = fs.existsSync(dest) ? md5(dest) : null;
  if (before === canonicalSum) {
    log(`  ok    ${label}: ${copy} already in sync (md5 ${before})`);
    continue;
  }
  fs.copyFileSync(CANONICAL, dest);
  const after = md5(dest);
  if (after !== canonicalSum) {
    failed = true;
    error(`Vendor failed (${label})`, `wrote ${dest} but its md5 (${after}) does not match canonical (${canonicalSum}).`);
    continue;
  }
  log(`  WROTE ${label}: ${copy} ${before ? `(was ${before})` : "(new file)"} -> ${after}`);
  log(`        ^ commit this in ${label}; it is a separate repo and a separate PR.`);
}

log("");
if (failed) {
  if (stale.length > 0) {
    log("The vendored client copies are part of the GV-223 contract, not a nicety: the");
    log("clients type every RPC call against them, so a stale copy means a client is");
    log("compiling against a schema that no longer exists. Re-vendor with:");
    log("");
    log("    cd fuel_sharing && npm run vendor:db-types");
    log("");
    log(`then open a PR in ${stale.join(" and ")} with the refreshed file.`);
  }
  process.exit(1);
}

log(CHECK ? "✅ Vendored DB types are in sync." : "✅ Vendored DB types fanned out.");
