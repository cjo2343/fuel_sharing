#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readiness = readFileSync("tools/check-release-readiness.mjs", "utf8");

for (const marker of [
  "requireChangedCompanions",
  "Runtime app files",
  "Runtime metadata files",
  "Supabase migrations changed",
  "supabase/MIGRATIONS.md",
  "Security header/CSP files",
  "CI/pre-push/release guardrail files",
]) {
  assert.ok(readiness.includes(marker), `release readiness checker must include ${marker}`);
}


assert.ok(
  /const ciGuardrailChanged = hasAnyChanged\(changed, \[[\s\S]*tools\/check-release-readiness\.mjs[\s\S]*\]\);/.test(readiness),
  "release readiness checker must define CI/release trigger files"
);
const ciGuardrailTriggerBlock = readiness.match(/const ciGuardrailChanged = hasAnyChanged\(changed, \[([\s\S]*?)\]\);/)?.[1] || "";
assert.ok(
  !ciGuardrailTriggerBlock.includes("tools/test-release-readiness-guardrails.mjs"),
  "release-readiness regression test must not trigger its own companion requirement"
);
const ciGuardrailCompanionBlock = readiness.match(/requireChangedCompanions\(changed, "CI\/pre-push\/release guardrail files", \[([\s\S]*?)\]\);/)?.[1] || "";
assert.ok(
  ciGuardrailCompanionBlock.includes("MAINTENANCE-NOTES.md"),
  "CI/release guardrail changes must still require maintenance notes as a companion"
);
assert.ok(
  !ciGuardrailCompanionBlock.includes("tools/test-release-readiness-guardrails.mjs"),
  "CI/release guardrail changes must not require the release-readiness regression test to change in the same diff"
);

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.ok(
  packageJson.scripts?.validate?.includes("tools/test-release-readiness-guardrails.mjs"),
  "npm run validate must include the release-readiness guardrail regression test"
);

const ciGuardrails = readFileSync("tools/check-ci-guardrails.mjs", "utf8");
for (const marker of [
  "tools/test-release-readiness-guardrails.mjs",
  "Runtime app files",
  "CI/pre-push/release guardrail files",
]) {
  assert.ok(ciGuardrails.includes(marker), `CI guardrail checker must track release readiness marker ${marker}`);
}

console.log("Release readiness guardrail tests passed.");
