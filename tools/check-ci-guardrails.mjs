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

const packageJson = JSON.parse(read("package.json"));
const scripts = packageJson.scripts || {};

assert.ok(scripts.validate, "package.json must define npm run validate");
assert.ok(scripts["test:e2e"], "package.json must define npm run test:e2e");
assert.ok(scripts["release:check"], "package.json must define npm run release:check");
assert.ok(scripts.prepush, "package.json must define npm run prepush");

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
assert.match(scripts.prepush, /npm run validate/, "prepush must run validation before pushing");
assert.match(scripts.prepush, /tools\/check-release-readiness\.mjs/, "prepush must run release-readiness checks before pushing");
assert.match(scripts.prepush, /npm run test:e2e/, "prepush must run Playwright e2e smoke tests");

const hookPath = ".githooks/pre-push";
assert.ok(existsSync(hookPath), ".githooks/pre-push must exist");
assert.ok((statSync(hookPath).mode & 0o111) !== 0, ".githooks/pre-push must be executable");
assert.match(read(hookPath), /npm run prepush/, ".githooks/pre-push must delegate to npm run prepush");

const workflow = read(".github/workflows/validate.yml");
for (const marker of [
  "npm ci",
  "npm run validate",
  "node tools/check-release-readiness.mjs",
  "npx playwright install --with-deps chromium",
  "npm run test:e2e"
]) {
  assertIncludes(".github/workflows/validate.yml", workflow, marker);
}

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
  "Security header/CSP files",
  "CI/pre-push/release guardrail files"
]) {
  assertIncludes("tools/check-release-readiness.mjs", readiness, marker);
}

console.log("CI guardrail check passed.");
