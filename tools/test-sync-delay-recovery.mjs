import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

assert.match(
  appSource,
  /function clearSyncDelay\(reason = "sync-recovered"\) \{[\s\S]*lastSyncError = "";[\s\S]*lastCloudRetryAt = "";/,
  "app.js should have one helper that clears stale sync delay state"
);

assert.match(
  appSource,
  /if \(result === true\) \{[\s\S]*clearSyncDelay\(`\$\{reason\}-completed`\);[\s\S]*renderSyncHealthBanner\(\);[\s\S]*\}/,
  "loadSupabaseStateWithTimeout should clear delayed banner state after a successful timed load"
);

assert.match(
  appSource,
  /clearSyncDelay\(`load-success:\$\{reason\}`\);[\s\S]*recordSyncDiagnostic\("load-success"/,
  "successful Supabase loads should clear stale delayed-sync errors before recording load-success"
);

assert.match(
  appSource,
  /function markRemoteSaveSucceeded\(label\) \{[\s\S]*clearSyncDelay\(`save-success:\$\{label \|\| "cloud"\}`\);[\s\S]*setSyncStatus\(label\);[\s\S]*\}/,
  "successful Supabase saves should also clear stale delayed-sync errors"
);
