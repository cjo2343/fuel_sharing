import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync("app.js", "utf8");
const match = appSource.match(/function isSupabaseLoadNoiseEvent\(entry = \{\}\) \{[\s\S]*?\n\}/);
assert.ok(match, "isSupabaseLoadNoiseEvent should be present");
const isSupabaseLoadNoiseEvent = Function(`${match[0]}; return isSupabaseLoadNoiseEvent;`)();

const noisyEvents = [
  { label: "data-io:admin-tool:security-health:ok", dataIo: true },
  { label: "data-io:admin-tool:security-health:skip", dataIo: true },
  { label: "data-io:admin-report-save:ok", dataIo: true },
  { label: "data-io:json-mirror-backup:ok", dataIo: true },
  { label: "data-io:normalized-test-data-cleanup:start", dataIo: true },
  { label: "data-io:retention-preview:ok", dataIo: true },
  { label: "data-io:retention-cleanup:start", dataIo: true },
  { label: "data-io:owner-activity:timeout", dataIo: true },
  { label: "data-io:workspace-tools-refresh:ok", dataIo: true },
  { label: "workspace-resolution" },
  { label: "workspace-load-start" },
  { label: "workspace-load-confirmed" },
  { label: "background-sync-incomplete" },
  { label: "supabase-load-skip" },
  { label: "render-admin-report-save" },
  { label: "render-json-mirror-backup" },
  { label: "json-mirror-save" },
  { label: "browser-full-state-save-skip" },
  { label: "render-normalized-test-data-cleanup" },
  { label: "normalized-reconciliation-dirty" },
  { label: "render-retention-preview" },
  { label: "render-retention-cleanup" },
  { label: "test-lab-local-run" },
  { label: "security-health-live" },
  { label: "test-lab-report-local-merge" },
  { label: "focus-sync-skip" },
  { label: "ledger-events-subscription-skip" },
  { label: "realtime-resumed-visible" },
  { label: "realtime-disabled" },
  { label: "sync-diagnostic:focus-sync-skip", diagnostic: true }
];

for (const event of noisyEvents) {
  assert.equal(
    isSupabaseLoadNoiseEvent(event),
    true,
    `${event.label} should not inflate the headline high-activity warning`
  );
}

const realActivityEvents = [
  { label: "supabase-load" },
  { label: "render-state-load" },
  { label: "trip-table-write" },
  { label: "fuel-table-write" },
  { label: "booking-table-write" },
  { label: "settlement-table-write" }
];

for (const event of realActivityEvents) {
  assert.equal(
    isSupabaseLoadNoiseEvent(event),
    false,
    `${event.label} should still count as real app-side data activity`
  );
}

for (const expectedPattern of [
  /\^data-io:admin/,
  /owner-activity/,
  /workspace-tools-refresh/,
  /workspace-resolution/,
  /workspace-load-confirmed/,
  /background-sync-incomplete/,
  /\^ledger-events-subscription/
]) {
  assert.match(
    match[0],
    expectedPattern,
    `Noise filter should include ${expectedPattern}`
  );
}

console.log("Supabase activity headline noise checks passed.");
