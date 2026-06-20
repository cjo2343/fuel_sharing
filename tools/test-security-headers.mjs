#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const REQUIRED_HEADERS = [
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Strict-Transport-Security',
  'Referrer-Policy',
  'Permissions-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
  'Origin-Agent-Cluster',
  'X-Permitted-Cross-Domain-Policies'
];

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function testVercelHeaders() {
  const config = JSON.parse(read('vercel.json'));
  const headers = Object.fromEntries(config.headers[0].headers.map((header) => [header.key, header.value]));
  for (const header of REQUIRED_HEADERS) {
    assert.ok(headers[header], `vercel.json missing ${header}`);
  }
  assert.match(headers['Content-Security-Policy'], /default-src 'self'/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(headers['Content-Security-Policy'], /object-src 'none'/);
  assert.match(headers['Content-Security-Policy'], /script-src 'self'(;|$)/);
  assert.match(headers['Content-Security-Policy'], /style-src 'self'(;|$)/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /unsafe-inline/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /cdn\.jsdelivr\.net/);
  assert.match(headers['Strict-Transport-Security'], /max-age=31536000/);
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Permitted-Cross-Domain-Policies'], 'none');
}

function testStaticHeadersFile() {
  const headers = read('_headers');
  for (const header of REQUIRED_HEADERS) {
    assert.match(headers, new RegExp(`${header}:`), `_headers missing ${header}`);
  }
  assert.match(headers, /Content-Security-Policy: .*default-src 'self'/);
  assert.match(headers, /script-src 'self'(;|$)/);
  assert.match(headers, /style-src 'self'(;|$)/);
  assert.doesNotMatch(headers, /unsafe-inline/);
  assert.doesNotMatch(headers, /cdn\.jsdelivr\.net/);
  assert.match(headers, /Strict-Transport-Security: max-age=31536000; includeSubDomains; preload/);
}

function testLocalServerHeaders() {
  const server = read('server.py');
  for (const header of REQUIRED_HEADERS) {
    assert.match(server, new RegExp(`['"]${header}['"]`), `server.py missing ${header}`);
  }
  assert.match(server, /def content_security_policy\(\):/);
  assert.match(server, /configured_supabase_origin\(\)/);
  assert.match(server, /configured_supabase_realtime_origin\(\)/);
  assert.match(server, /"style-src 'self'"/);
  assert.doesNotMatch(server, /unsafe-inline/);
  assert.doesNotMatch(server, /cdn\.jsdelivr\.net/);
}

function testJsonApiAuthFailsClosedByDefault() {
  const server = read('server.py');
  assert.match(server, /FUEL_LEDGER_ALLOW_UNAUTHENTICATED_LOCAL_API/, 'server.py must require an explicit local JSON API auth opt-out');
  assert.match(server, /return not env_flag\("FUEL_LEDGER_ALLOW_UNAUTHENTICATED_LOCAL_API"\)/, 'JSON fallback API auth must fail closed by default');
  assert.doesNotMatch(server, /Local development and Playwright use the JSON API without a secret by default/, 'local JSON API auth must not stay open by default');
}

function testNoInlineStylesRemainInMarkup() {
  const index = read('index.html');
  assert.doesNotMatch(index, /<style[\s>]/i, 'index.html must not use inline <style> blocks');
  assert.doesNotMatch(index, /\sstyle=/i, 'index.html must not use inline style attributes');
}

const tests = [testVercelHeaders, testStaticHeadersFile, testLocalServerHeaders, testJsonApiAuthFailsClosedByDefault, testNoInlineStylesRemainInMarkup];
for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}
