import assert from 'assert';
import fs from 'fs';

const app = fs.readFileSync('app.js', 'utf8');

assert.match(app, /async function buildRenderRequestHeaders\(/, 'app.js must centralize Render Authorization header creation.');
assert.match(app, /async function callRenderJson\(/, 'app.js must expose a shared Render JSON client helper.');
assert.match(app, /callRenderJson\(renderSettingsSaveUrl/, 'settings save should use the shared Render JSON helper.');
assert.doesNotMatch(app, /Authorization"\s*:\s*`Bearer \$\{currentSession\.access_token\}`/, 'Render fetches must not use stale currentSession.access_token directly.');
assert.doesNotMatch(app, /fetch\([^\n]+renderSettingsSaveUrl[\s\S]{0,500}Authorization/, 'settings save must not hand-roll Render fetch Authorization headers.');

console.log('Render API client helper guardrails passed.');
