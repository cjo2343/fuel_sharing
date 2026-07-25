// Reviewed off-palette hex exceptions for the markup scan (GV-371).
//
// EVERY ENTRY HERE IS AN ACCEPTED PIECE OF COLOUR DEBT — NOT A SILENCED WARNING.
//
// `tools/check-token-drift.mjs` fails when a colour attribute in the web repo's
// markup (`fill=`, `stroke=`, `stop-color=`, `style="…: #…"`, …) carries a hex that
// is not a value in the canonical palette. Listing one here does NOT make it
// disappear: the guard still prints a warning naming the value, the file and the
// reason on every single run, so the exception stays in front of whoever reads the
// output. This mirrors the reviewed-exceptions pattern GVM-437 established for the
// mobile repo's dependency audit.
//
// The guard also refuses to let entries rot. It fails when:
//   - an entry is STALE     — a listed file no longer contains that hex in markup.
//                             The debt is paid; delete the entry (or the one file).
//   - an entry is EXPIRED   — `reviewBy` is in the past. Make the judgement again:
//                             either move the value onto a token, or write down
//                             afresh why it still stands and push `reviewBy` out.
//   - an entry is REDUNDANT — the hex is a canonical token value, so nothing was
//                             being excused. Delete it.
//   - an entry is MALFORMED — missing hex/files/reason/reviewBy, or a duplicate.
//
// So the only way an exception survives is that a human re-reads it every few
// months and consciously renews it.
//
// Entry shape (all fields required):
//   hex      — the off-palette value, as #RGB / #RGBA / #RRGGBB / #RRGGBBAA
//   files    — repo-relative paths inside govehlo-web, listed one by one on purpose;
//              a glob would quietly cover files nobody reviewed
//   reason   — why this is acceptable today; write it for a reviewer with no context,
//              and say what would change the answer
//   reviewBy — YYYY-MM-DD; the date this judgement must be re-made by

const EMAIL_TEMPLATES = [
  'email-templates/confirm-signup.html',
  'email-templates/magic-link.html',
  'email-templates/newsletter.html',
  'email-templates/reset-password.html',
];

// The transactional email templates are styled with inline `style="…"` attributes,
// because email clients strip <style> and have never supported CSS custom properties.
// Every colour in them is therefore a literal, and three of those literals are not in
// the canonical palette. GV-371 does not change them: they are a production surface
// this ticket does not touch, each value appears in several templates at once, and
// picking a replacement is a design call about how the email set should look, not a
// find-and-replace. Recorded here so they are visible on every run instead of invisible.
const EMAIL_SURFACE =
  'Off-palette literal in the transactional email set. Email clients strip <style> and ' +
  'do not support CSS custom properties, so these templates carry literal hexes with no ' +
  'token to reference; this value is one of three neutrals in that set that never came ' +
  'from the canonical palette. Left alone by GV-371 (a brand-mark swap): it is a live ' +
  'email surface, the value has to move in every template at once, and choosing what it ' +
  'becomes is a design decision about the email set. Delete this entry when the email ' +
  'templates are next reworked onto palette values.';

// GV-374 settled the one non-email entry this list used to carry, #74C69D — a green
// from the ramp the palette was built from that never became a token. Its own entry
// assumed the landing.css / content-pages.css copies of that hex were the hero dot's
// surroundings; they were not, they were the :focus-visible ring, an unrelated element.
// Two elements, two decisions: the dot took --gv-light-leaf #7EE0AB (the token for leaf
// on a dark surface, and that hero sits on --gv-deep-forest), the ring took --gv-leaf,
// which also has to work on the light sections. With the debt paid the entry is deleted
// rather than renewed, which is the only ending an entry here is supposed to have.
// What is left is the email set, and only until those templates are next reworked.

export const markupExceptions = [
  {
    hex: '#EDEFED',
    files: EMAIL_TEMPLATES,
    reason: `${EMAIL_SURFACE} Used as the page background behind the white email card.`,
    reviewBy: '2026-10-25',
  },
  {
    hex: '#8AA396',
    files: EMAIL_TEMPLATES,
    reason: `${EMAIL_SURFACE} Used for the muted footer and link-expiry lines.`,
    reviewBy: '2026-10-25',
  },
  {
    hex: '#F1F8F3',
    files: ['email-templates/newsletter.html'],
    reason:
      `${EMAIL_SURFACE} Used as the tint fill behind the newsletter story cards, paired ` +
      'with the canonical --gv-border #E2EDE8; of the three it is the one with an obvious ' +
      'palette replacement (--gv-warm-white #F7F9F8), so start here.',
    reviewBy: '2026-10-25',
  },
];
