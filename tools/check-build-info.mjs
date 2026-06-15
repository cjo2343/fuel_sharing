#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const runtimeFiles = new Set([
  "index.html",
  "styles.css",
  "utils.js",
  "supabase-helpers.js",
  "data-store.js",
  "settlement-calculations.js",
  "ui-messages.js",
  "sync-status-helpers.js",
  "location-privacy-helpers.js",
  "audit-log.js",
  "notifications.js",
  "admin-tools.js",
  "permission-helpers.js",
  "booking-calendar.js",
  "app.js",
  "server.py",
  "service-worker.js",
  "build-info.js"
]);

function readConstants() {
  const buildInfo = readFileSync("build-info.js", "utf8");
  const serviceWorker = readFileSync("service-worker.js", "utf8");
  const expectedCache = buildInfo.match(/expectedServiceWorkerCache:\s*"([^"]+)"/)?.[1];
  const buildLabel = buildInfo.match(/buildLabel:\s*"([^"]+)"/)?.[1];
  const updatedAt = buildInfo.match(/updatedAt:\s*"([^"]+)"/)?.[1];
  const cacheName = serviceWorker.match(/const CACHE_NAME = "([^"]+)"/)?.[1];
  const swLabel = serviceWorker.match(/const BUILD_LABEL = "([^"]+)"/)?.[1];
  const swUpdatedAt = serviceWorker.match(/const BUILD_UPDATED_AT = "([^"]+)"/)?.[1];
  return { expectedCache, buildLabel, updatedAt, cacheName, swLabel, swUpdatedAt };
}

const constants = readConstants();
const mismatches = [];
if (!constants.expectedCache || !constants.cacheName || constants.expectedCache !== constants.cacheName) {
  mismatches.push(`build-info expected cache (${constants.expectedCache || "missing"}) must match service-worker cache (${constants.cacheName || "missing"}).`);
}
if (!constants.buildLabel || !constants.swLabel || constants.buildLabel !== constants.swLabel) {
  mismatches.push(`build label (${constants.buildLabel || "missing"}) must match service-worker build label (${constants.swLabel || "missing"}).`);
}
if (!constants.updatedAt || !constants.swUpdatedAt || constants.updatedAt !== constants.swUpdatedAt) {
  mismatches.push(`updatedAt (${constants.updatedAt || "missing"}) must match service-worker updatedAt (${constants.swUpdatedAt || "missing"}).`);
}
if (mismatches.length) {
  console.error("Build metadata mismatch:");
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

function gitChangedFiles() {
  try {
    return execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    console.warn("Skipping build metadata freshness check because this directory is not a Git checkout.");
    return [];
  }
}

const changedRuntimeFiles = gitChangedFiles().filter((filePath) => runtimeFiles.has(filePath));
const changedRuntimeWithoutMetadata = changedRuntimeFiles.filter((filePath) => !["build-info.js", "service-worker.js"].includes(filePath));
if (changedRuntimeWithoutMetadata.length > 0 && (!changedRuntimeFiles.includes("build-info.js") || !changedRuntimeFiles.includes("service-worker.js"))) {
  console.error("Runtime files changed without updating both build-info.js and service-worker.js:");
  for (const filePath of changedRuntimeWithoutMetadata) console.error(`- ${filePath}`);
  console.error("\nUpdate the build label/version and bump the service worker cache before committing.");
  process.exit(1);
}

console.log("Build metadata check passed.");
