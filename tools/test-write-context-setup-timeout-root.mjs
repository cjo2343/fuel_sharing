import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const runValidations = fs.readFileSync('tools/run-validations.mjs', 'utf8');

function fail(message, context = '') {
  throw new assert.AssertionError({ message: context ? `${message}\n\nContext:\n${context.slice(0, 1200)}` : message });
}

function assertMatches(text, regex, message) {
  if (!regex.test(text)) fail(message, text);
}

function findFunctionBody(source, name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\([^)]*\\)\\s*\\{`, 'm');
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

assertMatches(app, /const writeContextSessionTimeoutMs = 2500;/, 'write-context setup must bound Supabase auth/session lookup, which was the remaining 10s booking setup hang.');
assertMatches(app, /const normalizedWriteContextTimeoutMs = 6000;/, 'normalized write-context outer timeout must be shorter than the old 10s stale booking setup wait.');
assertMatches(app, /function createSessionTimeoutError[\s\S]*SESSION_TIMEOUT/, 'session timeout errors must be explicit so reports explain setup root cause.');
assertMatches(app, /async function getFreshSessionWithTimeout[\s\S]*Promise\.race\(\[sessionPromise, timeoutPromise\]\)/, 'Supabase auth session lookup must be raced against a timeout for user actions.');
assertMatches(app, /WRITE_CONTEXT_SESSION_TIMEOUT[\s\S]*failing this action cleanly so it can be retried without refreshing/, 'session timeout diagnostic must say the action can retry without refresh.');

const getContext = findFunctionBody(app, 'getNormalizedWriteContext');
assertMatches(getContext, /hasFreshSupabaseSession\(\{ timeoutMs: mustUseBackendContext \? writeContextSessionTimeoutMs : 0,[\s\S]*source \}\)/, 'backend-required booking/trip/fuel write context must use the bounded session check before setup can hang.');
assertMatches(getContext, /normalizedWriteContextUnavailableError\(source, "session-not-fresh"\)/, 'missing or stale session must fail closed before local JSON/state changes.');

const renderContext = findFunctionBody(app, 'getRenderWriteContext');
assertMatches(renderContext, /buildRenderRequestHeaders\(\{ "Content-Type": "application\/json" \}, \{ timeoutMs: writeContextSessionTimeoutMs,[\s\S]*timeoutLabel: `\$\{source\} Render session`[\s\S]*source \}\)/, 'Render write-context headers must also use bounded session lookup, not an unbounded auth promise.');
assertMatches(renderContext, /paymentActionTimeoutError\("Render write context API", writeContextActionTimeoutMs\)/, 'Render write context fetch itself must stay bounded.');

const booking = findFunctionBody(app, 'saveBookingToNormalizedTablesFirst');
assertMatches(booking, /withNormalizedWriteContextTimeout\(getNormalizedWriteContext\(\{ source: "booking-save", requireRenderContext: true \}\), "booking-save"\)/, 'booking save must still use the bounded backend-required write context setup.');
assertMatches(booking, /finally\s*\{[\s\S]*finishForegroundOperationsBySource\("booking-save"[\s\S]*clearVisibleSavingFailsafe\(\);[\s\S]*\}/, 'booking setup failures must clear the foreground latch in finally.');

assert.ok(runValidations.includes('node tools/test-write-context-setup-timeout-root.mjs'), 'npm run validate must include the write-context setup timeout root guardrail.');
assert.ok(runValidations.includes('node --check tools/test-write-context-setup-timeout-root.mjs'), 'npm run validate must syntax-check the write-context setup timeout root guardrail.');

console.log('Write-context setup timeout root guardrails passed.');
