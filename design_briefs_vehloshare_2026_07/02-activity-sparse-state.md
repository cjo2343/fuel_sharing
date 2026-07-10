# Brief 02 — Aktivitet: the sparse-state problem

**Screen:** Aktivitet — the merged activity feed + group chat, opened from Home's
speech-bubble icon. Concept (locked decision GVM-83): ONE chronological stream mixing
system events (trips logged, fuel added, payment requested/confirmed, period closed)
with member chat messages, laid out chat-style — bottom-anchored, newest at the bottom,
input field at the bottom, past days faded.

## What works (keep)

With real traffic the screen is genuinely good, verified on device 2026-07-10:
day dividers ("8. JUL", "I GÅR"), faded older items, event cards with inline actions
("Betaling anmodet" card with "Betal 100,00 kr →"), chat bubbles distinct from event
cards, message input always at hand. Do not redesign the mature state.

## The problem

The chat layout is wrong when the feed is nearly empty. Observed on device
(2026-07-09, fresh workspace with 2 events): the inverted list pins the 2 items to
the BOTTOM of an otherwise blank screen — a large dead void above them. It reads as
a rendering bug, not a young feed. A true zero-state exists and is handled; the
1-to-~8-item range is the gap.

## Design task

Design the feed's **capacity states** and the transitions between them:

1. **Zero** — what invites the first message/action? (Today: plain empty state.)
2. **Sparse (1–~8 items)** — the core task. Options to explore: top-anchored upright
   list until content exceeds the viewport; a welcoming header block that occupies the
   void with purpose (e.g. "Her samles alt hvad der sker i jeres gruppe" + what event
   types will appear); or a hybrid. The input must stay reachable at the bottom.
3. **Full (scrolling)** — current inverted behavior, unchanged.
4. **The flip** — if sparse is upright and full is inverted, define the exact switch
   condition (content height > viewport?) so it never visibly "jumps" while the user
   watches.

Also worth attention:
- Event-card vs chat-bubble visual language in the sparse state (two lonely system
  cards floating look colder than two chat bubbles would).
- The "Betaling anmodet" cards use a soft amber tint — money-related, so within the
  amber rule, but check the tint still reads as "action available" rather than
  "warning" when it is one of only two items on screen.

## Out of scope

The feed's data model, which events appear, push notifications, the input field's
capabilities.

## Success criteria

- A 2-item feed looks intentional, warm, and obviously alive — not broken.
- No layout jump visible when the feed crosses the sparse→full threshold.
- Deliver the state definitions + switch condition as an implementable spec table.
