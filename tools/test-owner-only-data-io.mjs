#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");

assert.match(app, /const configuredAppOwnerEmails = Object.freeze\(\["chrjohn94@gmail.com"\]\)/, "global diagnostics must include the configured app-owner email");
assert.match(app, /function getPrimaryAppOwnerEmail\(\) \{[\s\S]*?normalizeMembers\(state\.members\)\[0\][\s\S]*?getConfiguredAppOwnerEmails\(\)\[0\]/, "global diagnostics must derive the app owner from the primary configured member with configured-owner fallback");
assert.match(app, /function isSignedInPrimaryAppOwner\(\) \{[\s\S]*?ownerEmails\.has\(signedInEmail\)/, "global diagnostics must require the signed-in owner email");
assert.match(app, /function canUseGlobalAdminTools\(\) \{[\s\S]*?return isSignedInPrimaryAppOwner\(\);/, "Data I/O/global tools must be owner-only in Supabase mode");
assert.match(app, /dataToolsPanel\) els\.dataToolsPanel\.classList\.toggle\("hidden", !canUseGlobalAdminTools\(\)\)/, "Data I/O panel must stay hidden unless owner diagnostics are allowed");
assert.match(app, /This action is restricted to the Fuel Ledger app owner/, "blocked owner-diagnostic actions must explain owner-only access");

console.log("Owner-only Data I/O guardrail passed.");
