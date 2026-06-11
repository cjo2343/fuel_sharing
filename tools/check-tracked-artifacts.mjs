#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const forbiddenTrackedPaths = [
  {
    label: "node_modules dependencies",
    matches: (path) => path === "node_modules" || path.startsWith("node_modules/")
  },
  {
    label: "Python cache files",
    matches: (path) => path === "__pycache__" || path.includes("/__pycache__/") || path.endsWith(".pyc")
  },
  {
    label: "backup files",
    matches: (path) => path.endsWith(".bak")
  },
  {
    label: "Playwright reports",
    matches: (path) => path === "playwright-report" || path.startsWith("playwright-report/")
  },
  {
    label: "Playwright test results",
    matches: (path) => path === "test-results" || path.startsWith("test-results/")
  },
  {
    label: "isolated local Playwright data",
    matches: (path) => path === ".playwright-ledger-data.json"
  },
  {
    label: "macOS Finder metadata",
    matches: (path) => path === ".DS_Store" || path.endsWith("/.DS_Store")
  }
];

function getTrackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    console.warn("Skipping tracked-artifact check because this directory is not a Git checkout.");
    return [];
  }
}

const trackedFiles = getTrackedFiles();
const violations = [];
for (const filePath of trackedFiles) {
  for (const rule of forbiddenTrackedPaths) {
    if (rule.matches(filePath)) {
      violations.push({ filePath, label: rule.label });
      break;
    }
  }
}

if (violations.length > 0) {
  console.error("Generated or machine-local files are tracked by Git:");
  for (const violation of violations) {
    console.error(`- ${violation.filePath} (${violation.label})`);
  }
  console.error("\nRemove them from Git tracking, then commit the cleanup. Example:");
  console.error("git rm -r --cached node_modules __pycache__ playwright-report test-results .playwright-ledger-data.json 2>/dev/null || true");
  console.error("git rm --cached app.js.bak 2>/dev/null || true");
  process.exit(1);
}

console.log("Tracked-artifact check passed.");
