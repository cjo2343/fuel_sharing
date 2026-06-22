import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const styles = fs.readFileSync('styles.css', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

function assertIncludes(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message || `Expected to find ${needle}`);
}

function assertNotIncludes(haystack, needle, message) {
  assert.ok(!haystack.includes(needle), message || `Expected not to find ${needle}`);
}

assertIncludes(index, 'id="appUpdateToast"', 'App must render a bottom-right update toast shell.');
assertIncludes(index, 'id="appUpdateNow"', 'Update toast must expose an explicit Update now button.');
assertIncludes(styles, '.app-update-toast', 'Update toast must have dedicated styling.');
assertIncludes(app, 'markAppUpdateReady', 'App must track waiting service-worker updates.');
assertIncludes(app, 'activateReadyAppUpdate', 'App must activate updates only from a user action.');
assertIncludes(app, 'New app version is ready. Showing manual update prompt instead of auto-refreshing during use.', 'Update-ready diagnostic must explain that auto-refresh is disabled.');
assertIncludes(app, 'User clicked Update now.', 'Manual update activation must be recorded.');
assertIncludes(app, 'registration.waiting && navigator.serviceWorker.controller', 'Existing waiting service workers must surface the manual prompt on startup.');
assertNotIncludes(app, 'newWorker.postMessage({ type: "SKIP_WAITING" });\n          }\n        });\n      });', 'New service workers must not be activated automatically from updatefound.');
assertIncludes(serviceWorker, 'type === "SKIP_WAITING"', 'Waiting worker must still support explicit skipWaiting from Update now.');

assertIncludes(app, 'linkedWorkspaceVisibilityStatus', 'Admin backend context must expose linked-workspace visibility truth.');
assertIncludes(app, 'Linked-workspace visibility', 'Admin UI must label linked workspace visibility explicitly.');
assertIncludes(app, 'Visibility status:', 'Owner/global diagnostics details must show loaded/empty/failed/not-checked status.');
assertIncludes(app, 'data-owner-global-refresh', 'Admin must provide an explicit refresh button for app-owner global workspaces.');
assertIncludes(app, 'Refresh global workspace view', 'Global workspace refresh button must be understandable.');
assertIncludes(app, 'appUpdateLifecycle', 'Load reports must include update lifecycle status.');

console.log('✅ update prompt + workspace visibility lane guardrail passed');
