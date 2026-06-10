#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const appPath = process.argv[2] || path.join(process.cwd(), 'app.js');
const source = fs.readFileSync(appPath, 'utf8');
const extraSourcePaths = ['utils.js', 'supabase-helpers.js', 'data-store.js', 'settlement-calculations.js', 'ui-messages.js', 'notifications.js', 'admin-tools.js']
  .map((name) => path.join(process.cwd(), name))
  .filter((candidate) => candidate !== appPath && fs.existsSync(candidate));
const declarationSource = [source, ...extraSourcePaths.map((candidate) => fs.readFileSync(candidate, 'utf8'))].join('\n');

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
  'alert','atob','btoa','confirm','fetch','localStorage','navigator','open','prompt','requestAnimationFrame','scrollTo','sessionStorage','document','window','Blob','File','FileReader','FormData','Headers','Notification','Response','Request','CustomEvent','Event','KeyboardEvent','MouseEvent','crypto',
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
