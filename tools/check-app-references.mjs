#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const appPath = process.argv[2] || path.join(process.cwd(), 'app.js');
const source = fs.readFileSync(appPath, 'utf8');
const extraSourcePaths = [
  'utils.js',
  'supabase-helpers.js',
  'ledger-model.js',
  'data-store.js',
  'settlement-calculations.js',
  'ui-messages.js',
  'sync-status-helpers.js',
  'location-privacy-helpers.js',
  'period-closing-helpers.js',
  'stress-test-helpers.js',
  'security-health-helpers.js',
  'audit-log.js',
  'notifications.js',
  'admin-tools.js',
  'permission-helpers.js',
  'build-info.js'
]
  .map((name) => path.join(process.cwd(), name))
  .filter((candidate) => candidate !== appPath && fs.existsSync(candidate));
const declarationSource = [source, ...extraSourcePaths.map((candidate) => fs.readFileSync(candidate, 'utf8'))].join('\n');

const requiredRuntimeFiles = [
  'supabase-config.js',
  'utils.js',
  'supabase-helpers.js',
  'ledger-model.js',
  'data-store.js',
  'settlement-calculations.js',
  'ui-messages.js',
  'sync-status-helpers.js',
  'location-privacy-helpers.js',
  'period-closing-helpers.js',
  'stress-test-helpers.js',
  'security-health-helpers.js',
  'audit-log.js',
  'notifications.js',
  'admin-tools.js',
  'permission-helpers.js',
  'build-info.js',
  'booking-calendar.js',
  'app.js'
];

function assertRuntimeFilesLoadedAndCached() {
  const indexPath = path.join(process.cwd(), 'index.html');
  const serviceWorkerPath = path.join(process.cwd(), 'service-worker.js');
  if (!fs.existsSync(indexPath) || !fs.existsSync(serviceWorkerPath)) return;

  const indexSource = fs.readFileSync(indexPath, 'utf8');
  const serviceWorkerSource = fs.readFileSync(serviceWorkerPath, 'utf8');
  const scripts = [...indexSource.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1].replace(/^\//, ''))
    .filter((src) => !/^https?:\/\//i.test(src));

  const missingScripts = requiredRuntimeFiles.filter((file) => !scripts.includes(file));
  if (missingScripts.length) {
    console.error('Runtime module guard failed: index.html is missing required script(s):');
    for (const file of missingScripts) console.error(`- ${file}`);
    process.exit(1);
  }

  let previousIndex = -1;
  for (const file of requiredRuntimeFiles) {
    const currentIndex = scripts.indexOf(file);
    if (currentIndex < previousIndex) {
      console.error('Runtime module guard failed: index.html loads runtime scripts in the wrong order.');
      console.error(`Expected order: ${requiredRuntimeFiles.join(' -> ')}`);
      console.error(`Actual local order: ${scripts.join(' -> ')}`);
      process.exit(1);
    }
    previousIndex = currentIndex;
  }

  const cacheAssetPattern = /["']\/?([^"']+\.(?:js|css|html|json|png))["']/g;
  const cachedAssets = new Set([...serviceWorkerSource.matchAll(cacheAssetPattern)].map((match) => match[1].replace(/^\//, '')));
  const requiredCachedAssets = [
    'index.html',
    'styles.css',
    ...requiredRuntimeFiles,
    'manifest.json',
    'icon-192.png',
    'icon-512.png'
  ];
  const missingCachedAssets = requiredCachedAssets.filter((file) => !cachedAssets.has(file));
  if (missingCachedAssets.length) {
    console.error('Runtime module guard failed: service-worker.js CORE_ASSETS is missing required file(s):');
    for (const file of missingCachedAssets) console.error(`- ${file}`);
    process.exit(1);
  }
}

assertRuntimeFilesLoadedAndCached();

function stripCommentsAndStringText(input) {
  let out = '';
  let i = 0;
  const templateStack = [];
  let state = 'code';
  let quote = '';
  let braceDepth = 0;

  while (i < input.length) {
    const c = input[i];
    const n = input[i + 1];

    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'") { state = 'string'; quote = c; out += ' '; i++; continue; }
      if (c === '`') { state = 'template'; out += ' '; i++; continue; }
      if (templateStack.length && c === '{') { braceDepth++; out += c; i++; continue; }
      if (templateStack.length && c === '}') {
        braceDepth--;
        out += c;
        i++;
        if (braceDepth <= 0) { templateStack.pop(); state = 'template'; braceDepth = templateStack.at(-1) || 0; }
        continue;
      }
      out += c; i++; continue;
    }

    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; } else { out += ' '; }
      i++; continue;
    }

    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; }
      else { out += c === '\n' ? '\n' : ' '; i++; }
      continue;
    }

    if (state === 'string') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) { state = 'code'; quote = ''; out += ' '; i++; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }

    if (state === 'template') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') { state = 'code'; out += ' '; i++; continue; }
      if (c === '$' && n === '{') {
        templateStack.push(1);
        braceDepth = 1;
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
  }
  return out;
}

