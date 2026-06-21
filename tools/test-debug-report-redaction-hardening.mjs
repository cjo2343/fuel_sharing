#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const deploymentChecklist = readFileSync("DEPLOYMENT-CHECKLIST.md", "utf8");
const maintenanceNotes = readFileSync("MAINTENANCE-NOTES.md", "utf8");
const hardeningSteps = readFileSync("SECURITY-HARDENING-STEPS.md", "utf8");

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:218|219|220|221|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251|252|253|254|255|256|257)"/, "runtime version should be bumped for redaction hardening");
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:31[89]|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368|369|370|371|372)"/, "build-info should point at v318 cache");
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:31[89]|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368|369|370|371|372)"/, "service worker should use v318 cache");
assert.match(buildInfo, /Debug, load-monitor, and saved Test Lab\/Security Health reports now redact more token spellings/, "release note should describe redaction hardening");

assert.match(app, /function redactDiagnosticUrlSecrets\(value\)/, "URL secret redactor should exist");
assert.match(app, /accessToken\|refreshToken/, "URL redaction should cover camelCase token query parameters");
assert.match(app, /anon_key\|anonKey\|supabase_key\|supabaseKey/, "URL redaction should cover Supabase anon key spellings");
assert.match(app, /service_role\|serviceRole\|serviceRoleKey/, "URL redaction should cover service-role key spellings");
assert.match(app, /client_secret\|clientSecret/, "URL redaction should cover OAuth/client secret spellings");

assert.match(app, /apiKey\|apikey\|anon_key\|anonKey\|supabase_key\|supabaseKey/, "string redaction should cover camelCase and Supabase key names");
assert.match(app, /authorization\|auth\|jwt\|bearer\|password\|secret/, "string redaction should cover auth header/token labels");
assert.match(app, /headers\|session\|token\|authorization\|auth\|bearer\|credential/, "sensitive key detection should redact header and credential objects");
assert.match(app, /cookie\|jwt/, "sensitive key detection should redact cookie and JWT keys");
assert.match(app, /redactSensitiveDiagnostics\(buildSupabaseLoadReport\(\)\)/, "load report export should run redaction");
assert.match(app, /const exportedReport = redactSensitiveDiagnostics\(report\)/, "Test Lab export should run redaction");
assert.match(app, /const reportToStore = sanitizeStoredDiagnosticReport\(report\)/, "stored reports should run storage sanitizer");
assert.match(app, /delete sanitized\.browser/, "stored reports should remove browser metadata");
assert.match(app, /delete sanitized\.dataIoDiagnostics/, "stored reports should remove raw Data I/O diagnostics");
assert.match(app, /privacyPruned = true/, "stored reports should mark privacy pruning");

assert.match(deploymentChecklist, /v218: Debug\/report redaction now covers auth headers, cookies, Supabase key spellings/, "deployment checklist should document v218 redaction hardening");
assert.match(maintenanceNotes, /v318 debug\/report redaction hardening/, "maintenance notes should document redaction hardening");
assert.match(hardeningSteps, /v318 debug\/report redaction hardening/, "hardening notes should document redaction hardening");

console.log("Debug/report redaction hardening guard passed.");
