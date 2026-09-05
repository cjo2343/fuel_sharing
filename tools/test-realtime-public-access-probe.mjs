import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const probePath = fileURLToPath(new URL('./probe-realtime-public-access.mjs', import.meta.url));

// Run the actual CLI with a fake transport. No test can contact a live project.
function runProbe(scenario, { env = {}, args = [] } = {}) {
  const fixture = `
    const scenario = ${JSON.stringify(scenario)};
    globalThis.WebSocket = class extends EventTarget {
      constructor(url) {
        super();
        if (scenario === 'constructor-error') throw new Error('failed ' + url);
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      close() {}
      send(raw) {
        const join = JSON.parse(raw);
        const privateJoin = join.payload.config.private;
        const message = (event, payload, ref = '1') => queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
            topic: join.topic, event, ref, payload,
          }) }));
        });
        if (scenario === 'socket-error') return this.dispatchEvent(new Event('error'));
        if (scenario === 'socket-close') return this.dispatchEvent(new Event('close'));
        if (scenario === 'timeout') return;
        if (scenario === 'system-ok') return message('system', { status: 'ok' });
        if (scenario === 'wrong-ref') return message('phx_reply', { status: 'ok' }, '2');
        if (scenario === 'public-open') return message('phx_reply', { status: 'ok' });
        if (scenario === 'system-private-only') {
          return message('system', { status: 'error', code: 'PrivateOnly', message: 'Private channels only' });
        }
        if (privateJoin && scenario === 'private-joined') return message('phx_reply', { status: 'ok' });
        const reason = privateJoin ? 'Unauthorized' : ({
          'unauthorized': 'Unauthorized',
          'rate-limit': 'TooManyChannels',
          'misleading-code': 'NotPrivateOnly',
          'echo-key': 'Unauthorized: ' + process.env.SUPABASE_ANON_KEY,
          'echo-token': 'Unauthorized: ' + process.env.SUPABASE_ACCESS_TOKEN,
        }[scenario] || 'PrivateOnly');
        message('phx_reply', { status: 'error', response: { reason } });
      }
    };
  `;
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript;base64,${Buffer.from(fixture).toString('base64')}`,
    probePath, ...args,
  ], {
    encoding: 'utf8', timeout: 3000,
    env: {
      ...process.env,
      SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'fixture-anon-key',
      SUPABASE_ACCESS_TOKEN: '', LEDGER_ID: '', PROBE_TIMEOUT_MS: '20', ...env,
    },
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('public access is a failing result', () => {
  assert.equal(runProbe('public-open').status, 1);
});

test('PrivateOnly proves only the public half without a member token', () => {
  const result = runProbe('private-only');
  assert.equal(result.status, 0);
  assert.match(result.output, /phase 2 .*SKIPPED/);
  assert.doesNotMatch(result.output, /Both halves evidenced/);
});

test('PrivateOnly in a system error is recognized', () => {
  assert.equal(runProbe('system-private-only').status, 0);
});

for (const scenario of ['unauthorized', 'rate-limit', 'misleading-code', 'socket-error',
  'socket-close', 'timeout', 'system-ok', 'wrong-ref']) {
  test(`${scenario} is inconclusive, never proof of private-only access`, () => {
    assert.equal(runProbe(scenario).status, 2);
  });
}

test('member phase requires an explicitly selected workspace', () => {
  const result = runProbe('private-joined', { env: { SUPABASE_ACCESS_TOKEN: 'fixture-member-token' } });
  assert.equal(result.status, 2);
  assert.match(result.output, /LEDGER_ID/);
});

test('both phases can succeed for the selected workspace', () => {
  const result = runProbe('private-joined', { env: {
    SUPABASE_ACCESS_TOKEN: 'fixture-member-token', LEDGER_ID: 'test-workspace',
  } });
  assert.equal(result.status, 0);
  assert.match(result.output, /Both halves evidenced/);
});

test('a denied member is inconclusive, not proof all users are down', () => {
  const result = runProbe('private-denied', { env: {
    SUPABASE_ACCESS_TOKEN: 'fixture-member-token', LEDGER_ID: 'test-workspace',
  } });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.output, /down for real users/);
});

for (const value of ['NaN', '-1', '0', '1.5', 'Infinity', '120001']) {
  test(`invalid timeout ${value} is rejected before probing`, () => {
    assert.equal(runProbe('private-only', { args: ['--timeout', value] }).status, 2);
  });
}

for (const value of ['not-a-url', 'file:///tmp/config', 'https://user:secret@example.com',
  'https://example.com?token=secret', 'https://example.com/path']) {
  test(`invalid project URL ${value} is rejected without echoing it`, () => {
    const result = runProbe('private-only', { env: { SUPABASE_URL: value } });
    assert.equal(result.status, 2);
    assert.ok(!result.output.includes(value));
  });
}

for (const scenario of ['constructor-error', 'echo-key', 'echo-token']) {
  test(`${scenario} cannot print credentials`, () => {
    const result = runProbe(scenario, { env: {
      SUPABASE_ACCESS_TOKEN: 'fixture-member-token', LEDGER_ID: 'test-workspace',
    } });
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.output, /fixture-anon-key|fixture-member-token/);
  });
}