const code = stripCommentsAndStringText(source);

function extractFunctionBody(input, functionName) {
  const marker = new RegExp(`\\b(?:async\\s+)?function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`);
  const match = marker.exec(input);
  if (!match) return null;
  let i = match.index + match[0].length;
  let depth = 1;
  let state = 'code';
  let quote = '';
  while (i < input.length) {
    const c = input[i];
    const n = input[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === '"' || c === "'") { state = 'string'; quote = c; i++; continue; }
      if (c === '`') { state = 'template'; i++; continue; }
      if (c === '{') depth++;
      if (c === '}') {
        depth--;
        if (depth === 0) return input.slice(match.index, i + 1);
      }
      i++;
      continue;
    }
    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i += 2; } else i++; continue; }
    if (state === 'string') { if (c === '\\') { i += 2; continue; } if (c === quote) state = 'code'; i++; continue; }
    if (state === 'template') { if (c === '\\') { i += 2; continue; } if (c === '`') state = 'code'; i++; continue; }
  }
  return null;
}

const normalizedSyncBody = extractFunctionBody(source, 'syncNormalizedTablesFromJson');
if (normalizedSyncBody && /\bcontext\s*\./.test(stripCommentsAndStringText(normalizedSyncBody))) {
  console.error('Regression guard failed: syncNormalizedTablesFromJson() contains a bare context.* reference. Resolve the write context inside the function or pass it explicitly.');
  process.exit(1);
}

function assertNoBareIdentifierReference(functionName, identifier, message) {
  const body = extractFunctionBody(source, functionName);
  if (!body) return;
  const stripped = stripCommentsAndStringText(body);
  // Matches identifier as a standalone token, but ignores property access like
  // context.currentMemberId and declarations like const currentMemberId = ...
  const pattern = new RegExp(`(?<![.$])\\b${identifier}\\b(?!\\s*[=:])`);
  if (pattern.test(stripped)) {
    console.error(message);
    process.exit(1);
  }
}

assertNoBareIdentifierReference(
  'saveTripToNormalizedTablesFirst',
  'currentMemberId',
  'Regression guard failed: saveTripToNormalizedTablesFirst() contains a bare currentMemberId reference. Use context.currentMemberId from getNormalizedWriteContext().'
);
assertNoBareIdentifierReference(
  'saveFuelToNormalizedTablesFirst',
  'currentMemberId',
  'Regression guard failed: saveFuelToNormalizedTablesFirst() contains a bare currentMemberId reference. Use context.currentMemberId from getNormalizedWriteContext().'
);

const tripRpcBody = extractFunctionBody(source, 'saveTripWithParticipantsRpc') || '';
const tripRenderCallIndex = tripRpcBody.indexOf('saveTripWithParticipantsViaRender');
const tripFallbackBlockIndex = tripRpcBody.indexOf('Browser trip Supabase RPC/table fallback is disabled');
const tripDirectRpcIndex = tripRpcBody.indexOf('supabaseClient.rpc("upsert_trip_with_participants"');
if (tripRenderCallIndex < 0 || tripFallbackBlockIndex < 0 || tripDirectRpcIndex >= 0 || tripRenderCallIndex > tripFallbackBlockIndex) {
  console.error('Regression guard failed: trip saves must attempt the Render /api/trips/upsert path and fail closed instead of using browser Supabase RPC fallback.');
  process.exit(1);
}

const tripRenderBody = extractFunctionBody(source, 'saveTripWithParticipantsViaRender') || '';
if (!tripRenderBody.includes('Promise.race([fetchPromise, timeoutPromise])')) {
  console.error('Regression guard failed: trip Render saves must use Promise.race so the frontend cannot hang forever waiting for fetch/abort cleanup.');
  process.exit(1);
}
if (!tripRenderBody.includes('finishTripRenderDiagnostic("success"') || !tripRenderBody.includes('finishTripRenderDiagnostic(timedOut ? "timeout" : "exception"')) {
  console.error('Regression guard failed: trip Render saves must always record a matched finish diagnostic for success, timeout, and exception paths.');
  process.exit(1);
}

