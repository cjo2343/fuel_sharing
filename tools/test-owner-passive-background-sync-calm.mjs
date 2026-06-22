import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const buildInfo = readFileSync(new URL("../build-info.js", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

assert.match(
  appSource,
  /function hasAnyHealthyCloudSync\(\)[\s\S]*lastHealthyCloudSyncMs\(\) > 0/,
  "app.js should distinguish any prior healthy cloud sync from a recently healthy sync"
);

assert.match(
  appSource,
  /function isPassiveBackgroundSyncReason\(reason = "background"\)[\s\S]*window-focus[\s\S]*focus-refresh[\s\S]*service-worker[\s\S]*realtime[\s\S]*isBackgroundVisibleSyncSource/,
  "passive owner/background refresh lanes should be centrally classified"
);

assert.match(
  appSource,
  /function shouldKeepPassiveBackgroundSyncQuiet\(reason = "background", referenceTime = Date\.now\(\)\)[\s\S]*pendingLocalChanges > 0[\s\S]*!hasAnyHealthyCloudSync\(\)[\s\S]*!isPassiveBackgroundSyncReason\(reason\)[\s\S]*return true;/,
  "background focus refresh failures should remain quiet after a loaded cloud state when there are no pending writes"
);

assert.match(
  appSource,
  /return shouldSurfaceBackgroundSyncDelay\(startedAt, reason\);/,
  "loadSupabaseStateWithTimeout should pass the sync reason into the background-delay decision"
);

assert.match(
  appSource,
  /background-timeout-quiet[\s\S]*Core app sync remains on the last loaded cloud state/,
  "quiet passive background timeouts should be diagnostics, not global Cloud delayed banners"
);

assert.match(
  appSource,
  /background-incomplete-quiet[\s\S]*Core app sync remains on the last loaded cloud state/,
  "quiet passive background incomplete loads should be diagnostics, not global Cloud delayed banners"
);

