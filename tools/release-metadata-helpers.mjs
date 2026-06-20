import assert from "node:assert/strict";

function parseBuildInfoVersion(source) {
  const match = source.match(/version:\s*"(\d{4})\.(\d{2})\.(\d{2})\.(\d+)"/);
  assert.ok(match, "build-info.js must expose BUILD_INFO.version");
  const [, year, month, day, patch] = match;
  return {
    text: `${year}.${month}.${day}.${patch}`,
    year: Number(year),
    month: Number(month),
    day: Number(day),
    patch: Number(patch)
  };
}

function parseMinimumVersion(version) {
  const match = String(version).match(/^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/);
  assert.ok(match, `minimum version must use YYYY.MM.DD.patch format: ${version}`);
  const [, year, month, day, patch] = match;
  return {
    text: `${year}.${month}.${day}.${patch}`,
    year: Number(year),
    month: Number(month),
    day: Number(day),
    patch: Number(patch)
  };
}

function compareVersions(left, right) {
  for (const key of ["year", "month", "day", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

function parseBuildInfoCache(source) {
  const match = source.match(/expectedServiceWorkerCache:\s*"fuel-ledger-v(\d+)"/);
  assert.ok(match, "build-info.js must expose BUILD_INFO.expectedServiceWorkerCache");
  return Number(match[1]);
}

function parseServiceWorkerCache(source) {
  const match = source.match(/CACHE_NAME\s*=\s*"fuel-ledger-v(\d+)"/);
  assert.ok(match, "service-worker.js must expose CACHE_NAME");
  return Number(match[1]);
}

function parseBuildInfoLabel(source) {
  const match = source.match(/buildLabel:\s*"([^"]+)"/);
  assert.ok(match, "build-info.js must expose BUILD_INFO.buildLabel");
  return match[1];
}

function parseServiceWorkerLabel(source) {
  const match = source.match(/BUILD_LABEL\s*=\s*"([^"]+)"/);
  assert.ok(match, "service-worker.js must expose BUILD_LABEL");
  return match[1];
}

export function assertBuildInfoVersionAtLeast(buildInfoSource, minimumVersion, message = "build-info.js version must be current enough") {
  const actual = parseBuildInfoVersion(buildInfoSource);
  const minimum = parseMinimumVersion(minimumVersion);
  assert.ok(
    compareVersions(actual, minimum) >= 0,
    `${message}: expected at least ${minimum.text}, got ${actual.text}`
  );
}

export function assertBuildInfoCacheAtLeast(buildInfoSource, minimumCache, message = "build-info.js expected cache must be current enough") {
  const actual = parseBuildInfoCache(buildInfoSource);
  assert.ok(
    actual >= minimumCache,
    `${message}: expected at least fuel-ledger-v${minimumCache}, got fuel-ledger-v${actual}`
  );
}

export function assertServiceWorkerCacheAtLeast(serviceWorkerSource, minimumCache, message = "service-worker cache must be current enough") {
  const actual = parseServiceWorkerCache(serviceWorkerSource);
  assert.ok(
    actual >= minimumCache,
    `${message}: expected at least fuel-ledger-v${minimumCache}, got fuel-ledger-v${actual}`
  );
}

export function assertBuildAndServiceWorkerLabelsMatch(buildInfoSource, serviceWorkerSource, message = "build labels must match") {
  const buildInfoLabel = parseBuildInfoLabel(buildInfoSource);
  const serviceWorkerLabel = parseServiceWorkerLabel(serviceWorkerSource);
  assert.equal(buildInfoLabel, serviceWorkerLabel, message);
}

export function assertReleaseMetadataAtLeast(buildInfoSource, serviceWorkerSource, { minimumVersion, minimumCache, message = "release metadata must be current enough" }) {
  assertBuildInfoVersionAtLeast(buildInfoSource, minimumVersion, `${message} version`);
  assertBuildInfoCacheAtLeast(buildInfoSource, minimumCache, `${message} build-info cache`);
  assertServiceWorkerCacheAtLeast(serviceWorkerSource, minimumCache, `${message} service-worker cache`);
  assertBuildAndServiceWorkerLabelsMatch(buildInfoSource, serviceWorkerSource, `${message} labels`);
}
