#!/usr/bin/env node
// Unit + fixture tests for the release gates (GV-422).
//
//   node tools/test-release-gates.mjs
//
// Dependency-free, no Docker, no network, sub-second. Same shape as
// tools/test-hotpath-mirror-scan.mjs and tools/test-tracker-insert-scan.mjs: the
// guard exports its pure logic, this file drives it.
//
// WHY IT MATTERS MORE HERE THAN USUAL: check-release-gates.mjs is red today, on
// purpose, for four real reasons (Free plan, stale drill, unfilled privacy
// placeholder, unattested externals). A guard that is expected to be red is a
// guard whose greenness nobody ever observes — so if its logic broke and it
// started passing everything, the only visible change would be a nicer-looking
// build. Every gate is therefore driven BOTH ways here, against a fixture repo
// this file builds in a temp dir: green when the state is good, red when it is
// not, with the mutation applied one at a time.
//
// The fixture repo mirrors the real layout:
//   <fixture>/supabase/migrations/NNN_*.sql
//   <fixture>/docs/gdpr/backup-restore.md
//   <fixture>/docs/release-attestations.json
//   <fixture>/../govehlo-web/{index,privatliv/index}.html
//
// Gate 2 shells out to tools/test-migrations.mjs, which only makes sense in the
// real repo, so runGates() takes the validator as an injectable function and the
// fixture runs pass/fail stubs instead.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTESTATION_MAX_AGE_DAYS,
  BACKUP_EVIDENCE_MAX_AGE_DAYS,
  DRILL_MAX_MIGRATION_LAG,
  collectPublishedPages,
  daysBetween,
  evaluateAttestations,
  evaluateBackupEvidence,
  evaluateDrillLag,
  findPlaceholders,
  highestMigrationNumber,
  parseBackupEvidence,
  parseDrillMarker,
  runGates,
  summarise,
} from "./check-release-gates.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = "2026-08-01";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n      ${e.message.split("\n").join("\n      ")}`);
  }
}

// ── 1. Pure parsers ──────────────────────────────────────────────────────────

console.log("parsers");

check("parseBackupEvidence reads the dashboard date and the plan", () => {
  const { verifiedOn, plan } = parseBackupEvidence(
    "Dashboard-verifikation udført **2026-07-17** på projekt\n`abc`:\n\n- Plan: **Free**.\n",
  );
  assert.equal(verifiedOn, "2026-07-17");
  assert.equal(plan, "Free");
});

check("parseBackupEvidence returns nulls rather than guessing", () => {
  const { verifiedOn, plan } = parseBackupEvidence("# ingen evidens her\n");
  assert.equal(verifiedOn, null);
  assert.equal(plan, null);
});

check("parseBackupEvidence reads the REAL doc (format has not drifted)", () => {
  const { verifiedOn, plan } = parseBackupEvidence(readFileSync(join(REPO, "docs/gdpr/backup-restore.md"), "utf8"));
  assert.match(verifiedOn ?? "", /^\d{4}-\d{2}-\d{2}$/, "the real doc must carry a parseable verification date");
  assert.ok(plan, "the real doc must carry a parseable plan");
});

check("parseDrillMarker reads the drill migration + date", () => {
  const m = parseDrillMarker("## Drill-log\n\nSeneste drill: migration 133 (2026-07-18)\n");
  assert.deepEqual(m, { migration: 133, date: "2026-07-18" });
});

check("parseDrillMarker does NOT accept the prose it replaced", () => {
  // The sentence that carried this fact before GV-422. Matching it loosely would
  // reintroduce exactly the ambiguity the fixed format exists to remove.
  const m = parseDrillMarker("Seneste drill\n(2026-07-18) kørte på et dump ved migration 133; repoet står nu ved 147.\n");
  assert.equal(m.migration, null);
});

check("parseDrillMarker reads the REAL doc (the marker exists and is parseable)", () => {
  const m = parseDrillMarker(readFileSync(join(REPO, "docs/gdpr/backup-restore.md"), "utf8"));
  assert.equal(typeof m.migration, "number", "the real drill log must carry a parseable `Seneste drill:` marker");
});

