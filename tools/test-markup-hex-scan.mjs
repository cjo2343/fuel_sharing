// Unit test for the markup hex scanner behind check-token-drift's second half (GV-371).
//
// The guard it feeds is only worth having if it fails on the thing it was written for
// and stays quiet on everything else, so both directions are asserted here: the exact
// leak that went unnoticed for months (`fill="#FBBF24"` on a brand mark), and the
// look-alikes a naive "find every #rrggbb" scanner would trip over — url(#ref)
// paint references, `#dad`-style anchors, id selectors in scripts, and CSS
// declarations, which are a different surface (see tools/lib/markup-hex-scan.mjs).

import assert from 'node:assert/strict';

import { normaliseHex, scanMarkupHexes } from './lib/markup-hex-scan.mjs';

const hexes = (source) => scanMarkupHexes(source).map((f) => f.hex);

// ── The leak this exists for ────────────────────────────────────────────────
{
  const stale = `
    <a href="/" class="policy-brand">
      <svg width="28" height="28" viewBox="0 0 512 512" aria-hidden="true">
        <rect width="512" height="512" rx="112" fill="#27AE60"/>
        <circle cx="259" cy="253" r="26" fill="#FBBF24"/>
      </svg>
    </a>`;
  const found = scanMarkupHexes(stale);
  assert.deepEqual(found.map((f) => f.hex), ['#27AE60', '#FBBF24']);
  assert.deepEqual(found.map((f) => f.line), [4, 5]);
  assert.equal(found[1].attribute, 'fill');
  assert.equal(found[1].raw, '#FBBF24');
}

// The same markup inside a JS template literal — how the /join/<code> Cloudflare
// Function shipped it — must read identically.
{
  const fn = 'const BRAND_MARK = `<rect fill="#27AE60"/><circle fill="#FBBF24"/>`;';
  assert.deepEqual(hexes(fn), ['#27AE60', '#FBBF24']);
}

// ── Every colour-bearing form the ticket names ──────────────────────────────
assert.deepEqual(hexes('<path stroke="#52B788"/>'), ['#52B788']);
assert.deepEqual(hexes('<stop stop-color="#D8F3DC" offset="0"/>'), ['#D8F3DC']);
assert.deepEqual(hexes('<feFlood flood-color="#1A2E1F"/>'), ['#1A2E1F']);
assert.deepEqual(hexes('<meta name="theme-color" content="#1A2E1F">'), ['#1A2E1F']);
assert.deepEqual(hexes('<td bgcolor="#F7F9F8">x</td>'), ['#F7F9F8']);
assert.deepEqual(hexes('<p style="color:#8AA396;">x</p>'), ['#8AA396']);
assert.deepEqual(hexes('<div style="border:1px solid #E2EDE8;background:#FFF">x</div>'), ['#E2EDE8', '#FFFFFF']);
assert.deepEqual(hexes("<svg fill='#2D6A4F'/>"), ['#2D6A4F']);

// An inline style quoting a font stack with the other quote character must not cut the
// value short — that bug hid every colour behind a font-family in the email templates.
assert.deepEqual(
  hexes(`<p style="font-family:'Inter',Arial,sans-serif;font-size:13px;color:#8AA396;">x</p>`),
  ['#8AA396'],
);

// ── Things that look like colours and are not ───────────────────────────────
assert.deepEqual(hexes('<path fill="url(#roadPath)" stroke="url(#fade)"/>'), []);
assert.deepEqual(hexes('<a href="#dad">Til FAQ</a><a href="#c0ffee">x</a>'), []);
assert.deepEqual(hexes('<div id="abc" class="dad"></div>'), []);
assert.deepEqual(hexes('<span data-fill="#FBBF24" my-stroke="#27AE60">x</span>'), []);
assert.deepEqual(hexes('<script>document.querySelector("#abc").style.x = 1;</script>'), []);
// CSS declarations are a separate surface, deliberately not scanned.
assert.deepEqual(hexes('<style>:root { --deep-forest: #1A2E1F; } .a { color: #7A3A1E; }</style>'), []);
// Comments are blanked, and blanking preserves the line numbering after them.
{
  const commented = '<!--\n  <rect fill="#FBBF24"/>\n-->\n<rect fill="#27AE60"/>';
  const found = scanMarkupHexes(commented);
  assert.deepEqual(found.map((f) => f.hex), ['#27AE60']);
  assert.equal(found[0].line, 4);
}

// ── Normalisation: same colour however it is written ────────────────────────
assert.equal(normaliseHex('#fff'), '#FFFFFF');
assert.equal(normaliseHex('#52b788'), '#52B788');
assert.equal(normaliseHex('#1A2E1FCC'), '#1A2E1F');   // alpha modulates, it does not recolour
assert.equal(normaliseHex('#fff8'), '#FFFFFF');
assert.equal(normaliseHex('#12345'), null);           // not a CSS colour length
assert.equal(normaliseHex('#1234567'), null);
assert.deepEqual(hexes('<rect fill="#FFF"/><rect fill="#ffffff"/>'), ['#FFFFFF', '#FFFFFF']);
// A 5- or 7-digit run is not a colour, so it is not a finding either.
assert.deepEqual(hexes('<rect fill="#12345"/>'), []);

console.log('ok - markup hex scanner catches painted colours and ignores anchors, url() refs and CSS');