const tripSaveFirstBody = extractFunctionBody(source, 'saveTripToNormalizedTablesFirst') || '';
const tripTableWriteIndex = tripSaveFirstBody.indexOf('recordSupabaseLoadEvent("trip-table-write"');
const tripRpcResultOkIndex = tripSaveFirstBody.indexOf('if (rpcResult.ok)');
if (tripTableWriteIndex < 0 || tripRpcResultOkIndex < 0 || tripTableWriteIndex < tripRpcResultOkIndex) {
  console.error('Regression guard failed: trip-table-write must only be recorded after the backend/normalized trip save succeeds.');
  process.exit(1);
}
const tripSaveFinallyIndex = tripSaveFirstBody.lastIndexOf('} finally {');
const tripSaveFinishIndex = tripSaveFirstBody.indexOf('finishForegroundOperationsBySource("trip-save"', Math.max(0, tripSaveFinallyIndex));
if (tripSaveFinallyIndex < 0 || tripSaveFinishIndex < 0) {
  console.error('Regression guard failed: saveTripToNormalizedTablesFirst() must clear the foreground trip-save operation from its finally block on success, failure, or early exit.');
  process.exit(1);
}
if (tripSaveFirstBody.includes('if (!savedThroughNormalizedTables)') && tripSaveFirstBody.indexOf('finishForegroundOperationsBySource("trip-save"') > tripSaveFirstBody.indexOf('if (!savedThroughNormalizedTables)')) {
  console.error('Regression guard failed: trip foreground cleanup must not be restricted to failure-only paths.');
  process.exit(1);
}


const fuelRpcBody = extractFunctionBody(source, 'saveFuelPaymentRpc') || '';
const fuelRenderCallIndex = fuelRpcBody.indexOf('saveFuelPaymentViaRender');
const fuelFallbackBlockIndex = fuelRpcBody.indexOf('Browser fuel Supabase RPC/table fallback is disabled');
const fuelDirectRpcIndex = fuelRpcBody.indexOf('supabaseClient.rpc("upsert_fuel_payment"');
if (fuelRenderCallIndex < 0 || fuelFallbackBlockIndex < 0 || fuelDirectRpcIndex >= 0 || fuelRenderCallIndex > fuelFallbackBlockIndex) {
  console.error('Regression guard failed: fuel saves must attempt the Render /api/fuel/upsert path and fail closed instead of using browser Supabase RPC fallback.');
  process.exit(1);
}

const fuelRenderBody = extractFunctionBody(source, 'saveFuelPaymentViaRender') || '';
if (!fuelRenderBody.includes('Promise.race([fetchPromise, timeoutPromise])')) {
  console.error('Regression guard failed: fuel Render saves must use Promise.race so the frontend cannot hang forever waiting for fetch/abort cleanup.');
  process.exit(1);
}
if (!fuelRenderBody.includes('finishFuelRenderDiagnostic("success"') || !fuelRenderBody.includes('finishFuelRenderDiagnostic(timedOut ? "timeout" : "exception"')) {
  console.error('Regression guard failed: fuel Render saves must always record a matched finish diagnostic for success, timeout, and exception paths.');
  process.exit(1);
}

const fuelSaveFirstBody = extractFunctionBody(source, 'saveFuelToNormalizedTablesFirst') || '';
const fuelTableWriteIndex = fuelSaveFirstBody.indexOf('recordSupabaseLoadEvent("fuel-table-write"');
const fuelSavedIndex = fuelSaveFirstBody.indexOf('savedThroughNormalizedTables = true');
if (fuelTableWriteIndex < 0 || fuelSavedIndex < 0 || fuelTableWriteIndex < fuelSavedIndex) {
  console.error('Regression guard failed: fuel-table-write must only be recorded after the backend/normalized fuel save succeeds.');
  process.exit(1);
}
const fuelSaveFinallyIndex = fuelSaveFirstBody.lastIndexOf('} finally {');
const fuelSaveFinishIndex = fuelSaveFirstBody.indexOf('finishForegroundOperationsBySource("fuel-save"', Math.max(0, fuelSaveFinallyIndex));
if (fuelSaveFinallyIndex < 0 || fuelSaveFinishIndex < 0) {
  console.error('Regression guard failed: saveFuelToNormalizedTablesFirst() must clear the foreground fuel-save operation from its finally block on success, failure, or early exit.');
  process.exit(1);
}
if (fuelSaveFirstBody.includes('recordDataIoDiagnostic("start", { source: "fuel-save", route: "supabase-rpc"')) {
  console.error('Regression guard failed: fuel saves must not create an unpaired manual supabase-rpc start diagnostic before the backend save runs.');
  process.exit(1);
}

