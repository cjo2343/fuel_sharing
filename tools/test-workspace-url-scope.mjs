import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const buildInfo = readFileSync(new URL('../build-info.js', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

assert.match(app, /const workspaceUrlParamNames = Object\.freeze\(\["workspace", "ledger"\]\)/, 'workspace and ledger URL parameters should be recognized.');
assert.match(app, /let activeLedgerId = readActiveWorkspaceIdFromCurrentUrl\(\) \|\| localStorage\.getItem\(activeWorkspaceStorageKey\) \|\| configuredLedgerId/, 'URL workspace should win before localStorage/default workspace.');
assert.match(app, /function writeActiveWorkspaceToCurrentUrl\(ledgerId\)[\s\S]*url\.searchParams\.set\("workspace", normalized\)/, 'active workspace changes should update ?workspace=.');
assert.match(app, /function setActiveLedgerId\(ledgerId, \{ persist = true, updateUrl = true \} = \{\}\)[\s\S]*writeActiveWorkspaceToCurrentUrl\(normalized\)/, 'setActiveLedgerId should persist URL-backed navigation state.');
assert.match(app, /function removeWorkspaceScopeFromUrlObject\(url\)[\s\S]*workspaceUrlParamNames\.forEach/, 'invite links should be able to strip workspace navigation state.');
assert.match(app, /function buildWorkspaceInviteLink\(inviteCode\)[\s\S]*removeWorkspaceScopeFromUrlObject\(url\)[\s\S]*url\.searchParams\.set\("invite", code\)/, 'invite links should not carry stale ?workspace= state.');
assert.match(app, /async function refreshLinkedWorkspacesAfterInvite\(preferredLedgerId = ""\)[\s\S]*if \(preferred\) setActiveLedgerId\(preferred/, 'create/join refreshes should preserve the intended workspace before list refresh.');
assert.match(app, /const joinedLedgerId = String\(result\?\.ledger_id[\s\S]*if \(joinedLedgerId\) setActiveLedgerId\(joinedLedgerId/, 'invite redemption should select the joined workspace immediately.');
assert.match(app, /const newLedgerId = result && result\.ledger_id[\s\S]*setActiveLedgerId\(newLedgerId, \{ persist: true \}\)[\s\S]*refreshLinkedWorkspacesAfterInvite\(newLedgerId\)/, 'workspace creation should select the created workspace before refreshing linked workspaces.');
assert.doesNotMatch(app, /const preferred = ledgers\.find\(\(ledger\) => String\(ledger\.ledger_id \|\| ""\) === String\(getConfiguredLedgerId\(\)/, 'selection repair should not always prefer the configured primary workspace.');
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v365"/, 'build-info should point to v365 cache.');
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v365"/, 'service worker cache should be bumped to v365.');
