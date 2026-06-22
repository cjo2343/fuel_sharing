import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";

function read(path) {
  assert.ok(existsSync(path), `${path} must exist`);
  return readFileSync(path, "utf8");
}

const moduleSource = read("render-api-client.js");
const app = read("app.js");
const index = read("index.html");
const serviceWorker = read("service-worker.js");

assert.match(moduleSource, /root\.FuelRenderApiClient\s*=\s*Object\.freeze/, "render-api-client.js must expose FuelRenderApiClient.");
assert.match(moduleSource, /const\s+ENDPOINTS\s*=\s*Object\.freeze/, "render-api-client.js must own backend endpoint names.");
assert.match(moduleSource, /async function requestJson\(/, "render-api-client.js must own the timeout-aware JSON request helper.");
assert.match(moduleSource, /function makeHeaders\(/, "render-api-client.js must own auth/header merging.");
assert.match(moduleSource, /parseJsonResponse/, "render-api-client.js must own response text/JSON parsing.");

const scripts = [...index.matchAll(/<script\s+[^>]*src=["']([^"']+)["'][^>]*>/g)].map((match) => match[1]);
const renderApiIndex = scripts.indexOf("render-api-client.js");
const appIndex = scripts.indexOf("app.js");
assert.ok(renderApiIndex >= 0, "index.html must load render-api-client.js.");
assert.ok(renderApiIndex < appIndex, "render-api-client.js must load before app.js.");
assert.match(serviceWorker, /"\/render-api-client\.js"/, "service-worker.js must cache render-api-client.js as a core asset.");

assert.match(app, /const\s+renderApiClient\s*=\s*window\.FuelRenderApiClient\s*\|\|\s*\{\}/, "app.js must bind the Render API client module.");
assert.match(app, /const\s+renderTripUpsertUrl\s*=\s*renderApiEndpoints\.tripUpsert\s*\|\|\s*"\/api\/trips\/upsert"/, "app.js Render endpoint constants should delegate to render-api-client.js.");
assert.match(app, /async function requestRenderJson\(/, "app.js must keep a thin compatibility wrapper for Render JSON requests.");
assert.match(app, /renderApiClient\.requestJson\(endpoint/, "requestRenderJson should delegate to the extracted Render API client when available.");
assert.match(app, /async function callRenderJson\([\s\S]*?requestRenderJson\(endpoint/, "callRenderJson should use the shared Render JSON wrapper instead of hand-rolling fetch/abort parsing.");
assert.match(app, /async function callRenderActionMutation\(/, "app.js must centralize member-action Render mutations.");
for (const fn of ["saveTripWithParticipantsViaRender", "saveFuelPaymentViaRender", "saveBookingViaRender", "softDeleteBookingViaRender"]) {
  const pattern = new RegExp(`async function ${fn}\\([\\s\\S]*?callRenderActionMutation\\(`);
  assert.match(app, pattern, `${fn} must delegate to the shared Render action mutation wrapper.`);
}
assert.match(app, /async function getRenderNormalizedStateRows\([\s\S]*?requestRenderJson\(renderStateLoadUrl/, "Render state load must use the shared JSON wrapper.");
assert.match(app, /async function getRenderWriteContext\([\s\S]*?requestRenderJson\(renderWriteContextUrl/, "Render write context must use the shared JSON wrapper.");

const calls = [];
const sandbox = {
  window: { setTimeout, clearTimeout },
  console,
  AbortController,
  fetch: async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ ok: true, route: url }); }
    };
  }
};
vm.runInNewContext(moduleSource, sandbox, { filename: "render-api-client.js" });
const client = sandbox.window.FuelRenderApiClient;
assert.equal(client.ENDPOINTS.stateLoad, "/api/state/load", "Render API client should expose the state-load endpoint.");
assert.equal(client.ENDPOINTS.tripUpsert, "/api/trips/upsert", "Render API client should expose the trip endpoint.");
const response = await client.requestJson(client.ENDPOINTS.tripUpsert, {
  accessToken: "test-token",
  body: { trip: { id: "trip-1" } },
  timeoutMs: 50,
  timeoutLabel: "test trip request"
});
assert.equal(response.result.ok, true, "requestJson should parse successful JSON responses.");
assert.equal(calls[0].url, "/api/trips/upsert", "requestJson should call the requested endpoint.");
assert.equal(calls[0].options.headers.Authorization, "Bearer test-token", "requestJson should attach bearer tokens through makeHeaders.");
assert.equal(calls[0].options.headers["Content-Type"], "application/json", "requestJson should add JSON Content-Type by default.");
assert.equal(calls[0].options.body, JSON.stringify({ trip: { id: "trip-1" } }), "requestJson should JSON-stringify object bodies.");

console.log("Render API client module extraction guardrails passed.");
