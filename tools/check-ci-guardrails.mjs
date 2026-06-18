#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";

function read(path) {
  assert.ok(existsSync(path), `${path} must exist`);
  return readFileSync(path, "utf8");
}

function assertIncludes(label, content, marker) {
  assert.ok(content.includes(marker), `${label} must include: ${marker}`);
}

function assertNotIncludes(label, content, marker) {
  assert.ok(!content.includes(marker), `${label} must not include: ${marker}`);
}

const packageJson = JSON.parse(read("package.json"));
const scripts = packageJson.scripts || {};

assert.ok(scripts.validate, "package.json must define npm run validate");
assert.ok(scripts["test:e2e"], "package.json must define npm run test:e2e");
assert.ok(scripts["release:check"], "package.json must define npm run release:check");
assert.ok(scripts.prepush, "package.json must define npm run prepush");
assert.ok(scripts["prepush:e2e"], "package.json must define npm run prepush:e2e");

const validateScript = scripts.validate;
for (const requiredCheck of [
  "tools/check-app-references.mjs",
  "tools/check-build-info.mjs",
  "tools/check-tracked-artifacts.mjs",
  "tools/check-runtime-assets.mjs",
  "tools/check-ci-guardrails.mjs",
  "tools/test-release-readiness-guardrails.mjs",
  "tools/test-security-headers.mjs",
  "tools/test-admin-rpc-fail-closed.mjs",
  "tools/test-supabase-schema-hardening.mjs",
  "tools/test-migrations.mjs"
]) {
  assertIncludes("npm run validate", validateScript, requiredCheck);
}

assert.match(scripts["release:check"], /npm run validate/, "release:check must run validation first");
assert.match(scripts["release:check"], /tools\/check-release-readiness\.mjs/, "release:check must run release readiness checks");
assert.match(scripts.prepush, /npm run release:check/, "prepush must run release:check before pushing");
assertNotIncludes("prepush", scripts.prepush, "npm run test:e2e");
assert.match(scripts["prepush:e2e"], /npm run release:check/, "prepush:e2e must run release:check before browser smoke tests");
assert.match(scripts["prepush:e2e"], /npm run test:e2e/, "prepush:e2e must run Playwright e2e smoke tests");

const hookPath = ".githooks/pre-push";
assert.ok(existsSync(hookPath), ".githooks/pre-push must exist");
assert.ok((statSync(hookPath).mode & 0o111) !== 0, ".githooks/pre-push must be executable");
assert.match(read(hookPath), /npm run prepush/, ".githooks/pre-push must delegate to npm run prepush");

const workflow = read(".github/workflows/validate.yml");
for (const marker of [
  "workflow_dispatch:",
  "name: Fast validation",
  "cache: npm",
  "npm ci",
  "npm run validate",
  "node tools/check-release-readiness.mjs",
  "name: Playwright smoke tests",
  "needs: validate",
  "if: github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'",
  "actions/cache@v4",
  "~/.cache/ms-playwright",
  "npx playwright install --with-deps chromium",
  "npm run test:e2e"
]) {
  assertIncludes(".github/workflows/validate.yml", workflow, marker);
}

const validateJob = workflow.split(/\n  playwright-smoke:/)[0] || workflow;
assertNotIncludes("fast validate job", validateJob, "npx playwright install --with-deps chromium");
assertNotIncludes("fast validate job", validateJob, "npm run test:e2e");

const readiness = read("tools/check-release-readiness.mjs");
for (const marker of [
  "FUEL_LEDGER_API_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REMINDER_CRON_SECRET",
  "DEPLOYMENT-CHECKLIST.md",
  "supabase/migrations/",
  "supabase-schema.sql",
  "supabase/MIGRATIONS.md",
  "tools/test-migrations.mjs",
  "Runtime app files",
  "Runtime metadata files",
  "readReleaseMetadata",
  "assertChecklistMatchesRelease",
  "Current release target",
  "DEPLOYMENT-CHECKLIST.md",
  "Security header/CSP files",
  "CI/pre-push/release guardrail files"
]) {
  assertIncludes("tools/check-release-readiness.mjs", readiness, marker);
}

console.log("CI guardrail check passed.");
