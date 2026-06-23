# Plan: remove the "Who and shortcuts" booking card (book for the signed-in user)

Decision (user): remove the whole card; bookings auto-attribute to the logged-in
person. Book-on-behalf-of-another-member is intentionally dropped.

## What's there
`#bookingPanel` "Who and shortcuts" (index.html ~166-194) contains `<form id="bookingForm">`
with: the **Driver** select `#bookingMember` (required) + the quick-action buttons
(When: Today/Tomorrow/Weekend `data-booking-day|weekend`; Length: +1h/+2h/+4h/All day
`data-booking-duration-hours|all-day`).

**Trap:** the actual booking inputs `#bookingStart` / `#bookingEnd` / `#bookingPurpose`
/ `#bookingSubmit` live in the *Current workspace bookings* calendar card (index.html
~240-254) and are bound to this form via `form="bookingForm"`. So the
`<form id="bookingForm">` element must NOT be deleted, or those inputs are orphaned.

## Changes (Sonnet)
1. **Remove the visible card UI:** the eyebrow/heading "Who and shortcuts", the Driver
   `<label>`, and the `.booking-quick-actions` block.
2. **Keep the form + a hidden driver field.** Preserve `<form id="bookingForm">` in the
   DOM and keep `#bookingMember` as a **hidden input** (or `<select hidden>`), always
   set to the signed-in user. The form can either stay as a minimal element where the
   panel was, or be folded into the calendar card; keep the `form="bookingForm"`
   bindings intact. Lowest-risk path: minimal hidden form, no JS read changes.
3. **Pin the driver to the signed-in user.** The populate logic already does
   `els.bookingMember.value = currentUser` (app.js ~10949) with a `lockToLoggedInUser`
   branch (~10965); simplify it so `#bookingMember` always holds `currentUser` and the
   members dropdown is no longer built (drop the options list at ~10942). All existing
   reads keep working: submit `member: els.bookingMember.value` (~3369/3373),
   availability builder (~18566-18569), edit-load (~15746) — they read/write the hidden
   field harmlessly.
4. **Remove the shortcut handlers.** Delete the event listeners for `data-booking-day`,
   `data-booking-weekend`, `data-booking-duration-hours`, `data-booking-all-day` (and
   the `els.bookingMember` entry in the change-listener array at ~3436 if the element
   becomes hidden). Users set dates via the calendar / datetime inputs.
5. Drop the now-empty `#bookingPanel` section chrome if the form is relocated; otherwise
   keep it as the hidden form host.

## Validation
`npm run validate`, `npm run test:e2e`. **Check the e2e booking flow** (smoke.spec.js)
for any step that selects `#bookingMember` or clicks a shortcut button and update it to
the new flow (member is implicit; set dates directly). Manual: add a booking → it is
attributed to the signed-in user; edit an existing booking still works; the calendar
inputs still submit. Runtime files change → version bump (build-info + service-worker +
checklist; no embedded double-quotes in the top release note).

## Category
**Sonnet** — markup removal + small wiring (pin member to current user, drop shortcut
handlers). Well-specified; the only care item is preserving `<form id="bookingForm">`.
