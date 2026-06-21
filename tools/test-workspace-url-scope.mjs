import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const buildInfo = readFileSync(new URL('../build-info.js', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

assert.match(app, /const workspaceUrlParamNames = Object\.freeze\(\["workspace", "ledger"\]\)/, 'workspace and ledger URL parameters should be recognized.');
assert.match(app, /let activeLedgerId = readActiveWorkspaceIdFromCurrentUrl\(\) \|\| localStorage\.getItem\(activeWorkspaceStorageKey\) \|\| configuredLedgerId/, 'URL workspace should win before localStorage/default workspace.');
assert.match(app, /function getWorkspaceIdentityValues\(ledger = \{\}\)/, 'workspace identity resolution should include a helper for slug/id aliases.');
assert.match(app, /function buildWorkspaceIdentityLookup\(ledgers = \[\]\)/, 'workspace identity resolution should build slug/id lookup maps.');
assert.match(app, /const urlWorkspace = urlWorkspaceId \? linkedIdentityLookup\.get\(urlWorkspaceId\) : null;/, 'URL workspace aliases should be resolved through linked workspace identity lookup.');
assert.match(app, /function writeActiveWorkspaceToCurrentUrl\(ledgerId\)[\s\S]*url\.searchParams\.set\("workspace", normalized\)/, 'active workspace changes should update ?workspace=.');
assert.match(app, /function setActiveLedgerId\(ledgerId, \{ persist = true, updateUrl = true \} = \{\}\)[\s\S]*writeActiveWorkspaceToCurrentUrl\(normalized\)/, 'setActiveLedgerId should persist URL-backed navigation state.');
assert.match(app, /function removeWorkspaceScopeFromUrlObject\(url\)[\s\S]*workspaceUrlParamNames\.forEach/, 'invite links should be able to strip workspace navigation state.');
assert.match(app, /function buildWorkspaceInviteLink\(inviteCode\)[\s\S]*removeWorkspaceScopeFromUrlObject\(url\)[\s\S]*url\.searchParams\.set\("invite", code\)/, 'invite links should not carry stale ?workspace= state.');
assert.match(app, /async function refreshLinkedWorkspacesAfterInvite\(preferredLedgerId = ""\)[\s\S]*reconcileActiveLedgerSelection\(\{ allowWhileLoading: true, reason: "refresh-linked-workspaces", preferredLedgerId: preferred \}\)/, 'create/join refreshes should hand the intended workspace through membership resolution.');
assert.match(app, /const joinedLedgerId = String\(result\?\.ledger_id[\s\S]*if \(joinedLedgerId\) setActiveLedgerId\(joinedLedgerId/, 'invite redemption should select the joined workspace immediately.');
assert.match(app, /const newLedgerId = result && result\.ledger_id[\s\S]*setActiveLedgerId\(newLedgerId, \{ persist: true \}\)[\s\S]*refreshLinkedWorkspacesAfterInvite\(newLedgerId\)/, 'workspace creation should select the created workspace before refreshing linked workspaces.');
assert.doesNotMatch(app, /const preferred = ledgers\.find\(\(ledger\) => String\(ledger\.ledger_id \|\| ""\) === String\(getConfiguredLedgerId\(\)/, 'selection repair should not always prefer the configured primary workspace.');

assert.match(app, /const activeWorkspaceStorageKeyPrefix = `\$\{activeWorkspaceStorageKey\}:user:`/, 'remembered active workspace should be scoped per signed-in user.');
assert.match(app, /function applyWorkspacePreferenceForCurrentUser\(reason = "workspace-preference"\)/, 'signed-in sessions should apply URL/user-scoped workspace preference before loading.');
assert.match(app, /if \(currentSession\) applyWorkspacePreferenceForCurrentUser\("initial-session"\)/, 'initial session should apply user-scoped workspace preference before workspace refresh.');
assert.match(app, /if \(activeWorkspaceLoadInProgress \|\| supabaseLoadInFlight \|\| startupHydrationActive\) return;/, 'settings lock diagnostics should not record false failures during normal startup loading.');
assert.match(app, /function chooseWorkspaceFromMembership\(\{ reason = "workspace-resolution", preferredLedgerId = "" \} = \{\}\)/, 'membership-based workspace resolver should exist.');
assert.match(app, /decision = "single-non-default-workspace"/, 'non-owner users with one non-default workspace should be preferred into that workspace.');
assert.match(app, /workspaceResolution: updateWorkspaceResolutionDebug/, 'load reports should export the workspace resolution decision.');
assert.match(app, /vehicleLookupReadiness: getVehicleLookupReadinessSnapshot\(\)/, 'load reports should export why vehicle lookup is disabled or ready.');

assert.match(app, /Workspace session[\s\S]*URL \$\{escapeHtml\(readActiveWorkspaceIdFromCurrentUrl\(\) \|\| "none"\)\}/, 'workspace scope summary should expose a temporary workspace session debug card.');

assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v(?:394|395)"/, 'build-info should point to v381 cache.');
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v(?:394|395)"/, 'service worker cache should be bumped to v365.');
