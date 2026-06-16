import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

function read(path) {
  assert.ok(existsSync(path), `${path} must exist`);
  return readFileSync(path, "utf8");
}

function localRuntimeScriptsFromIndex(html) {
  const scripts = [...html.matchAll(/<script\s+[^>]*src=["']([^"']+)["'][^>]*>/g)].map((match) => match[1]);
  return scripts.filter((src) => src.endsWith(".js") && !src.startsWith("http://") && !src.startsWith("https://"));
}

function coreAssetsFromServiceWorker(source) {
  const assetBlock = source.match(/const\s+CORE_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(assetBlock, "service-worker.js must define CORE_ASSETS");
  return [...assetBlock[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

const indexHtml = read("index.html");
const serviceWorker = read("service-worker.js");
const scripts = localRuntimeScriptsFromIndex(indexHtml);
const coreAssets = coreAssetsFromServiceWorker(serviceWorker);
const normalizedCoreAssets = new Set(coreAssets.map((asset) => asset.replace(/^\//, "")));

assert.ok(scripts.includes("app.js"), "index.html must load app.js");
assert.ok(scripts.includes("vendor/supabase-js-2.43.4/supabase.js"), "index.html must load the vendored Supabase client");
assert.ok(!indexHtml.includes("cdn.jsdelivr.net"), "index.html must not load runtime scripts from jsDelivr");
assert.ok(coreAssets.includes("/vendor/supabase-js-2.43.4/26.supabase.js"), "service worker must cache the vendored Supabase UMD chunk");

for (const script of scripts) {
  assert.ok(existsSync(script), `${script} referenced by index.html must exist`);
  assert.ok(normalizedCoreAssets.has(script), `${script} referenced by index.html must be cached by service-worker.js CORE_ASSETS`);
}

for (const asset of coreAssets.filter((asset) => asset.endsWith(".js"))) {
  const file = asset.replace(/^\//, "");
  assert.ok(existsSync(file), `${asset} listed in CORE_ASSETS must exist`);
}

const scriptOrder = new Map(scripts.map((script, index) => [script, index]));
const appIndex = scriptOrder.get("app.js");
for (const helper of [
  "utils.js",
  "supabase-helpers.js",
  "ledger-model.js",
  "data-store.js",
  "settlement-calculations.js",
  "ui-messages.js",
  "sync-status-helpers.js",
  "location-privacy-helpers.js",
  "period-closing-helpers.js",
  "stress-test-helpers.js",
  "security-health-helpers.js",
  "audit-log.js",
  "notifications.js",
  "admin-tools.js",
  "permission-helpers.js",
  "build-info.js",
  "booking-calendar.js",
  "trip-actions.js",
  "trip-rendering.js",
  "fuel-rendering.js",
  "planner-booking-bridge.js"
]) {
  assert.ok(scriptOrder.has(helper), `${helper} must be loaded by index.html`);
  assert.ok(scriptOrder.get(helper) < appIndex, `${helper} must load before app.js`);
}

const cacheName = serviceWorker.match(/const\s+CACHE_NAME\s*=\s*["']([^"']+)["']/)?.[1];
const buildInfo = read("build-info.js");
const expectedCache = buildInfo.match(/expectedServiceWorkerCache:\s*["']([^"']+)["']/)?.[1];
assert.ok(cacheName, "service-worker.js must expose CACHE_NAME");
assert.equal(cacheName, expectedCache, "service-worker.js CACHE_NAME must match build-info.js expectedServiceWorkerCache");
assert.ok(serviceWorker.includes("core-asset-cache-failure"), "service worker should log cache install failures for diagnostics");
assert.ok(serviceWorker.includes("function cacheFirstCoreAsset"), "service worker should serve core app-shell assets from cache first");
assert.ok(serviceWorker.includes("eventlessRefreshCoreAsset"), "service worker should refresh cached app-shell assets in the background");
assert.ok(serviceWorker.includes("core-asset-refresh-failure"), "service worker should log background cache refresh failures for diagnostics");
assert.ok(serviceWorker.includes("function sanitizeNotificationUrl"), "service worker should sanitize notification click URLs");
assert.ok(serviceWorker.includes("candidate.origin !== self.location.origin"), "notification click URLs must be restricted to same-origin paths");

console.log("Runtime asset parity check passed.");