check("highestMigrationNumber ignores non-migration files", () => {
  assert.equal(highestMigrationNumber(["001_a.sql", "158_z.sql", "README.md", "notes.sql"]), 158);
  assert.equal(highestMigrationNumber([]), 0);
});

check("daysBetween counts whole days across a DST boundary", () => {
  assert.equal(daysBetween("2026-07-18", "2026-08-01"), 14);
  assert.equal(daysBetween("2026-03-01", "2026-04-01"), 31);
});

check("findPlaceholders reports one finding per line, not per marker", () => {
  const found = findPlaceholders([
    { file: "privatliv/index.html", source: "<p>ok</p>\n[DATAANSVARLIG: NAVN — udfyldes før publicering]<br>\n" },
  ]);
  assert.equal(found.length, 1, "both markers on one line is ONE problem");
  assert.equal(found[0].line, 2);
  assert.deepEqual(found[0].markers, ["[DATAANSVARLIG", "udfyldes før publicering"]);
});

check("findPlaceholders is silent on a clean page", () => {
  assert.deepEqual(findPlaceholders([{ file: "index.html", source: "<p>VehloShare ApS, CVR 12345678</p>" }]), []);
});

// ── 2. Pure evaluators ───────────────────────────────────────────────────────

console.log("evaluators");

check("backup evidence: Pro + fresh date is clean", () => {
  const r = evaluateBackupEvidence({ verifiedOn: "2026-07-17", plan: "Pro" }, TODAY);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.errors, []);
});

check("backup evidence: Free plan is a blocker even when freshly verified", () => {
  const r = evaluateBackupEvidence({ verifiedOn: TODAY, plan: "Free" }, TODAY);
  assert.equal(r.errors.length, 0);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /Free/);
});

check(`backup evidence: a verification older than ${BACKUP_EVIDENCE_MAX_AGE_DAYS} days is a blocker`, () => {
  const boundary = evaluateBackupEvidence({ verifiedOn: "2026-05-03", plan: "Pro" }, TODAY); // exactly 90
  assert.deepEqual(boundary.problems, [], "exactly at the limit is still fresh");
  const over = evaluateBackupEvidence({ verifiedOn: "2026-05-02", plan: "Pro" }, TODAY); // 91
  assert.equal(over.problems.length, 1);
  assert.match(over.problems[0], /91 days ago/);
});

check("backup evidence: an unreadable doc is an ERROR, not a blocker", () => {
  const r = evaluateBackupEvidence({ verifiedOn: null, plan: null }, TODAY);
  assert.equal(r.errors.length, 2, "both the date and the plan must be reported as unreadable");
  assert.deepEqual(r.problems, []);
});

check(`drill lag: ${DRILL_MAX_MIGRATION_LAG} behind passes, ${DRILL_MAX_MIGRATION_LAG + 1} fails`, () => {
  const ok = evaluateDrillLag({ migration: 143, date: "2026-07-18" }, 158);
  assert.deepEqual(ok.problems, []);
  const bad = evaluateDrillLag({ migration: 142, date: "2026-07-18" }, 158);
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0], /16 migrations behind/);
});

check("drill lag: a missing marker is an ERROR (the doc lost its format)", () => {
  const r = evaluateDrillLag({ migration: null, date: null }, 158);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(r.problems, []);
});

const attested = (over = {}) => ({
  attestations: {
    thing: {
      state: "verified",
      verified_on: TODAY,
      attested_by: "cjo@govehlo.dk",
      note: "A note long enough to explain what was actually verified.",
      ...over,
    },
  },
});

check("attestations: verified, signed, in date is clean", () => {
  const r = evaluateAttestations(attested(), TODAY);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.errors, []);
});

