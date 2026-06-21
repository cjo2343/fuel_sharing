import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const validations = fs.readFileSync('tools/run-validations.mjs', 'utf8');

function mustInclude(source, text, label = text) {
  assert.ok(source.includes(text), `${label} missing`);
}

mustInclude(app, 'function reconcileActiveLedgerSelection({ allowWhileLoading = false, reason = "workspace-reconcile", preferredLedgerId = "" } = {})', 'workspace reconciliation accepts loading override and preferred ledger');
mustInclude(app, 'function chooseWorkspaceFromMembership({ reason = "workspace-resolution", preferredLedgerId = "" } = {})', 'membership-based workspace resolver exists');
mustInclude(app, 'decision = "single-non-default-workspace"', 'resolver can prefer a non-owner user single non-default workspace');
mustInclude(app, 'updateWorkspaceResolutionDebug(decision, detail, { reason, preferredWorkspaceId: explicitPreferred, rejectedWorkspaceId });', 'workspace resolution decision is recorded for reports');
mustInclude(app, 'workspaceResolution: updateWorkspaceResolutionDebug', 'load report exports workspace resolution details');
mustInclude(app, 'workspaceInviteStatus.loaded = true;\n    reconcileActiveLedgerSelection({ allowWhileLoading: true, reason });', 'workspace list refresh resolves active workspace before invite lookup');
mustInclude(validations, 'node tools/test-workspace-selection-repair.mjs', 'workspace selection repair guardrail is included in validation');

console.log('Workspace selection repair guardrail passed.');