const generatedTripBody = extractFunctionBody(source, 'addGeneratedTestTrip') || '';
if (!generatedTripBody.includes('createGeneratedTestDataViaRender("trip", tripPayload)') || generatedTripBody.includes('saveTripToNormalizedTablesFirst(tripPayload)') || generatedTripBody.includes('markNormalizedReconciliationDirty(') || generatedTripBody.includes('saveState();')) {
  console.error('Regression guard failed: addGeneratedTestTrip() must use the Render admin test-data route and must not fall back to browser trip writes or local-only dirty reconciliation.');
  process.exit(1);
}

const generatedFuelBody = extractFunctionBody(source, 'addGeneratedTestFuel') || '';
if (!generatedFuelBody.includes('createGeneratedTestDataViaRender("fuel", fuelPayload)') || generatedFuelBody.includes('saveFuelToNormalizedTablesFirst(fuelPayload)') || generatedFuelBody.includes('markNormalizedReconciliationDirty(') || generatedFuelBody.includes('saveState();')) {
  console.error('Regression guard failed: addGeneratedTestFuel() must use the Render admin test-data route and must not fall back to browser fuel writes or local-only dirty reconciliation.');
  process.exit(1);
}

const generatedPersistBody = extractFunctionBody(source, 'persistGeneratedTestDataLocallyAndToCloud') || '';
if (!generatedPersistBody.includes('writeLocalState()') || !generatedPersistBody.includes('saveJsonMirrorBackup({ force: true, reason })')) {
  console.error('Regression guard failed: generated test-data persistence must write local state and then save through the Render JSON mirror backup without waking the generic full-state save path.');
  process.exit(1);
}


function getFunctionParameters(signature) {
  const paramsMatch = signature.match(/\(([^)]*)\)/);
  if (!paramsMatch) return [];
  return paramsMatch[1]
    .split(',')
    .map((parameter) => parameter.trim().match(/^([A-Za-z_$][\w$]*)/))
    .filter(Boolean)
    .map((match) => match[1]);
}

function getFunctionInnerBody(functionBody) {
  const start = functionBody.indexOf('{');
  return start >= 0 ? functionBody.slice(start + 1, -1) : functionBody;
}

function collectLocalIdentifiers(functionBody) {
  const stripped = stripCommentsAndStringText(functionBody);
  const locals = new Set();
  const signature = stripped.slice(0, stripped.indexOf('{') + 1);
  for (const parameter of getFunctionParameters(signature)) locals.add(parameter);

  const inner = getFunctionInnerBody(stripped);
  for (const match of inner.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g)) locals.add(match[1]);
  for (const match of inner.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) locals.add(match[1]);
  for (const match of inner.matchAll(/\(([A-Za-z_$][\w$]*)\)\s*=>/g)) locals.add(match[1]);
  for (const match of inner.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) {
    const before = inner.slice(Math.max(0, (match.index || 0) - 12), match.index || 0);
    if (!/(function|return|typeof|new)\s*$/.test(before)) locals.add(match[1]);
  }
  return locals;
}