check(`attestations: older than ${ATTESTATION_MAX_AGE_DAYS} days is a blocker`, () => {
  const boundary = evaluateAttestations(attested({ verified_on: "2026-07-02" }), TODAY); // exactly 30
  assert.deepEqual(boundary.problems, [], "exactly at the limit still counts");
  const over = evaluateAttestations(attested({ verified_on: "2026-07-01" }), TODAY); // 31
  assert.equal(over.problems.length, 1);
  assert.match(over.problems[0], /31 days ago/);
});

check('attestations: state "unverified" is a blocker, and quotes the note', () => {
  const r = evaluateAttestations(attested({ state: "unverified", verified_on: null, attested_by: null }), TODAY);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /not attested/);
  assert.equal(r.errors.length, 0, "not-yet-done is a blocker, not a malformed file");
});

check("attestations: verified but unsigned or undated is an ERROR", () => {
  assert.equal(evaluateAttestations(attested({ attested_by: "  " }), TODAY).errors.length, 1);
  assert.equal(evaluateAttestations(attested({ verified_on: "juli" }), TODAY).errors.length, 1);
});

check("attestations: an empty list cannot pass", () => {
  assert.equal(evaluateAttestations({ attestations: {} }, TODAY).errors.length, 1);
  assert.equal(evaluateAttestations({}, TODAY).errors.length, 1);
});

check("attestations: the REAL file is well-formed and judged entry by entry", () => {
  const doc = JSON.parse(readFileSync(join(REPO, "docs/release-attestations.json"), "utf8"));
  // Deliberately asserts FORM, not verdict. The committed file is unverified today
  // and will be verified later; a test that pinned the verdict would fail the day
  // the state improved, and "the test broke because someone did the work" is how a
  // suite gets edited until it agrees with whatever is there.
  const r = evaluateAttestations(doc, "2999-01-01");
  assert.deepEqual(r.errors, [], "the committed attestation file must be well-formed and signed where it claims to be");
  assert.ok(Object.keys(doc.attestations).length >= 2, "the two external items must both still be listed");
  for (const key of ["app_link_secrets", "sentry_source_maps"]) {
    assert.ok(doc.attestations[key], `${key} must remain an attested item`);
  }
});

// ── 3. Fixture repo: each gate red and green end to end ──────────────────────

console.log("fixtures (whole-script, one mutation at a time)");

const CLEAN_BACKUP_DOC = `# Backup og restore-drill

Dashboard-verifikation udført **2026-07-17** på projekt \`fixture\`:

- Plan: **Pro**.

## Drill-log

Seneste drill: migration 158 (2026-07-20)
`;

const CLEAN_ATTESTATIONS = {
  attestations: {
    app_link_secrets: {
      state: "verified",
      verified_on: "2026-07-20",
      attested_by: "cjo@govehlo.dk",
      note: "Fixture: universal links resolve and open the app from a real invite link.",
    },
    sentry_source_maps: {
      state: "verified",
      verified_on: "2026-07-20",
      attested_by: "cjo@govehlo.dk",
      note: "Fixture: a thrown error in the released build symbolicates to TypeScript.",
    },
  },
};

const CLEAN_PRIVACY_PAGE = `<main>
  <h1>Privatlivspolitik</h1>
  <p>VehloShare ApS, CVR 12345678, Danmark</p>
</main>
`;

const root = mkdtempSync(join(tmpdir(), "gv422-"));
const fixture = join(root, "fuel_sharing");
const webFixture = join(root, "govehlo-web");

