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
//
// ── Second half: markup (GV-371) ──────────────────────────────────────────────
//
// Comparing declaration files to each other only proves the token *lists* agree. It
// says nothing about the markup that actually renders, and that is where the palette
// leaked: the /privatliv nav and the server-rendered /join/<code> page both inlined a
// pre-rebrand brand mark painted `fill="#FBBF24"` over `fill="#27AE60"` — two values
// that exist in no token file, on any side, so nothing here had anything to compare
// them with. They survived the GV-319 asset swap and sat live for months.
//
// So this guard now also walks govehlo-web's markup and fails on any hex in a colour
// attribute that is not a canonical token value. Off-palette values that are known and
// accepted live in tools/token-markup-allowlist.mjs with a written reason and a
// review-by date (the reviewed-exceptions pattern from GVM-437); they warn loudly on
// every run and the guard fails if one goes stale, expires, or was never needed.
// tools/lib/markup-hex-scan.mjs documents what the scanner treats as markup and why.

import fs from 'node:fs';
import path from 'node:path';

import { markupExceptions } from './token-markup-allowlist.mjs';
import {
  MARKUP_EXTENSIONS,
  SKIP_DIRS,
  normaliseHex,
  scanMarkupHexes,
} from './lib/markup-hex-scan.mjs';

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

// The markup scan is web-only: govehlo-mobile ships React Native, which has no markup
// attributes to paint — its colour literals are TS values, already covered by GV-221's
// vitest guard against the vendored snapshot above.
const MARKUP_REPO = { label: 'govehlo-web', dir: '../govehlo-web' };

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
let markupFailed = false;
let markupChecked = false;
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

