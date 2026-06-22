import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const runValidations = fs.readFileSync('tools/run-validations.mjs', 'utf8');

function fail(message, context = '') {
  throw new assert.AssertionError({
    message: context ? `${message}\n\nContext:\n${context.slice(0, 1200)}` : message
  });
}

function findFunctionBody(source, name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const match = pattern.exec(source);
  if (!match) fail(`Expected function ${name} to exist.`);
  let index = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = index; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(index, i + 1);
    }
  }
  fail(`Could not parse body for ${name}.`);
}

function assertMatches(text, regex, message) {
  if (!regex.test(text)) fail(message, text);
}

const recoverBody = findFunctionBody(app, 'recoverInteractiveActionControls');
assertMatches(recoverBody, /recoverStaleInteractiveActionState\(`controls:\$\{normalizedReason\}`\)/,
  'interactive recovery must use the shared stale-action preflight instead of requiring refresh.');
assertMatches(recoverBody, /const recoveredDataIo = recoveredStale\.clearedDataIo \|\| 0/,
  'interactive recovery must report only stale Data I/O cleared by the preflight.');
if (/finishRetryableInteractiveDataIoOperations\(normalizedReason\)/.test(recoverBody)) {
  fail('interactive recovery must not clear fresh active Data I/O operations on every focus/render recovery.', recoverBody);
}
assertMatches(recoverBody, /#vehicleLookupButton[\s\S]*bindInteractiveActionControl\(vehicleButton, handleVehicleLookupButtonClick/,
  'vehicle lookup must be re-bound by the recovery pass after re-render/deploy handoff.');
assertMatches(recoverBody, /#cancelBookingEdit[\s\S]*bindInteractiveActionControl\(cancelBookingButton, handleCancelBookingEditClick/,
  'cancel booking must be re-bound by the recovery pass after re-render/deploy handoff.');

assertMatches(app, /function finishActiveDataIoOperationsBySource[\s\S]*INTERACTIVE_ACTION_RECOVERED/,
  'stale active Data I/O operations must be closed with an explicit recovery result code.');
assertMatches(app, /function finishRetryableInteractiveDataIoOperations[\s\S]*vehicle-lookup-click[\s\S]*booking-save[\s\S]*trip-save[\s\S]*fuel-save[\s\S]*booking-delete[\s\S]*period-close/,
  'retryable user actions must be listed for diagnostics compatibility.');
assertMatches(app, /function finishStaleForegroundBlockingDataIoOperations[\s\S]*INTERACTIVE_ACTION_STALE_DATA_IO_CLEARED/,
  'stale foreground-blocking Data I/O operations must be closed with a timeout result code.');
assertMatches(app, /document\.addEventListener\("click", handleInteractiveActionPreflightEvent, true\)/,
  'capture-phase click preflight must clear stale button latches before handlers run.');
assertMatches(app, /function bindInteractiveActionControl[\s\S]*dataset[\s\S]*addEventListener\("click"/,
  'interactive controls must use idempotent delegated/recoverable binding.');

const cancelBody = findFunctionBody(app, 'handleCancelBookingEditClick');
assertMatches(cancelBody, /existingBooking[\s\S]*setBookingCalendarAnchor\(existingBooking\?\.start \|\| fallbackStart/,
  'cancel booking must use the current edited booking or form start, not an out-of-scope bookingPayload variable.');
assert(!cancelBody.includes('bookingPayload.start'), 'cancel booking must not reference undefined bookingPayload.start.');

const renderBody = findFunctionBody(app, 'render');
assertMatches(renderBody, /recoverInteractiveActionControls\("render"\)/,
  'render() must recover interactive controls after DOM updates.');
assertMatches(app, /window\.addEventListener\("focus", \(\) => \{\n\s*recoverInteractiveActionControls\("window-focus"\)/,
  'focus return must recover controls/latches.');
assertMatches(app, /visibilitychange[\s\S]*recoverInteractiveActionControls\("visibility-return"\)/,
  'visibility return must recover controls/latches.');
assertMatches(app, /service-worker-controllerchange[\s\S]*recoverInteractiveActionControls\("service-worker-controllerchange"\)/,
  'service-worker deploy handoff must recover controls/latches before safe reload.');
assertMatches(app, /startup-gate-ready:\$\{normalizedReason\}[\s\S]*recoverInteractiveActionControls/,
  'startup gate ready must recover controls/latches before normal use.');
assertMatches(app, /workspace-switch-confirmed:\$\{source\}[\s\S]*recoverInteractiveActionControls/,
  'workspace switch confirmation must recover controls/latches.');
assertMatches(app, /interactiveRecoveryAvailable:/,
  'no-refresh debug state must expose whether interactive recovery is available.');

assert.ok(runValidations.includes('node tools/test-interactive-action-recovery-lane.mjs'),
  'npm run validate must include the interactive action recovery guardrail.');
assert.ok(runValidations.includes('node --check tools/test-interactive-action-recovery-lane.mjs'),
  'npm run validate must syntax-check the interactive action recovery guardrail.');

console.log('Interactive action recovery guardrails passed: controls are recoverable after render/focus/visibility/service-worker handoff, stale latches finish, and cancel booking no longer references bookingPayload.');
