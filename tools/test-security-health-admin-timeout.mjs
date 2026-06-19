import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const packageSource = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const buildInfoSource = readFileSync(new URL("../build-info.js", import.meta.url), "utf8");
const serviceWorkerSource = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

assert.match(
  appSource,
  /const longAdminToolDataIoOperationStaleMs = 45000;/,
  "long-running admin tools should have a longer Data I/O stale window than ordinary writes"
);

assert.match(
  appSource,
  /const standaloneSecurityHealthProbeTimeoutMs = 6000;/,
  "standalone Security Health should use short per-probe timeouts so the full run stays bounded"
);

assert.match(
  appSource,
  /function normalizeDataIoOperationStaleMs\(value, fallback = dataIoOperationStaleMs\)/,
  "Data I/O diagnostics should support per-operation stale windows"
);

assert.match(
  appSource,
  /staleAfterMs: normalizeDataIoOperationStaleMs\(meta\.staleAfterMs\)/,
  "Data I/O diagnostics should retain each operation's stale window"
);

assert.match(
  appSource,
  /const staleAfterMs = normalizeDataIoOperationStaleMs\(operation\.staleAfterMs \|\| operation\.start\?\.staleAfterMs\);\s*if \(ageMs >= staleAfterMs\)/,
  "latest Data I/O operations should time out using their per-operation stale window"
);

assert.match(
  appSource,
  /traceAdminToolOperation\("security-health", "Run live Security Health", \(\) => runStandaloneSecurityHealthScenario\(\{ skipConfirmation: true \}\), \{ staleAfterMs: longAdminToolDataIoOperationStaleMs \}\)/,
  "Security Health admin-tool rows should not be marked stale by the ordinary 15 second write timer"
);

assert.match(
  appSource,
  /refreshSupabaseSecurityHealthForTestLab\(\{ timeoutMs: standaloneSecurityHealthProbeTimeoutMs, deep: true, force: true \}\)/,
  "Security Health should use the shared bounded per-probe timeout constant"
);

assert.match(
  buildInfoSource,
  /Security Health admin diagnostics now use a longer per-operation stale window/,
  "build-info release notes should mention the Security Health timeout diagnostic fix"
);

assert.match(
  serviceWorkerSource,
  /fuel-ledger-v31[456]/,
  "service worker cache should be bumped for the runtime Security Health diagnostic patch"
);

assert.match(
  packageSource,
  /test-security-health-admin-timeout\.mjs/,
  "validate script should include the Security Health admin timeout regression guard"
);

console.log("Security Health admin timeout guard check passed.");
