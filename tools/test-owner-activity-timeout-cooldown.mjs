import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");

assert.match(app, /ownerActivityTimeoutCooldownBaseMs\s*=\s*120000/, "Owner activity should pause for at least two minutes after a timeout.");
assert.match(app, /ownerActivityTimeoutCooldownMaxMs\s*=\s*300000/, "Owner activity timeout cooldown should be capped.");
assert.match(app, /ownerActivityBackgroundIntervalMs\s*=\s*60000/, "Owner activity background refresh should not poll every few seconds.");
assert.match(app, /function applyOwnerActivityTimeoutCooldown\(\)/, "Owner activity should centralize timeout backoff handling.");
assert.match(app, /resultCode:\s*"OWNER_ACTIVITY_COOLDOWN"/, "Cooldown skips should be recorded as one quiet Data I/O row.");
assert.match(app, /formatOwnerActivityCooldownMessage\(now\)/, "Cooldown state should show a calm message instead of repeated failures.");
assert.match(app, /coolingDown \? "Paused"/, "Owner activity card should render timeout cooldown as paused, not as an active failure.");
assert.match(app, /refreshOwnerActivity\(\{ silent: true, reason: "admin-background" \}\)/, "Admin background refresh should use the cooldown-aware owner activity path.");
assert.doesNotMatch(app, /refreshOwnerActivity\(\{ force: true, silent: true \}\)\.catch\(\(\) => \{\}\)/, "Vehicle lookup should no longer force owner activity after every attempt.");

console.log("ok - owner activity timeout cooldown guardrails passed");
