import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const sw = fs.readFileSync('service-worker.js', 'utf8');
const runValidations = fs.readFileSync('tools/run-validations.mjs', 'utf8');

function fail(message, context = '') {
  throw new assert.AssertionError({ message: context ? `${message}\n\nContext:\n${context.slice(0, 1200)}` : message });
}

function assertMatches(text, regex, message) {
  if (!regex.test(text)) fail(message, text);
}

function findFunctionBody(source, name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const match = pattern.exec(source);
  if (!match) fail(`Expected function ${name} to exist.`);
  let index = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = index; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(index, i + 1);
    }
  }
  fail(`Could not parse body for ${name}.`);
}

const cachedSession = findFunctionBody(app, 'getCachedActionSession');
assertMatches(cachedSession, /currentSession\?\.access_token[\s\S]*!allowExpired && !isUsableCachedSession\(currentSession\)/,
  'interactive action setup must prefer the already hydrated currentSession token before calling Supabase auth.getSession, even during near-expiry deploy handoff.');
assertMatches(cachedSession, /WRITE_CONTEXT_CURRENT_SESSION_TOKEN_USED[\s\S]*WRITE_CONTEXT_SESSION_CACHE_USED/,
  'cached/current session usage must be visible in Data I/O diagnostics so timeout reports explain why auth.getSession was skipped.');

const freshSession = findFunctionBody(app, 'getFreshSessionWithTimeout');
assertMatches(freshSession, /preferCached[\s\S]*getCachedActionSession\(\{ source, allowExpired: true \}\)/,
  'bounded session lookup must support preferCached current-token reuse for click-time action setup.');
assertMatches(freshSession, /Promise\.race\(\[sessionPromise, timeoutPromise\]\)/,
  'fresh session fallback must still be bounded when cached session is unavailable.');

const hasFresh = findFunctionBody(app, 'hasFreshSupabaseSession');
assertMatches(hasFresh, /preferCached: options\.preferCached === true/,
  'hasFreshSupabaseSession must pass through preferCached.');

const renderToken = findFunctionBody(app, 'getFreshRenderAccessToken');
assertMatches(renderToken, /preferCached: options\.preferCached !== false/,
  'Render request headers must be able to reuse cached action sessions.');

const writeContext = findFunctionBody(app, 'getNormalizedWriteContext');
assertMatches(writeContext, /preferCached: mustUseBackendContext/,
  'backend-required booking/trip/fuel setup must not block the button on auth.getSession when a fresh cached session already exists.');

const renderContext = findFunctionBody(app, 'getRenderWriteContext');
assertMatches(renderContext, /buildRenderRequestHeaders\([\s\S]*preferCached: true/,
  'Render write-context headers must also reuse cached action sessions.');

assertMatches(sw, /async function currentCacheHasNavigationShell/,
  'service worker must verify the new cache has an app shell before deleting old caches.');
assertMatches(sw, /keeping-old-caches-without-current-navigation-shell/,
  'service worker must keep old caches during failed install/deploy handoff instead of causing ?workspace Offline 503.');
assertMatches(sw, /if \(hasShell\)[\s\S]*caches\.delete/,
  'old runtime caches may only be deleted after the active cache has a navigation shell.');

assert.ok(runValidations.includes('node tools/test-action-session-cache-and-sw-shell.mjs'),
  'npm run validate must include the cached action session/service-worker shell guardrail.');
assert.ok(runValidations.includes('node --check tools/test-action-session-cache-and-sw-shell.mjs'),
  'npm run validate must syntax-check the cached action session/service-worker shell guardrail.');

console.log('Action session cache and service-worker shell guardrails passed.');
