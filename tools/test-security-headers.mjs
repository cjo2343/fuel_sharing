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
}

const tests = [testVercelHeaders, testStaticHeadersFile, testLocalServerHeaders];
for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}
