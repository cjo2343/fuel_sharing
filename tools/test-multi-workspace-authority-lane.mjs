import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(buildInfo, /buildLabel:\s*"(?:update-prompt-bridge-workspace-retention-lane|update-prompt-workspace-visibility-lane|general-action-route-timing-lane|action-session-cache-shell-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|no-refresh-action-chain-lane|post-action-unblock-lane|multi-workspace-authority-lane)"/, 'build-info should use the multi-workspace authority label');
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:update-prompt-bridge-workspace-retention-lane|update-prompt-workspace-visibility-lane|general-action-route-timing-lane|action-session-cache-shell-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|no-refresh-action-chain-lane|post-action-unblock-lane|multi-workspace-authority-lane)"/, 'service worker should use the multi-workspace authority label');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"(?:fuel-ledger-v(?:409|410|411|412|413)|fuel-ledger-v408|fuel-ledger-v407|fuel-ledger-v406|fuel-ledger-v405|fuel-ledger-v404|fuel-ledger-v403|fuel-ledger-v402)"/, 'service worker cache should be v402');

assert.ok(app.includes('function isWorkspaceSwitchCommitConfirmed(targetLedgerId)'), 'workspace switch must have a hard commit confirmation helper');
assert.ok(app.includes('WORKSPACE_SWITCH_COMMIT_CONFIRMED'), 'workspace switch commit success must be diagnosed');
assert.ok(app.includes('WORKSPACE_SWITCH_COMMIT_MISMATCH'), 'workspace switch commit mismatch must be diagnosed instead of silently confirming');
assert.ok(app.includes('selected, backend, and loaded workspace must match before the UI is unlocked'), 'workspace switch commit must require selected/backend/loaded agreement');
assert.match(app, /if \(loaded && !isWorkspaceSwitchCommitConfirmed\(targetLedgerId\)\) \{\s*loaded = await retryWorkspaceSwitchCommit\(targetLedgerId, source\);/s, 'workspace switch should retry a stale commit before confirming');
assert.match(app, /if \(loaded && isWorkspaceSwitchCommitConfirmed\(targetLedgerId\)\)/, 'workspace switch should only confirm after hard commit');

assert.ok(app.includes('ownerActivityScopeDefaultVersion'), 'owner activity should have a versioned all-workspaces default');
assert.ok(app.includes('OWNER_ACTIVITY_SCOPE_DEFAULT_ALL_WORKSPACES'), 'app owner activity default should be diagnosed');
assert.ok(app.includes('ledgerId: ownerActivityScope === "all" ? "all-workspaces"'), 'all-workspace owner activity should be separated from active workspace trace context');
assert.ok(app.includes('OWNER_ACTIVITY_ALL_WORKSPACES_STARTED'), 'all-workspace owner activity loads should be explicit');
assert.match(app, /body:\s*ownerActivityScope === "all" \? \{ limit: 30, includeMetadata: false \}/, 'all-workspace owner activity should not send active ledger id');

assert.ok(server.includes('def owner_activity_backend(self):'), 'server must expose app-owner activity route');
assert.ok(server.includes('if not is_configured_app_owner(user):'), 'owner activity route must be app-owner-only');
assert.ok(server.includes('list_owner_activity_as_service(payload)'), 'owner activity route must use service-backed cross-workspace activity listing');
console.log('Multi-workspace authority lane guardrails passed.');
