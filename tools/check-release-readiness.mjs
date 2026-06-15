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
assert.ok(packageJson.scripts?.["release:check"], "package.json must define npm run release:check");
assert.match(packageJson.scripts.prepush, /npm run validate/, "prepush must run npm run validate");
assert.match(packageJson.scripts.prepush, /npm run test:e2e/, "prepush must run npm run test:e2e");
assert.match(packageJson.scripts["release:check"], /tools\/check-release-readiness\.mjs/, "release:check must run this readiness checker");

const workflow = read(".github/workflows/validate.yml");
assertIncludes(".github/workflows/validate.yml", workflow, [
  "npm ci",
  "npm run validate",
  "npx playwright install --with-deps chromium",
  "npm run test:e2e",
]);

const checklist = read("DEPLOYMENT-CHECKLIST.md");
assertIncludes("DEPLOYMENT-CHECKLIST.md", checklist, [
  "npm run release:check",
  "npm run test:e2e",
  "supabase/migrations",
  "Run database migrations before deploying app files",
  "build-info.js",
  "service-worker.js",
]);

assert.ok(existsSync(".githooks/pre-push"), ".githooks/pre-push must exist");
const hookMode = statSync(".githooks/pre-push").mode;
assert.ok((hookMode & 0o111) !== 0, ".githooks/pre-push must be executable");
assert.match(read(".githooks/pre-push"), /npm run prepush/, ".githooks/pre-push must run npm run prepush");

const changed = gitChangedFiles();
if (changed) {
  const changedMigrations = changed.filter((file) => file.startsWith("supabase/migrations/") && file.endsWith(".sql"));
  if (changedMigrations.length > 0) {
    const requiredCompanions = ["supabase-schema.sql", "tools/test-migrations.mjs", "DEPLOYMENT-CHECKLIST.md"];
    const missing = requiredCompanions.filter((file) => !changed.includes(file));
    assert.equal(
      missing.length,
      0,
      `Supabase migrations changed (${changedMigrations.join(", ")}) without companion updates: ${missing.join(", ")}`
    );
  }
} else {
  console.warn("Skipping Git diff release-readiness checks because this directory is not a Git checkout.");
}

console.log("Release readiness check passed.");
