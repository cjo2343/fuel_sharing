#!/usr/bin/env node
// Design-token drift guard (GV-216).
//
// The GoVehlo colour palette has ONE canonical source:
//   design_handoff_govehlo_v1/design-system/tokens/colors.css
// The two live products keep hand-maintained derived copies in their own idioms:
//   ../govehlo-web/govehlo-tokens.css     (--gv-* CSS custom properties)
//   ../govehlo-mobile/src/theme/colors.ts (camelCase TS object)
//
// A cross-repo review (WEB-1) found these had silently drifted — a colour missing
// on one side, a status hue off by a hex digit, warning mapped to amber. This guard
// re-parses all three, normalises the differing naming conventions to a common key,
// and fails if a derived copy is missing a canonical colour or gives it a different
// value. It runs as part of `npm run validate` (and therefore the pre-push hook) with
// the sibling repos checked out side-by-side, which is the authoring path where drift
// is introduced.
//
// fuel_sharing's own CI (.github/workflows/validate.yml) checks out this repo alone —
// the siblings are never present there, and each of govehlo-web/govehlo-mobile has its
// own isolated CI — so a missing sibling can't be treated as a hard failure by default;
// that would make `npm run validate` red in every CI run forever. Instead a missing
// sibling prints a loud warning (never a silent pass) and the script exits 0 unless
// --strict is passed, in which case a missing sibling is a failure too. --strict is for
// a future umbrella workflow that checks out all three repos side by side (GV-223); it
// is not used anywhere yet as of GV-256.
//
// Values that resolve to another token (`var(--color-...)` aliases) are canonical-only
// indirection and are not required in the derived copies, so they are skipped here.

import fs from 'node:fs';
import path from 'node:path';

const strict = process.argv.includes('--strict');

const root = process.cwd();
const CANONICAL = 'design_handoff_govehlo_v1/design-system/tokens/colors.css';
const DERIVED = [
  { label: 'govehlo-web', file: '../govehlo-web/govehlo-tokens.css', kind: 'css' },
  { label: 'govehlo-mobile', file: '../govehlo-mobile/src/theme/colors.ts', kind: 'ts' },
  // Vendored snapshot the mobile repo's own vitest guard (GV-221) checks colors.ts
  // against, so a mobile-only edit is caught in mobile CI without fuel_sharing present.
  // Checked here so the snapshot itself can't silently drift from canonical.
  { label: 'govehlo-mobile snapshot', file: '../govehlo-mobile/src/theme/__tests__/canonical-tokens.json', kind: 'json' },
];

// Collapse the three naming conventions onto one key:
//   --color-deep-forest / --gv-deep-forest / deepForest  ->  deepforest
//   --text-primary      / --gv-text-primary / textPrimary ->  textprimary
function normalise(name) {
  return name
    .replace(/^--/, '')
    .replace(/^(color|gv)-/, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;

// name -> hex, keeping only literal hex values (var()-aliases are skipped).
function parseCssHex(source) {
  const map = new Map();
  for (const m of source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const value = m[2].trim();
    if (HEX.test(value)) map.set(normalise(m[1]), value.toUpperCase());
  }
  return map;
}

function parseTsHex(source) {
  const map = new Map();
  for (const m of source.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:\s*['"](#[0-9a-fA-F]{3,8})['"]/g)) {
    map.set(normalise(m[1]), m[2].toUpperCase());
  }
  return map;
}

function parseJsonHex(source) {
  const map = new Map();
  for (const [key, value] of Object.entries(JSON.parse(source))) {
    if (typeof value === 'string' && HEX.test(value)) map.set(normalise(key), value.toUpperCase());
  }
  return map;
}

const canonicalPath = path.join(root, CANONICAL);
if (!fs.existsSync(canonicalPath)) {
  console.error(`check-token-drift: canonical token file not found at ${CANONICAL}`);
  process.exit(1);
}
const canonical = parseCssHex(fs.readFileSync(canonicalPath, 'utf8'));
if (canonical.size === 0) {
  console.error('check-token-drift: parsed zero canonical colours — parser or path is wrong.');
  process.exit(1);
}

let failed = false;
const checked = [];
const skipped = [];

for (const { label, file, kind } of DERIVED) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) {
    skipped.push(label);
    console.warn(`⚠ check-token-drift: ${label} not found at ${file} — token drift NOT checked for that repo.`);
    if (strict) failed = true;
    continue;
  }
  checked.push(label);
  const source = fs.readFileSync(abs, 'utf8');
  const derived = kind === 'ts' ? parseTsHex(source) : kind === 'json' ? parseJsonHex(source) : parseCssHex(source);

  const missing = [];
  const mismatched = [];
  for (const [key, canonHex] of canonical) {
    if (!derived.has(key)) {
      missing.push(key);
    } else if (derived.get(key) !== canonHex) {
      mismatched.push(`${key}: canonical ${canonHex} vs ${label} ${derived.get(key)}`);
    }
  }

  if (missing.length === 0 && mismatched.length === 0) {
    console.log(`check-token-drift: ${label} matches canonical (${canonical.size} colours).`);
    continue;
  }
  failed = true;
  console.error(`check-token-drift: ${label} has drifted from the canonical palette:`);
  for (const line of mismatched) console.error(`  - value drift: ${line}`);
  for (const key of missing) console.error(`  - missing colour: ${key} (defined in canonical, absent in ${label})`);
}

console.log(
  `check-token-drift: summary — checked: ${checked.length ? checked.join(', ') : 'none'}` +
  ` | skipped: ${skipped.length ? skipped.join(', ') : 'none'}.`
);

if (skipped.length > 0 && !strict) {
  console.warn(
    '⚠ check-token-drift: this run did NOT verify every derived copy — re-run with the missing ' +
    'sibling repo(s) checked out alongside fuel_sharing for a complete check (or pass --strict to fail loudly).'
  );
}

if (failed) {
  console.error(
    '\nDerived token copies must stay in sync with the canonical source:\n' +
    `  ${CANONICAL}\n` +
    'Update the derived copy (or the canonical file) so every canonical colour is present with the same value.' +
    (strict && skipped.length > 0
      ? '\n--strict also requires every sibling repo to be checked out; the skipped repo(s) above must be present too.'
      : '')
  );
  process.exit(1);
}

console.log('check-token-drift: OK.');