function assertNoLikelyUndeclaredIdentifiers(functionName, extraAllowed = []) {
  const body = extractFunctionBody(source, functionName);
  if (!body) return;
  const stripped = stripCommentsAndStringText(body);
  const inner = getFunctionInnerBody(stripped);
  const locals = collectLocalIdentifiers(body);
  const allowedHere = new Set([...allowed, ...declared, ...locals, ...extraAllowed]);
  const missing = new Map();

  for (const match of inner.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const name = match[0];
    const index = match.index || 0;
    if (keywords.has(name) || allowedHere.has(name)) continue;

    const prev = inner[index - 1] || '';
    if (prev === '.' || prev === '#' || prev === '$') continue;

    const before = inner.slice(Math.max(0, index - 16), index);
    const after = inner.slice(index + name.length);
    if (/\b(?:const|let|var|function|class)\s*$/.test(before)) continue;
    if (/^\s*:/.test(after)) continue; // object literal key or label
    if (/^\s*=>/.test(after)) continue; // arrow function parameter already collected above

    const line = stripped.slice(0, stripped.indexOf(match[0], match.index)).split('\n').length;
    if (!missing.has(name)) missing.set(name, []);
    missing.get(name).push(line);
  }

  if (missing.size) {
    console.error(`Regression guard failed: ${functionName}() contains likely undeclared identifier reference(s):`);
    for (const [name, lines] of [...missing.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const shown = [...new Set(lines)].slice(0, 6).join(', ');
      console.error(`- ${name} at line(s): ${shown}${lines.length > 6 ? ', ...' : ''}`);
    }
    console.error('Declare the identifier inside the function, pass it as a parameter, or add it to the explicit allowlist if it is an intentional global.');
    process.exit(1);
  }
}

const declared = new Set();

function addSourceMatches(regex, group = 1) {
  for (const match of declarationSource.matchAll(regex)) declared.add(match[group]);
}

addSourceMatches(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g);
addSourceMatches(/\basync\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g);
addSourceMatches(/\bclass\s+([A-Za-z_$][\w$]*)\b/g);
addSourceMatches(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g);
addSourceMatches(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g);
addSourceMatches(/\bglobalThis\.([A-Za-z_$][\w$]*)\s*=/g);

for (const match of declarationSource.matchAll(/\b(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
  for (const parameter of match[1].split(',')) {
    const name = parameter.trim().match(/^([A-Za-z_$][\w$]*)/);
    if (name) declared.add(name[1]);
  }
}

const allowed = new Set([
  'Array','Boolean','Date','Error','EvalError','Function','JSON','Map','Math','Number','Object','Promise','RangeError','ReferenceError','RegExp','Set','String','SyntaxError','TypeError','URL','URLSearchParams','WeakMap','WeakSet','parseFloat','parseInt','isFinite','isNaN','decodeURIComponent','encodeURIComponent','clearInterval','clearTimeout','setInterval','setTimeout','queueMicrotask','structuredClone',
  'AbortController','alert','atob','btoa','confirm','fetch','localStorage','navigator','open','prompt','requestAnimationFrame','scrollTo','sessionStorage','document','window','Blob','File','FileReader','FormData','Headers','Notification','Response','Request','CustomEvent','Event','KeyboardEvent','MouseEvent','crypto',
  'Uint8Array','console','supabase','createClient','Trips','logs','PushManager','ServiceWorkerRegistration','TextDecoder','TextEncoder','resolve','reject'
]);

const keywords = new Set(['if','for','while','switch','catch','function','return','typeof','void','delete','new','class','do','else','try','finally','await','async','in','of','throw','case','const','let','var','true','false','null','undefined','continue','break','default']);

assertNoLikelyUndeclaredIdentifiers('saveTripToNormalizedTablesFirst');
assertNoLikelyUndeclaredIdentifiers('saveFuelToNormalizedTablesFirst');
assertNoLikelyUndeclaredIdentifiers('syncNormalizedTablesFromJson');
const usedCalls = new Map();
const callRegex = /([A-Za-z_$][\w$]*)\s*\(/g;
for (const match of code.matchAll(callRegex)) {
  const name = match[1];
  const index = match.index || 0;
  const before = code.slice(Math.max(0, index - 20), index);
  const prev = code[index - 1] || '';
  if (prev === '.' || prev === '?' || prev === ':' || prev === '#' || /[\w$]/.test(prev)) continue;
  if (keywords.has(name) || allowed.has(name) || declared.has(name)) continue;
  if (/\b(function|class)\s+$/.test(before)) continue;
  const line = code.slice(0, index).split('\n').length;
  if (!usedCalls.has(name)) usedCalls.set(name, []);
  usedCalls.get(name).push(line);
}

const missing = [...usedCalls.entries()].sort(([a], [b]) => a.localeCompare(b));
if (missing.length) {
  console.error('Potential undefined function calls found in app.js:');
  for (const [name, lines] of missing) {
    const shown = [...new Set(lines)].slice(0, 8).join(', ');
    console.error(`- ${name}() at line(s): ${shown}${lines.length > 8 ? ', ...' : ''}`);
  }
  console.error('\nIf a name is an intentional browser/CDN global, add it to the allowlist in tools/check-app-references.mjs.');
  process.exit(1);
}

console.log('check-app-references: no obvious undefined function calls found.');
