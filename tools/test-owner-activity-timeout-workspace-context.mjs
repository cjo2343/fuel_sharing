import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");

assert.match(app, /function buildDataIoWorkspaceContext\(meta = \{\}\)/, "Data I/O should build a selected-vs-loaded workspace context");
assert.match(app, /selectedWorkspaceId: workspaceContext\.selectedWorkspaceId/, "Data I/O diagnostics should include selected workspace id");
assert.match(app, /loadedWorkspaceId: workspaceContext\.loadedWorkspaceId/, "Data I/O diagnostics should include loaded workspace id");
assert.match(app, /workspaceMismatch: workspaceContext\.workspaceMismatch/, "Data I/O diagnostics should flag workspace mismatch");
assert.match(app, /selectedWorkspaceLabel} · loaded \$\{loadedWorkspaceLabel\}/, "workspace label should not pretend a mismatched action belongs only to the loaded workspace");
assert.match(app, /ownerActivityWorkspaceContext = buildDataIoWorkspaceContext\(\)/, "owner activity should snapshot the visible selected workspace context");
assert.match(app, /workspace selector differs from loaded workspace/, "owner activity should explain selected-vs-loaded mismatches");
assert.match(app, /requestAndReadPromise = \(async \(\) => \{[\s\S]*?const text = await response\.text\(\)/, "Render JSON helper should timeout the response body read, not only fetch headers");
assert.match(app, /Promise\.race\(\[requestAndReadPromise, timeoutPromise\]\)/, "Render JSON helper should race the whole request/body read against timeout");
assert.match(app, /No server-owned owner activity rows yet\./, "Owner activity should show a clear empty state");

console.log("ok - owner activity timeout and workspace context diagnostics are guarded");
