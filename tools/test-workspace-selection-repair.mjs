import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const validations = fs.readFileSync('tools/run-validations.mjs', 'utf8');

function mustInclude(source, text, label = text) {
  assert.ok(source.includes(text), `${label} missing`);
}

mustInclude(app, 'function reconcileActiveLedgerSelection({ allowWhileLoading = false, reason = "workspace-reconcile" } = {})', 'workspace reconciliation accepts an explicit loading override');
mustInclude(app, 'const preferred = ledgers.find((ledger) => String(ledger.ledger_id || "") === String(getConfiguredLedgerId() || "")) || ledgers[0];', 'stale workspace repair prefers the configured primary workspace');
mustInclude(app, 'resultCode: "WORKSPACE_SELECTION_REPAIRED"', 'workspace repair records a Data I/O breadcrumb');
mustInclude(app, 'workspaceInviteStatus.loaded = true;\n    reconcileActiveLedgerSelection({ allowWhileLoading: true, reason });', 'workspace list refresh repairs stale active workspace before invite lookup');
mustInclude(app, 'if (activeWorkspaceLoadInProgress && String(activeWorkspaceLoadLedgerId || "") === String(previousLedgerId || ""))', 'stale loading lock is cleared when the unavailable workspace is replaced');
mustInclude(validations, 'node tools/test-workspace-selection-repair.mjs', 'workspace selection repair guardrail is included in validation');

console.log('Workspace selection repair guardrail passed.');
