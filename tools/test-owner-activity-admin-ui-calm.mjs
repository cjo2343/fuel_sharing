import { readFileSync } from 'fs';

const app = readFileSync('app.js', 'utf8');
const styles = readFileSync('styles.css', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

assert(app.includes('ownerActivityAutoPausedUntilManual'), 'owner activity must support manual-only auto pause after timeouts');
assert(app.includes('data-owner-activity-refresh'), 'owner activity card must include a manual refresh button');
assert(app.includes('summarizeOwnerActivityRows'), 'owner activity rows must be grouped into a summary instead of dumping a raw wall of events');
assert(app.includes('ownerActivityVisibleRowLimit = 6'), 'owner activity must limit visible rows to keep Admin readable');
assert(app.includes('Owner activity summary'), 'owner activity UI should show a grouped summary section');
assert(app.includes('Show latest raw owner activity rows'), 'raw owner activity rows must be hidden behind a nested detail');
assert(app.includes('ownerActivityAutoPausedUntilManual = true'), 'owner activity timeouts must stop automatic retry loops until manual refresh');
assert(styles.includes('.admin-operation-row.compact'), 'compact operation row styling must exist');
assert(styles.includes('.owner-activity-raw-list'), 'owner activity raw rows must have a bounded readable list style');

console.log('Owner activity admin UI calm guardrail passed.');
