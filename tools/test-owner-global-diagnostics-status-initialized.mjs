import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const statusIndex = app.indexOf('let ownerGlobalDiagnosticsStatus = {');
const renderIndex = app.indexOf('function renderOwnerGlobalDiagnosticsCard()');
const summarizeIndex = app.indexOf('function summarizeOwnerGlobalDiagnostics');
const refreshIndex = app.indexOf('function refreshOwnerGlobalDiagnostics');

assert.ok(statusIndex > -1, 'ownerGlobalDiagnosticsStatus must be declared.');
assert.ok(statusIndex < summarizeIndex, 'ownerGlobalDiagnosticsStatus must be initialized before summary helper default arguments can reference it.');
assert.ok(statusIndex < renderIndex, 'ownerGlobalDiagnosticsStatus must be initialized before Admin/Data I/O renders the global diagnostics card.');
assert.ok(statusIndex < refreshIndex, 'ownerGlobalDiagnosticsStatus must be initialized before refreshOwnerGlobalDiagnostics uses it.');
assert.ok(app.includes('let lastOwnerGlobalDiagnosticsFetchAt = 0;'), 'owner global diagnostics fetch timestamp must be initialized.');
assert.ok(app.includes('const ownerGlobalDiagnosticsFreshMs = 5 * 60 * 1000;'), 'owner global diagnostics freshness window must be initialized.');
