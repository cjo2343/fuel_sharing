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
  "readReleaseMetadata",
  "assertChecklistMatchesRelease",
  "Current release target",
]) {
  assert.ok(readiness.includes(marker), `release readiness checker must include ${marker}`);
}



assert.ok(
  readiness.includes('["build-info.js", "service-worker.js", "DEPLOYMENT-CHECKLIST.md"]'),
  "runtime app/metadata changes must require DEPLOYMENT-CHECKLIST.md as a companion"
);
assert.ok(
  readiness.includes('Top release note: ${release.topReleaseNote}'),
  "release readiness checker must require the deployment checklist to include the top release note"
);
assert.ok(
  readiness.includes('BUILD_INFO.version') && readiness.includes('expectedServiceWorkerCache') && readiness.includes('CACHE_NAME'),
  "release readiness checker must parse and compare runtime metadata"
);

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
  "DEPLOYMENT-CHECKLIST.md",
  "CI/pre-push/release guardrail files",
  "readReleaseMetadata",
  "assertChecklistMatchesRelease",
  "Current release target",
]) {
  assert.ok(ciGuardrails.includes(marker), `CI guardrail checker must track release readiness marker ${marker}`);
}

console.log("Release readiness guardrail tests passed.");
