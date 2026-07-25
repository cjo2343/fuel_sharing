// Pure, testable scanner for hex colours written directly into markup (GV-371).
//
// check-token-drift.mjs used to parse token *declarations* only. That is why
// `fill="#FBBF24"` over `fill="#27AE60"` — two hexes that exist nowhere in the design
// system — sat in the /privatliv nav and in the server-rendered /join/<code> page for
// months without tripping anything: neither value was ever declared as a token, so a
// declaration-only guard had nothing to compare. The palette is only as real as the
// markup that renders it, so the guard now also reads the markup.
//
// WHAT COUNTS AS MARKUP HERE
//
// The scanner anchors on colour-bearing markup *attributes* rather than on "a hex
// somewhere in this file". That single choice is what makes it both safe and portable:
//
//   - `fill="#27AE60"` is unambiguously a rendered colour, whether it sits in an .html
//     file or inside a template literal in a Cloudflare Function that emits HTML. Both
//     are scanned, because both ship markup to a browser — the stale brand mark lived
//     in one of each.
//   - `href="#dad"`, `url(#roadPath)` and `querySelector('#abc')` are not colours, and
//     never match, because they are not colour attributes. A "find every #rrggbb"
//     scanner would have to guess.
//
// WHAT IS DELIBERATELY OUT OF SCOPE
//
//   - CSS declarations, in .css files and in <style> blocks alike. Those are a
//     different surface with their own pre-existing debt (landing.css and
//     content-pages.css each carry off-palette values today), and folding them in
//     would make this guard's first version a mass recolouring. Named here so it is a
//     known boundary, not a blind spot.
//   - Bare hex strings in JavaScript (`const ok = '#1A7A47'`). Without an attribute to
//     anchor on, a 3-digit id selector is indistinguishable from a 3-digit colour, so
//     this would trade a real guard for false positives. (A JS variable named exactly
//     `fill`, `stroke` or `style` assigned a hex does match, because `fill = "#…"` is
//     shaped like the attribute. That is a painted colour by any reading, so it stays.)
//
// The scanner returns findings; deciding which ones are acceptable is the caller's job
// (check-token-drift.mjs compares them against the canonical palette and the reviewed
// exceptions in tools/token-markup-allowlist.mjs).

// Colour-bearing markup attributes: SVG presentation attributes, the HTML colour
// attributes, and `content` for <meta name="theme-color" content="#1A2E1F">.
export const COLOUR_ATTRS = [
  'fill',
  'stroke',
  'stop-color',
  'flood-color',
  'lighting-color',
  'color',
  'bgcolor',
  'bordercolor',
  'text',
  'link',
  'vlink',
  'alink',
  'content',
];

// `(?<![\w-])` keeps `data-text=` / `my-fill=` from matching `text=` / `fill=`.
//
// The value runs lazily to the NEXT MATCHING delimiter (`\2`), not to the next quote of
// either kind. That matters: an inline style routinely quotes a font stack with the
// other quote character — style="font-family:'Inter';color:#8AA396" — and a value
// pattern of [^"']* would stop dead at 'Inter' and never see the colour behind it.
const ATTR_VALUE = String.raw`\s*=\s*(["'])([\s\S]*?)\2`;
const COLOUR_ATTR_RE = new RegExp(
  String.raw`(?<![\w-])(${COLOUR_ATTRS.join('|')})${ATTR_VALUE}`,
  'gi',
);

// Inline styles carry colours through any property, so the whole value is scanned:
// style="color:#8AA396", style="background-color:#EDEFED", style="border:1px solid #ccc".
const STYLE_ATTR_RE = new RegExp(String.raw`(?<![\w-])(style)${ATTR_VALUE}`, 'gi');

const HEX_RE = /#[0-9a-fA-F]{3,8}/g;

// url(#gradientId) is an SVG paint reference, not a colour — and `url(#fade)` would
// otherwise read as a valid 4-digit hex.
const URL_REF_RE = /url\([^)]*\)/gi;

/** File extensions that can contain markup. .css is deliberately absent (see header). */
export const MARKUP_EXTENSIONS = new Set(['.html', '.htm', '.svg', '.js', '.mjs', '.cjs']);

/** Directories never worth walking: vendored, generated, or version-control internals. */
export const SKIP_DIRS = new Set([
  '.git',
  '.wrangler',
  '.claude',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
]);

/**
 * Normalise a hex literal to #RRGGBB, uppercase.
 *
 * #fff and #FFFFFF are the same colour, and an alpha suffix (#1A2E1FCC) modulates a
 * colour rather than changing which one it is — both resolve to their RGB triple so a
 * canonical value stays recognisable however it is written. Any other length is not a
 * CSS colour (7 hex digits, an id fragment that happens to be hex-ish) and returns
 * null, which the scanner treats as "not a colour" rather than as a violation.
 */
export function normaliseHex(raw) {
  const digits = String(raw).replace(/^#/, '');
  const expand = (s) => s.split('').map((c) => c + c).join('');
  let rgb;
  if (digits.length === 3) rgb = expand(digits);
  else if (digits.length === 4) rgb = expand(digits.slice(0, 3));
  else if (digits.length === 6) rgb = digits;
  else if (digits.length === 8) rgb = digits.slice(0, 6);
  else return null;
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) return null;
  return `#${rgb.toUpperCase()}`;
}

/**
 * Blank out HTML comments, preserving length and newlines so byte offsets — and
 * therefore reported line numbers — stay true to the original file.
 */
function blankComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Every hex colour written into a markup attribute in `source`.
 *
 * Returns [{ hex, raw, attribute, line, context }], ordered by position. `hex` is
 * normalised to #RRGGBB; `raw` is what the file actually says.
 */
export function scanMarkupHexes(source) {
  const text = blankComments(source);
  const findings = [];

  const collect = (attribute, value, valueStart) => {
    // Blank url(...) rather than dropping it, so offsets inside the value survive.
    const cleaned = value.replace(URL_REF_RE, (m) => ' '.repeat(m.length));
    for (const hit of cleaned.matchAll(HEX_RE)) {
      const hex = normaliseHex(hit[0]);
      if (!hex) continue;
      const index = valueStart + hit.index;
      findings.push({
        hex,
        raw: hit[0],
        attribute,
        line: lineOf(text, index),
        index,
        context: `${attribute}="${value.trim().slice(0, 60)}"`,
      });
    }
  };

  for (const re of [COLOUR_ATTR_RE, STYLE_ATTR_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const attribute = m[1].toLowerCase();
      const value = m[3];
      collect(attribute, value, m.index + m[0].length - value.length - 1);
    }
  }

  return findings.sort((a, b) => a.index - b.index);
}
