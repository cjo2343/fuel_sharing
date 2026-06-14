import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { window: {}, Number, String, Object, Math, console };
vm.createContext(context);
vm.runInContext(readFileSync("location-privacy-helpers.js", "utf8"), context);
const helpers = context.window.FuelLocationPrivacy;

function testDefaultModeSavesStationOnly() {
  const payload = helpers.buildFuelLocationPayload({
    userLatitude: 55.6761239,
    userLongitude: 12.5683372,
    stationLatitude: 55.67,
    stationLongitude: 12.56,
    stationName: "Circle K",
    stationBrand: "Circle K"
  });
  assert.equal(payload.mode, "station-only");
  assert.equal(payload.location, null);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.stationInfo)), { name: "Circle K", brand: "Circle K", latitude: 55.67, longitude: 12.56 });
}

function testNoCoordinatesSavesOnlyStationNameOutsideHelper() {
  const payload = helpers.buildFuelLocationPayload({
    mode: "no-coordinates",
    userLatitude: 55.676123,
    userLongitude: 12.568337,
    stationLatitude: 55.67,
    stationLongitude: 12.56,
    stationName: "OK",
    stationBrand: "OK"
  });
  assert.equal(payload.mode, "no-coordinates");
  assert.equal(payload.location, null);
  assert.equal(payload.stationInfo, null);
}

function testFullModeCanSaveUserAndStationCoordinates() {
  const payload = helpers.buildFuelLocationPayload({
    mode: "full",
    userLatitude: "55.6761239",
    userLongitude: "12.5683372",
    stationLatitude: "55.670009",
    stationLongitude: "12.560001",
    stationName: "Shell"
  });
  assert.equal(payload.mode, "full");
  assert.deepEqual(JSON.parse(JSON.stringify(payload.location)), { latitude: 55.676124, longitude: 12.568337 });
  assert.deepEqual(JSON.parse(JSON.stringify(payload.stationInfo)), { name: "Shell", brand: "", latitude: 55.670009, longitude: 12.560001 });
}

function testInferModeFromExistingFuel() {
  assert.equal(helpers.inferFuelLocationPrivacyMode({ location: { latitude: 1, longitude: 2 } }), "full");
  assert.equal(helpers.inferFuelLocationPrivacyMode({ stationInfo: { latitude: 1, longitude: 2 } }), "station-only");
  assert.equal(helpers.inferFuelLocationPrivacyMode({ station: "Manual" }), "no-coordinates");
}

for (const test of [
  testDefaultModeSavesStationOnly,
  testNoCoordinatesSavesOnlyStationNameOutsideHelper,
  testFullModeCanSaveUserAndStationCoordinates,
  testInferModeFromExistingFuel
]) {
  test();
  console.log(`ok - ${test.name}`);
}