function writeFixture({ backupDoc = CLEAN_BACKUP_DOC, attestations = CLEAN_ATTESTATIONS, privacyPage = CLEAN_PRIVACY_PAGE } = {}) {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(webFixture, { recursive: true, force: true });
  mkdirSync(join(fixture, "supabase", "migrations"), { recursive: true });
  mkdirSync(join(fixture, "docs", "gdpr"), { recursive: true });
  mkdirSync(join(webFixture, "privatliv"), { recursive: true });
  mkdirSync(join(webFixture, "node_modules", "junk"), { recursive: true });
  mkdirSync(join(webFixture, "functions", "join"), { recursive: true });

  for (const n of [1, 157, 158]) {
    const name = `${String(n).padStart(3, "0")}_fixture.sql`;
    writeFileSync(join(fixture, "supabase", "migrations", name), `-- Migration ${String(n).padStart(3, "0")}: fixture\n`);
  }
  writeFileSync(join(fixture, "docs", "gdpr", "backup-restore.md"), backupDoc);
  writeFileSync(join(fixture, "docs", "release-attestations.json"), `${JSON.stringify(attestations, null, 2)}\n`);
  writeFileSync(join(webFixture, "index.html"), "<h1>VehloShare</h1>\n");
  writeFileSync(join(webFixture, "privatliv", "index.html"), privacyPage);
  writeFileSync(join(webFixture, "functions", "join", "[code].js"), "export const onRequest = () => new Response('ok');\n");
  // Must never be scanned: a vendored copy would make every run red forever.
  writeFileSync(join(webFixture, "node_modules", "junk", "evil.html"), "[DATAANSVARLIG: vendored noise]\n");
}

const migrationValidatorOk = () => {};
const migrationValidatorFails = () => {
  const e = new Error("AssertionError: migration files must be present and ordered");
  e.stdout = "";
  throw e;
};

function runFixture({ validator = migrationValidatorOk, today = TODAY } = {}) {
  const results = runGates({ repoRoot: fixture, webRoot: webFixture, today, runMigrationValidator: validator });
  return Object.fromEntries(results.map((r) => [r.id, r]));
}

function severities(byId) {
  return Object.fromEntries(Object.entries(byId).map(([id, r]) => [id, r.severity]));
}

// --- baseline: everything green ---------------------------------------------
writeFixture();
const green = runFixture();
check("GREEN baseline: all five gates pass, strict exits 0", () => {
  assert.deepEqual(severities(green), {
    "privacy-placeholder": "pass",
    "migrations-registered": "pass",
    "backup-evidence": "pass",
    "restore-drill-freshness": "pass",
    "external-attestations": "pass",
  });
  assert.equal(summarise(Object.values(green), true).failed, false);
});

check("the scanner walks published pages and skips node_modules", () => {
  const pages = collectPublishedPages(webFixture);
  assert.deepEqual(pages, ["functions/join/[code].js", "index.html", "privatliv/index.html"]);
});

// --- mutation (a): plant the placeholder -------------------------------------
writeFixture({ privacyPage: "<p>[DATAANSVARLIG: NAVN, EVT. CVR OG ADRESSE — udfyldes før publicering]</p>\n" });
check("MUTATION a — planted [DATAANSVARLIG turns gate 1 red, and only gate 1", () => {
  const r = runFixture();
  assert.equal(r["privacy-placeholder"].severity, "blocked");
  assert.match(r["privacy-placeholder"].details.join("\n"), /privatliv\/index\.html:1/);
  for (const [id, sev] of Object.entries(severities(r))) {
    if (id !== "privacy-placeholder") assert.equal(sev, "pass", `${id} must be unaffected`);
  }
  assert.equal(summarise(Object.values(r), true).failed, true);
  assert.equal(summarise(Object.values(r), false).failed, false, "advisory mode still exits 0");
});

// --- mutation (a2): the marker alone, in a server-rendered function ----------
writeFixture();
writeFileSync(
  join(webFixture, "functions", "join", "[code].js"),
  "export const onRequest = () => new Response('<p>Kontakt: udfyldes før publicering</p>');\n",
);
check("MUTATION a2 — the marker in a SERVER-RENDERED page is caught too", () => {
  const r = runFixture();
  assert.equal(r["privacy-placeholder"].severity, "blocked");
  assert.match(r["privacy-placeholder"].details.join("\n"), /functions\/join/);
});

// --- mutation (b): drill 16 migrations behind --------------------------------
writeFixture({ backupDoc: CLEAN_BACKUP_DOC.replace("migration 158", "migration 142") });
check("MUTATION b — drill marker 16 migrations behind turns gate 4 red", () => {
  const r = runFixture();
  assert.equal(r["restore-drill-freshness"].severity, "blocked");
  assert.match(r["restore-drill-freshness"].details.join("\n"), /16 migrations behind/);
  assert.equal(r["backup-evidence"].severity, "pass", "the freshness gate and the plan gate are independent");
  assert.equal(summarise(Object.values(r), true).failed, true);
});

