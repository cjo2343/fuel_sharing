import { readFileSync } from 'fs';

const html = readFileSync('index.html', 'utf8');
const css = readFileSync('styles.css', 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(html.includes('id="adminHomeHeading"'), 'Admin home overview panel should exist.');
assert(html.includes('Workspace admin</h2>'), 'Default Admin view should be framed as workspace admin work.');
assert(html.includes('data-admin-tools-group="owner-tools" open'), 'Routine owner tools should be grouped in an open Owner tools drawer.');
assert(html.includes('data-admin-tools-group="diagnostics-lab"'), 'Diagnostics Lab drawer should exist for raw troubleshooting tools.');
assert(!html.includes('data-admin-tools-group="diagnostics-lab" open'), 'Diagnostics Lab should be collapsed by default.');
assert(html.indexOf('data-admin-tools-group="owner-tools"') < html.indexOf('data-admin-tools-group="diagnostics-lab"'), 'Owner tools should appear before Diagnostics Lab.');
assert(html.indexOf('Download CSV') < html.indexOf('data-admin-tools-group="diagnostics-lab"'), 'Routine exports should stay outside Diagnostics Lab.');
assert(html.indexOf('Data I/O &amp; backend monitor') > html.indexOf('data-admin-tools-group="diagnostics-lab"'), 'Raw Data I/O monitor should live inside Diagnostics Lab.');
assert(html.indexOf('id="runFullTestLab"') > html.indexOf('data-admin-tools-group="diagnostics-lab"'), 'Test Lab actions should live inside Diagnostics Lab.');
assert(css.includes('.admin-home-grid'), 'Admin home overview styles should exist.');
assert(css.includes('.admin-tools-group'), 'Admin grouped drawer styles should exist.');
assert(css.includes('.diagnostics-lab-group'), 'Diagnostics Lab styles should exist.');

console.log('Admin panel declutter guardrails passed.');