// ── Markup scan (GV-371) ─────────────────────────────────────────────────────
//
// Canonical VALUES, not names: markup writes `fill="#52B788"`, never `--color-leaf`.
// Reusing the map the drift check already parsed is the point — one canonical set, so
// the two halves of this guard can never disagree about what the palette is.
const canonicalValues = new Set();
for (const hex of canonical.values()) {
  const normalised = normaliseHex(hex);
  if (normalised) canonicalValues.add(normalised);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = new Date().toISOString().slice(0, 10);

/** Every markup-bearing file under `dir`, as repo-relative paths. */
function walkMarkupFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // isDirectory() is false for symlinks, so a symlinked dir is never followed.
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkMarkupFiles(path.join(dir, entry.name), base, out);
    } else if (entry.isFile() && MARKUP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      // Forward slashes always, so allow-list paths read the same on every platform.
      out.push(path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * Validate the reviewed-exception list itself. An exception that is malformed,
 * expired, or excusing a colour that is canonical anyway is a failure — the list has
 * to stay something a reviewer can trust at a glance.
 */
function validateExceptions() {
  const problems = [];
  const seen = new Set();
  const entries = [];
  for (const [i, entry] of markupExceptions.entries()) {
    const where = `token-markup-allowlist.mjs entry ${i + 1}`;
    const hex = typeof entry.hex === 'string' ? normaliseHex(entry.hex) : null;
    if (!hex) {
      problems.push(`${where}: "hex" must be a hex colour, got ${JSON.stringify(entry.hex)}`);
      continue;
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0 || entry.files.some((f) => typeof f !== 'string')) {
      problems.push(`${where} (${hex}): "files" must be a non-empty array of repo-relative paths`);
      continue;
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 40) {
      problems.push(`${where} (${hex}): "reason" must explain the exception to a reviewer with no context`);
      continue;
    }
    if (typeof entry.reviewBy !== 'string' || !ISO_DATE.test(entry.reviewBy)) {
      problems.push(`${where} (${hex}): "reviewBy" must be a YYYY-MM-DD date`);
      continue;
    }
    if (entry.reviewBy < today) {
      problems.push(
        `${where} (${hex}): EXPIRED on ${entry.reviewBy} — re-make the judgement, then either ` +
        'move the value onto a token or write the reason afresh with a new reviewBy.'
      );
      continue;
    }
    if (canonicalValues.has(hex)) {
      problems.push(`${where} (${hex}): REDUNDANT — that value is canonical, so nothing is being excused. Delete it.`);
      continue;
    }
    for (const file of entry.files) {
      const key = `${hex} ${file}`;
      if (seen.has(key)) {
        problems.push(`${where} (${hex}): duplicate entry for ${file}`);
        continue;
      }
      seen.add(key);
    }
    entries.push({ ...entry, hex, used: new Set() });
  }
  return { entries, problems };
}

const webDir = path.join(root, MARKUP_REPO.dir);
if (!fs.existsSync(webDir)) {
  console.warn(
    `⚠ check-token-drift: ${MARKUP_REPO.label} not found at ${MARKUP_REPO.dir} — ` +
    'markup hex colours NOT checked.'
  );
  if (strict) failed = true;
} else {
  const { entries, problems } = validateExceptions();
  const files = walkMarkupFiles(webDir).sort();
  const violations = [];

  for (const file of files) {
    const source = fs.readFileSync(path.join(webDir, file), 'utf8');
    for (const finding of scanMarkupHexes(source)) {
      if (canonicalValues.has(finding.hex)) continue;
      const excuse = entries.find((e) => e.hex === finding.hex && e.files.includes(file));
      if (excuse) {
        excuse.used.add(file);
        continue;
      }
      violations.push({ file, ...finding });
    }
  }

  // A listed file that no longer contains the value has paid its debt — the entry must
  // go, or the list slowly becomes a wishlist nobody can audit.
  for (const entry of entries) {
    for (const file of entry.files) {
      if (entry.used.has(file)) continue;
      problems.push(
        `token-markup-allowlist.mjs (${entry.hex}): STALE — ${file} no longer uses that colour in markup. ` +
        'Remove the file from the entry (or the whole entry).'
      );
    }
  }

  for (const entry of entries) {
    if (entry.used.size === 0) continue;
    console.warn(
      `⚠ check-token-drift: allowing off-palette ${entry.hex} in ${[...entry.used].sort().join(', ')} ` +
      `(reviewed, expires ${entry.reviewBy}) — ${entry.reason}`
    );
  }

  if (violations.length > 0) {
    failed = true;
    markupFailed = true;
    console.error(
      `check-token-drift: ${MARKUP_REPO.label} markup paints colours that are not in the canonical palette:`
    );
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}: ${v.raw} — ${v.context}`);
    }
  }

  if (problems.length > 0) {
    failed = true;
    markupFailed = true;
    console.error('check-token-drift: the reviewed-exception list needs attention:');
    for (const problem of problems) console.error(`  - ${problem}`);
  }

  if (violations.length === 0 && problems.length === 0) {
    console.log(
      `check-token-drift: ${MARKUP_REPO.label} markup uses only canonical colours ` +
      `(${files.length} files scanned, ${entries.length} reviewed exceptions).`
    );
  }
  markupChecked = true;
}

console.log(
  `check-token-drift: summary — checked: ${checked.length ? checked.join(', ') : 'none'}` +
  ` | skipped: ${skipped.length ? skipped.join(', ') : 'none'}` +
  ` | markup: ${markupChecked ? `${MARKUP_REPO.label} scanned` : 'not scanned'}.`
);

if (skipped.length > 0 && !strict) {
  console.warn(
    '⚠ check-token-drift: this run did NOT verify every derived copy — re-run with the missing ' +
    'sibling repo(s) checked out alongside fuel_sharing for a complete check (or pass --strict to fail loudly).'
  );
}

if (failed) {
  console.error(
    `\nOne canonical source of colour:\n  ${CANONICAL}\n` +
    'Derived token copies must list every canonical colour with the same value; update the ' +
    'derived copy (or the canonical file) so they agree.' +
    (markupFailed
      ? '\nMarkup must paint only canonical values. Replace the hex with the token that means ' +
        'what you want (amber is money only; non-money status is --gv-attention), or — if it ' +
        'genuinely cannot be a token colour — add a reviewed entry to tools/token-markup-allowlist.mjs ' +
        'with a written reason and a review-by date.'
      : '') +
    (strict && skipped.length > 0
      ? '\n--strict also requires every sibling repo to be checked out; the skipped repo(s) above must be present too.'
      : '')
  );
  process.exit(1);
}

console.log('check-token-drift: OK.');
