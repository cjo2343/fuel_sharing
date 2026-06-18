#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

function read(path) {
  assert.ok(existsSync(path), `${path} must exist`);
  return readFileSync(path, "utf8");
}

function gitChangedFiles() {
  try {
    return execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function assertIncludes(file, content, markers) {
  for (const marker of markers) {
    assert.ok(content.includes(marker), `${file} must include release-readiness marker: ${marker}`);
  }
}

function hasAnyChanged(changed, predicates) {
  return changed.some((file) => predicates.some((predicate) => predicate(file)));
}

function requireChangedCompanions(changed, changedLabel, requiredCompanions) {
  const missing = requiredCompanions.filter((file) => !changed.includes(file));
  assert.equal(
    missing.length,
    0,
    `${changedLabel} changed without companion updates: ${missing.join(", ")}`
  );
}

const envExample = read(".env.example");
assertIncludes(".env.example", envExample, [
  "FUEL_LEDGER_API_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VAPID_PRIVATE_KEY",
  "REMINDER_CRON_SECRET",
]);

const localDev = read("LOCAL-DEVELOPMENT.md");
assertIncludes("LOCAL-DEVELOPMENT.md", localDev, [
  "Supabase disabled",
  "FUEL_LEDGER_DATA_FILE",
  "npm run release:check",
  "Render",
]);

const packageJson = JSON.parse(read("package.json"));
assert.ok(packageJson.scripts?.validate, "package.json must define npm run validate");
assert.ok(packageJson.scripts?.["test:e2e"], "package.json must define npm run test:e2e");
assert.ok(packageJson.scripts?.prepush, "package.json must define npm run prepush");
assert.ok(packageJson.scripts?.["prepush:e2e"], "package.json must define npm run prepush:e2e");
assert.ok(packageJson.scripts?.["release:check"], "package.json must define npm run release:check");
assert.match(packageJson.scripts.prepush, /npm run release:check/, "prepush must run npm run release:check");
assert.doesNotMatch(packageJson.scripts.prepush, /npm run test:e2e/, "prepush should not run Playwright on every push");
assert.match(packageJson.scripts["prepush:e2e"], /npm run release:check/, "prepush:e2e must run release readiness checks");
assert.match(packageJson.scripts["prepush:e2e"], /npm run test:e2e/, "prepush:e2e must run npm run test:e2e");
assert.match(packageJson.scripts["release:check"], /tools\/check-release-readiness\.mjs/, "release:check must run this readiness checker");

const workflow = read(".github/workflows/validate.yml");
assertIncludes(".github/workflows/validate.yml", workflow, [
  "workflow_dispatch:",
  "npm ci",
  "npm run validate",
  "node tools/check-release-readiness.mjs",
  "if: github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'",
  "npx playwright install --with-deps chromium",
  "npm run test:e2e",
]);
const fastValidateJob = workflow.split(/\n  playwright-smoke:/)[0] || workflow;
assert.doesNotMatch(fastValidateJob, /npx playwright install --with-deps chromium/, "fast validation job must not install Playwright Chromium");
assert.doesNotMatch(fastValidateJob, /npm run test:e2e/, "fast validation job must not run Playwright smoke tests");

const checklist = read("DEPLOYMENT-CHECKLIST.md");
assertIncludes("DEPLOYMENT-CHECKLIST.md", checklist, [
  "npm run release:check",
  "npm run test:e2e",
  "supabase/migrations",
  "Run database migrations before deploying app files",
  "build-info.js",
  "service-worker.js",
  "release-readiness companion checks",
]);

const maintenanceNotes = read("MAINTENANCE-NOTES.md");
assertIncludes("MAINTENANCE-NOTES.md", maintenanceNotes, [
  "CI/pre-push guardrails",
  "release-readiness companion checks",
]);

const hardeningNotes = read("SECURITY-HARDENING-STEPS.md");
assertIncludes("SECURITY-HARDENING-STEPS.md", hardeningNotes, [
  "release-readiness companion checks",
  "runtime file changes",
]);

assert.ok(existsSync(".githooks/pre-push"), ".githooks/pre-push must exist");
const hookMode = statSync(".githooks/pre-push").mode;
assert.ok((hookMode & 0o111) !== 0, ".githooks/pre-push must be executable");
assert.match(read(".githooks/pre-push"), /npm run prepush/, ".githooks/pre-push must run npm run prepush");

const changed = gitChangedFiles();
if (changed) {
  const changedMigrations = changed.filter((file) => file.startsWith("supabase/migrations/") && file.endsWith(".sql"));
  if (changedMigrations.length > 0) {
    requireChangedCompanions(changed, `Supabase migrations changed (${changedMigrations.join(", ")})`, [
      "supabase-schema.sql",
      "supabase/MIGRATIONS.md",
      "tools/test-migrations.mjs",
      "DEPLOYMENT-CHECKLIST.md",
    ]);
  }

  const runtimeFilesChanged = hasAnyChanged(changed, [
    (file) => file === "index.html",
    (file) => file === "styles.css",
    (file) => file === "manifest.json",
    (file) => file === "_headers",
    (file) => file === "vercel.json",
    (file) => file === "server.py",
    (file) => /^vendor\//.test(file),
    (file) => /^[^/]+\.js$/.test(file) && file !== "build-info.js" && file !== "service-worker.js",
  ]);
  const runtimeMetadataChanged = changed.includes("build-info.js") || changed.includes("service-worker.js");
  if (runtimeFilesChanged) {
    requireChangedCompanions(changed, "Runtime app files", ["build-info.js", "service-worker.js"]);
  }
  if (runtimeMetadataChanged) {
    requireChangedCompanions(changed, "Runtime metadata files", ["build-info.js", "service-worker.js"]);
  }

  const securityHeaderChanged = hasAnyChanged(changed, [
    (file) => file === "_headers",
    (file) => file === "vercel.json",
    (file) => file === "server.py",
    (file) => file === "tools/test-security-headers.mjs",
  ]);
  if (securityHeaderChanged) {
    requireChangedCompanions(changed, "Security header/CSP files", [
      "tools/test-security-headers.mjs",
      "SECURITY-HARDENING-STEPS.md",
    ]);
  }

  const ciGuardrailChanged = hasAnyChanged(changed, [
    (file) => file === "package.json",
    (file) => file === ".githooks/pre-push",
    (file) => file.startsWith(".github/workflows/"),
    (file) => file === "tools/check-ci-guardrails.mjs",
    (file) => file === "tools/check-release-readiness.mjs",
  ]);
  if (ciGuardrailChanged) {
    requireChangedCompanions(changed, "CI/pre-push/release guardrail files", [
      "MAINTENANCE-NOTES.md",
    ]);
  }
} else {
  console.warn("Skipping Git diff release-readiness checks because this directory is not a Git checkout.");
}

console.log("Release readiness check passed.");
