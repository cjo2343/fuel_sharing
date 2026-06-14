import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {
  window: {},
  Date,
  Number,
  String,
  Math,
  console
};
context.window.Date = Date;
vm.createContext(context);
vm.runInContext(readFileSync("sync-status-helpers.js", "utf8"), context);

const helpers = context.window.FuelSyncStatus;

function testQueuedStatusShowsPendingLocalChanges() {
  const display = helpers.syncDisplayForStatus("Queued", {
    pendingCount: 2,
    lastLocalSaveAt: "2026-06-14T16:05:00.000Z"
  });
  assert.equal(display.text, "Unsynced");
  assert.equal(display.status, "queued");
  assert.match(display.detail, /2 unsynced changes/);
  assert.match(display.detail, /saved on this device/);
}

function testLocalStatusShowsSaveFailureAndPendingCount() {
  const display = helpers.syncDisplayForStatus("Local", {
    pendingCount: 1,
    lastSyncError: "Network unavailable"
  });
  assert.equal(display.text, "Local only");
  assert.equal(display.status, "local");
  assert.match(display.detail, /1 unsynced change/);
  assert.match(display.detail, /Network unavailable/);
}

function testLoginStatusWarnsAboutUnsyncedLocalChanges() {
  const display = helpers.syncDisplayForStatus("Login", { pendingCount: 3 });
  assert.equal(display.status, "login");
  assert.match(display.detail, /Sign in to sync 3 unsynced changes/);
}

function testSavedStatusesClearPendingLanguage() {
  const display = helpers.syncDisplayForStatus("Tables", {
    pendingCount: 4,
    lastCloudSaveAt: "2026-06-14T16:06:00.000Z"
  });
  assert.equal(display.text, "Database");
  assert.equal(display.status, "tables");
  assert.match(display.detail, /Synced/);
  assert.match(display.detail, /live sync off/);
  assert.doesNotMatch(display.detail, /unsynced/);
}

const tests = [
  testQueuedStatusShowsPendingLocalChanges,
  testLocalStatusShowsSaveFailureAndPendingCount,
  testLoginStatusWarnsAboutUnsyncedLocalChanges,
  testSavedStatusesClearPendingLanguage
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}