// --- mutation (b2): exactly at the limit stays green -------------------------
writeFixture({ backupDoc: CLEAN_BACKUP_DOC.replace("migration 158", "migration 143") });
check("MUTATION b2 — exactly 15 behind is still green (the boundary is not off by one)", () => {
  assert.equal(runFixture()["restore-drill-freshness"].severity, "pass");
});

// --- mutation (c): attestation 31 days old -----------------------------------
writeFixture({
  attestations: {
    attestations: {
      ...CLEAN_ATTESTATIONS.attestations,
      sentry_source_maps: { ...CLEAN_ATTESTATIONS.attestations.sentry_source_maps, verified_on: "2026-07-01" },
    },
  },
});
check("MUTATION c — an attestation 31 days old turns gate 5 red under --strict", () => {
  const r = runFixture();
  assert.equal(r["external-attestations"].severity, "blocked");
  assert.match(r["external-attestations"].details.join("\n"), /sentry_source_maps.*31 days ago/s);
  assert.equal(summarise(Object.values(r), true).failed, true, "strict fails");
  assert.equal(summarise(Object.values(r), false).failed, false, "advisory warns");
});

// --- mutation (d): Free plan --------------------------------------------------
writeFixture({ backupDoc: CLEAN_BACKUP_DOC.replace("**Pro**", "**Free**") });
check("MUTATION d — a Free plan turns gate 3 red (the GV-313 blocker)", () => {
  const r = runFixture();
  assert.equal(r["backup-evidence"].severity, "blocked");
  assert.match(r["backup-evidence"].details.join("\n"), /Free/);
});

// --- mutation (e): the migration validator fails ------------------------------
writeFixture();
check("MUTATION e — a failing test-migrations.mjs is an ERROR that fails even advisory runs", () => {
  const r = runFixture({ validator: migrationValidatorFails });
  assert.equal(r["migrations-registered"].severity, "error");
  assert.equal(summarise(Object.values(r), false).failed, true, "an in-repo defect must fail in EVERY mode");
});

// --- mutation (f): the sibling repo is absent ---------------------------------
writeFixture();
rmSync(webFixture, { recursive: true, force: true });
check("MUTATION f — an absent govehlo-web is UNAVAILABLE (warn locally, fail strict)", () => {
  const results = runGates({ repoRoot: fixture, webRoot: webFixture, today: TODAY, runMigrationValidator: migrationValidatorOk });
  const gate = results.find((r) => r.id === "privacy-placeholder");
  assert.equal(gate.severity, "unavailable");
  assert.match(gate.details.join("\n"), /NOT scanned/);
  assert.equal(summarise(results, false).failed, false, "a missing sibling can never fail a local run");
  assert.equal(summarise(results, true).failed, true, "…and must fail the umbrella");
});

// --- mutation (g): in-repo evidence deleted -----------------------------------
writeFixture();
rmSync(join(fixture, "docs", "release-attestations.json"));
rmSync(join(fixture, "docs", "gdpr", "backup-restore.md"));
check("MUTATION g — deleting the evidence files is an ERROR, never a silent pass", () => {
  const r = runFixture();
  assert.equal(r["external-attestations"].severity, "error");
  assert.equal(r["backup-evidence"].severity, "error");
  assert.equal(r["restore-drill-freshness"].severity, "error");
  assert.equal(summarise(Object.values(r), false).failed, true);
});

// --- restore: green again ------------------------------------------------------
writeFixture();
check("RESTORED — with every mutation reverted the fixture is green again", () => {
  const r = runFixture();
  assert.deepEqual(severities(r), severities(green));
  assert.equal(summarise(Object.values(r), true).failed, false);
});

rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n❌ test-release-gates: ${failures} failing check(s).`);
  process.exit(1);
}
console.log("\n✅ test-release-gates: all checks passed.");
