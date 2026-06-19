import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync('app.js', 'utf8');
const html = readFileSync('index.html', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

assert.match(app, /function canUseGlobalAdminTools\(\) \{[\s\S]*?isPrimaryConfiguredWorkspace\(\)/, 'app must separate global admin tools from workspace admin role');
assert.match(app, /function requireGlobalAdminToolsPermission\(/, 'global admin tools must have an explicit permission guard');
assert.match(app, /dataToolsPanel\) els\.dataToolsPanel\.classList\.toggle\("hidden", !canUseGlobalAdminTools\(\)\)/, 'global Data tools panel must be hidden outside primary app-admin scope');
assert.match(app, /systemHealthPanel\) els\.systemHealthPanel\.classList\.toggle\("hidden", !canUseGlobalAdminTools\(\)\)/, 'system health panel must be hidden outside global admin scope');
assert.match(app, /databaseDiagnosticsPanel\) els\.databaseDiagnosticsPanel\.classList\.toggle\("hidden", !canUseGlobalAdminTools\(\)\)/, 'database diagnostics panel must be hidden outside global admin scope');
assert.match(app, /memberManagementPanel\) els\.memberManagementPanel\.classList\.toggle\("hidden", !canManageSettings\(\)\)/, 'workspace member management should remain scoped to current workspace admins');
assert.match(app, /if \(!requireGlobalAdminToolsPermission\("Run live Security Health"\)\) return;/, 'Security Health must require global app-admin scope');
assert.match(app, /if \(!requireGlobalAdminToolsPermission\("Check Render admin health"\)\) return;/, 'Render admin health button must require global app-admin scope');
assert.match(app, /if \(!requireGlobalAdminToolsPermission\("Export backup"\)\) return;/, 'backup export must require global app-admin scope');
assert.match(app, /Global admin\/test tools are hidden outside the primary app-admin workspace/, 'advanced tool copy must explain global scope');

assert.match(html, /Workspace admin - manage this workspace/, 'role option must say workspace admin, not global app admin');
assert.doesNotMatch(html, /Admin - manage app/, 'old global-admin role label must not be shown for workspace roles');
assert.match(html, /Global app data tools/, 'Data tools heading must make global scope explicit');
assert.match(html, /Primary app-admin-only diagnostics and maintenance tools/, 'global data tools intro must clarify primary app-admin scope');
assert.match(pkg, /test-workspace-admin-scope-guard\.mjs/, 'validation must include workspace admin scope guard');

console.log('Workspace admin scope guardrails passed.');
