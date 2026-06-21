import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');

const checks = [
  {
    name: 'admin diagnostics reason helper exists',
    ok: /function\s+isAdminDiagnosticsLoadReason\s*\(/.test(app)
      && app.includes('reason === "manual-admin"')
      && app.includes('reason === "admin-diagnostics"')
      && app.includes('/^admin-/.test')
  },
  {
    name: 'admin diagnostics has Render state-load fast path',
    ok: /async\s+function\s+tryRenderAdminDiagnosticsStateLoad\s*\(/.test(app)
      && app.includes('await loadStateFromNormalizedTables(jsonFallbackState || state, { reason: `admin-diagnostics:${reason}`, stateScope: adminStateScope })')
      && app.includes('recordSupabaseLoadEvent("render-admin-diagnostics-load", reason)')
      && app.includes('recordSyncDiagnostic("admin-render-load-success"')
  },
  {
    name: 'admin fast path runs before legacy JSON mirror load',
    ok: app.indexOf('await tryRenderAdminDiagnosticsStateLoad(reason, loadToken, state)') > -1
      && app.indexOf('await tryRenderAdminDiagnosticsStateLoad(reason, loadToken, state)') < app.indexOf('.from("car_share_ledgers")')
  },
  {
    name: 'fast path preserves stale load guard and fallback diagnostics',
    ok: app.includes('if (!isCurrentSupabaseLoad(loadToken))')
      && app.includes('admin-render-load-fallback')
      && app.includes('setSyncStatus("Tables")')
  }
];

const failed = checks.filter((check) => !check.ok);
if (failed.length) {
  console.error('Render admin diagnostics load guard failed:');
  failed.forEach((check) => console.error(`- ${check.name}`));
  process.exit(1);
}

console.log('Render admin diagnostics load guard check passed.');
