#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} missing: ${needle}`);
  }
}

assertContains(app, 'async function withSecurityHealthProbeTimeout', 'security health per-probe timeout helper');
assertContains(app, 'error.isSecurityHealthProbeTimeout = true;', 'security health timeout marker');
assertContains(app, 'probeTimeoutMs = 10000', 'security health probe timeout option');
assertContains(app, 'withSecurityHealthProbeTimeout("Supabase session refresh", hasFreshSupabaseSession(), probeTimeoutMs)', 'session refresh timeout guard');
assertContains(app, 'withSecurityHealthProbeTimeout("Active ledger members probe", supabaseClient', 'member probe timeout guard');
assertContains(app, 'withSecurityHealthProbeTimeout("Fuel Ledger healthcheck RPC", supabaseClient.rpc("fuel_ledger_healthcheck"', 'healthcheck rpc timeout guard');
assertContains(app, 'refreshSupabaseSecurityHealth({ silent: true, force, probeTimeoutMs: timeoutMs })', 'test lab uses per-probe security health timeout');
assertContains(app, 'setDataToolsMessage("Saving fresh Test Lab report to normalized cloud history...")', 'cloud save visible progress');
assertContains(app, 'const savedToReportStore = await saveTestLabReportToCloudStore(redactTestLabReportForCloud(report));', 'cloud save awaits normalized report store');
assertContains(app, 'Fresh Test Lab report saved to normalized cloud history.', 'cloud save visible success');
assertContains(app, 'Could not save Test Lab report:', 'cloud save visible failure');

if (app.includes('Latest Test Lab report queued for cloud save.')) {
  throw new Error('cloud save should not use the old queued/no-confirmation message');
}

console.log('Security Health probe and cloud-save guard check passed.');
