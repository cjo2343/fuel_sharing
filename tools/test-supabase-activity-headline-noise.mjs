import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync("app.js", "utf8");
const match = appSource.match(/function isSupabaseLoadNoiseEvent\(entry = \{\}\) \{[\s\S]*?\n\}/);
assert.ok(match, "isSupabaseLoadNoiseEvent should be present");
const isSupabaseLoadNoiseEvent = Function(`${match[0]}; return isSupabaseLoadNoiseEvent;`)();

const noisyEvents = [
  { label: "data-io:admin-tool:security-health:ok", dataIo: true },
  { label: "data-io:admin-report-save:ok", dataIo: true },
  { label: "render-admin-report-save" },
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

assert.match(
  appSource,
  /function isSupabaseLoadNoiseEvent\(entry = \{\}\)[\s\S]*entry\.dataIo[\s\S]*\^data-io:admin[\s\S]*\^security-health[\s\S]*\^test-lab-report[\s\S]*-skip[\s\S]*\^ledger-events-subscription/,
  "Admin/test/skip/realtime diagnostics should be filtered before computing the activity headline"
);

console.log("Supabase activity headline noise checks passed.");
