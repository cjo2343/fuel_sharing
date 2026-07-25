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

export const markupExceptions = [
  {
    hex: '#74C69D',
    files: ['index.html'],
    reason:
      'Decorative hero-dot green in the landing <svg>, a step between --gv-mist #D8F3DC ' +
      'and --gv-leaf #52B788 that never got a token. The same value is also hard-coded in ' +
      'landing.css and content-pages.css, which this guard does not scan, so recolouring ' +
      'the markup copy on its own would leave the hero dot a different green from the CSS ' +
      'around it. Not a one-file fix: either the value earns a canonical token or all ' +
      'three copies move to --gv-leaf together, as one design decision. Out of scope for ' +
      'GV-371, which swaps a stale brand mark.',
    reviewBy: '2026-10-25',
  },
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
