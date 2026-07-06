# GoVehlo mobile — motion polish pack v2 (handoff)

Prototype: `GoVehlo Mobile Motion.dc.html` (moments 1a–1d, interactive).
Target repo: `cjo2343/govehlo-mobile`. Extends the GVM-129 motion pack — reuse `springIn`, `easings`, `timings`, `tweenValue`, `useReducedMotion` from `src/lib/motion.ts`. Built-in `Animated` only, no reanimated/lottie. Every moment gates on `useReducedMotion()` and snaps to the end state.

## 1a — Home arrival (skeleton → cascade + count-up)

**Weak spot:** `HomeScreen` cold load shows a full-screen `Spinner` ("Indlæser jeres regnskab…"). The DS says Skeleton for content loading; the header greeting is already known and shouldn't disappear.

- Keep `AppHeader` rendered immediately with the real greeting.
- Body: Skeleton composition mirroring the loaded layout — balance card (2 columns: line + title), car-status row (rect 42 + two lines), member circles, one card block. Mist shimmer per DS `Skeleton`.
- On data ready: sections cascade with `tabIn`-style entrances (350ms, standard ease), stagger 0 / 80 / 160 / 240ms (balance → car status → group → trips).
- Balance amounts count up with `tweenValue(0, amount, 800)` easeOutCubic, formatted `toFixed(dec).replace('.', ',')`. Run once per cold load, not on tab refocus.

## 1b — Mark as paid

**Weak spot:** `SettlementCard` flips state with no confirmation moment.

- Button press: scale 0.95 spring (existing pressed style).
- CTA swaps to a 40px Mist circle popping in with `springIn`; the check is an SVG polyline, `strokeDasharray 24`, dashoffset 24 → 0 over 400ms standard ease, 150ms after the pop.
- "Betalt" chip (successLight/forest) pops with `springIn`, 150ms delay.
- Toast (`Toast` component): "Betaling registreret. Sara har fået besked." — `toastIn` 340ms spring, auto-dismiss ~2.6s. Payment actions always toast (DS rule).

## 1c — Branded pull-to-refresh

**Weak spot:** stock `RefreshControl` tint — a lost brand moment on every refresh.

- Custom pull header (requires replacing `RefreshControl` with a `ScrollView` `onScroll` / gesture implementation — scope accordingly): a 160×22 Mist road; while refreshing, an amber dot shuttles end-to-end (1.4s, easeInOut, loop) and the dashed centreline scrolls (dashoffset −28/0.5s linear loop).
- Labels: pull = "Slip for at opdatere", refreshing = "Opdaterer…".
- Content returns with a spring settle (`cubic-bezier(.34,1.3,.64,1)`, 500ms); rows that arrived with the refresh pop in with `springIn` (leaf-tinted border for "new", not amber).
- If replacing RefreshControl is too costly, minimum: keep tint `colors.forest` and pop new rows on arrival.

## 1d — Request payment

**Weak spot:** request CTA flips straight to the chip; no in-flight or arrival feedback.

- Press: scale 0.95 spring.
- In-flight: button keeps amber surface at 85% opacity, spinner (14px, deep-forest on translucent track) + "Sender…". Replace-text-with-spinner per DS.
- Success: "Anmodet" `StatusChip` (blueSoft/blue — the only sanctioned blue) pops with `springIn` plus a **one-shot** ring pulse: shadow 0 → 5px `rgba(53,93,156,.25)` → 0 over 1.2s, 350ms after the pop. Never loop it.
- InlineMessage (info) rises in 200ms later: "Lars har fået besked. Beløbet markeres som betalt, når du har modtaget det på MobilePay."

## 2a — Log: live cost preview

**Weak spot:** `LogScreen`'s `costCard` appears/disappears with no transition while typing, and the save gives only a toast.

- Cost card enters with `springIn` pop (400ms) the first render `tripKm > 0 && fuelRate > 0`; exits with a 150ms fade. Don't re-pop on every keystroke — only on visibility change.
- On save success: toast copy gains the roll-forward context ("Tur registreret. Næste tur starter ved 45.405 km.") since the form silently prefils `startKm` with `endKm` — motion alone doesn't explain the reset.
- Submit button: text → Spinner + "Gemmer…" per DS (already partially done via title swap; add the spinner).

## 2b — Insights arrival

**Weak spot:** `InsightsScreen` renders all stats statically.

- Stat tiles (`StatTile` grid): `springIn` pops staggered 0/70/140/210ms; numeric values count up with `tweenValue` 800ms easeOutCubic (DK comma formatting). The "Sikkerhed" tile pops last, no count.
- `StatBand` rises with `slideUp` (340ms) at ~300ms; its three values count.
- Month rows: `tabIn` staggered ~100ms apart.
- Play on screen focus, once per visit (`useFocusEffect` + replay from `useTabIn` pattern), skip under reduced motion.

## 2c — Offline sync reconciliation

**Weak spot:** ADR-001 outbox rows (`PendingRowWrap`, `PendingChip`) sit dimmed at 0.7 opacity and the chip flips state instantly; the offline `ErrorBanner` disappears abruptly when connectivity returns.

- Banner exit: collapse max-height 450ms standard ease + fade 350ms (Animated height or LayoutAnimation).
- Chip sequence on flush: "Afventer" (neutral) → "Sender…" (12px spinner in-chip) → "Synkroniseret" (successLight/forest + check) popping with `springIn`; chip fades out ~1.5s later as the synthetic row is replaced by the acknowledged one.
- Row opacity 0.65 → 1 over 400ms when acknowledged.
- Keep the blocked state untouched (it needs the resolution sheet, not celebration).

## 2d — Sub-tab pill slide

**Weak spot:** `TabNav` flips the active pill instantly; tab content swaps with no transition (History, Log, Book all use it).

- Shared sliding indicator behind the labels: translateX to the active index, 280ms `cubic-bezier(.34,1.3,.64,1)` (Animated.spring works too); label color crossfades 200ms.
- Incoming tab content: `tabIn` (300ms, 6px rise) — reuse `useTabIn().replay()` keyed on the active tab.
- Note: production `TabNav` pills are individually sized (scrollable row) — measure pill x/width via `onLayout` rather than assuming equal thirds.

## Shared timing tokens

All durations/easings map to existing tokens: instant 80 / fast 140 / normal 220 / slow 340; spring `cubic-bezier(.34,1.56,.64,1)`; standard `cubic-bezier(.4,0,.2,1)`; easeOutCubic for numeric tweens. New additions worth adding to `src/lib/motion.ts`: `countUp` (wrap of `tweenValue` + DK formatting) and `checkDraw` (400ms polyline draw).
