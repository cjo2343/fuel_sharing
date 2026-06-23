# Audit: Smart predictions — odometer / tank / consumption / price rules

Scope: `buildSmartPredictions` / `renderSmartPredictions` (app.js ~12504),
`buildFuelIntelligence` (~11114), `calculateTripCostEstimate` (~12011),
`estimateTankStateAtOdometer` (~11444), `buildRefuelPlanning` (~11877),
`calculateHistoricalFuelStats` (settlement-calculations.js ~196).

## Verdict
The core math is **sound and internally consistent**:
- Tank range uses proper full-tank-odometer baselines: range = remaining L ÷
  (L/100km) × 100. With no baseline it assumes a full tank → 55 L ÷ 6 × 100 =
  916.7 km ("full"). ✓
- Planning estimate: `100 km × 6 L/100km × 15.59 DKK/L = 93.54 DKK`. ✓
- `calculateTripCostEstimate` is consistent: the "Why this estimate?" text names the
  same price source it actually computes with (historical receipt avg → live →
  fallback). ✓
- Historical cost/km is gated behind ≥50 km + a realistic-consumption check before
  it's trusted for planning. ✓

Found three real issues (two minor, one substantive) plus two UX-clarity notes.

## Issues

### A. PLANNING SOURCE card can name the wrong price source (minor) — Sonnet
`intel.estimateSource` (app.js ~11130) is:
`canUseHistorical ? "Historical cost/km" : (livePrice ? "Car setting + live diesel reference price" : "Car setting + fallback fuel price")`.
But the actual estimate (`calculateTripCostEstimate`) uses
`historical.pricePerLiter > 0 ? historical.pricePerLiter : livePrice || fallbackPrice`
— i.e. a historical receipt average takes precedence over the live price. So when a
workspace has receipts with liters AND a live price AND can't use historical
cost/km, the PLANNING SOURCE card says "live diesel reference price" while "Why this
estimate?" correctly says "historical receipt average." They disagree.
- Fix: compute `estimateSource`'s price-source the same way: historical receipt
  average → live → fallback. Single source of truth for the price label.

### B. "consumptionLooksRealistic" is vacuously true with no data, inflating confidence (minor) — Sonnet
`consumptionLooksRealistic = !hasHistoricalConsumption || (litersPer100Km 3..10)`
(app.js ~11125). With zero liters logged it's `true`, which (a) awards a point in
`confidenceScore` and (b) makes `historicalQuality` show "Good" and the monthly
signal appear — i.e. "Historical consumption looks plausible" when there's nothing
to judge.
- Fix: distinguish "no data" from "plausible." Only award the confidence point and
  the "looks plausible" copy when `hasHistoricalConsumption` is true AND in range.
  When there's no consumption data, say so ("Not enough liters logged yet").

### C. Historical L/100km is total-liters ÷ total-km, not full-tank-to-full-tank (substantive) — Opus
`calculateHistoricalFuelStats.litersPer100Km` (settlement-calculations.js ~249) is
`totalLiters / totalTripKm × 100` across all periods. That mixes partial fills, the
first fill (which fuels driving before logged trips), and unknown start/end tank
levels — so it is NOT real consumption. The app already has correct full-tank logic
(`estimateTankStateAtOdometer` / `getLatestFullTankFuelBeforeOdometer`) but doesn't
use it here. Consequence: the realism gate (3–10 L/100km) and the displayed
consumption can mis-judge — e.g. one big first fill pushes L/100km high → historical
data wrongly distrusted, or vice versa.
- Fix: compute consumption from full-tank-to-full-tank segments — sum liters added
  strictly between two consecutive `fullTank` odometer readings ÷ the odometer delta
  between them (reuse the tank-timeline helpers). Fall back to total/total only when
  there are no full-tank pairs, and label it as a rough estimate in that case.
- Tagged Opus: new calc + edge cases (missing odometers, out-of-order fills, the
  partial-fill accounting) and it changes the trust gate, so it needs care + the
  existing overfill/odometer tests as guardrails.

### F. Tank range ignores trusted historical consumption (consistency decision) — Opus
When historical data is trusted, `buildFuelIntelligence` displays + plans with the
receipt-derived consumption (e.g. 5.7 L/100km), but `estimateTankStateAtOdometer`
always uses `state.fuelConsumption` (the car setting, e.g. 6 L/100km). So the Fuel
intelligence panel and the Tank range can disagree on the car's consumption
(916.7 km @ 6 vs ~965 km @ 5.7).
- Decision: either (a) keep tank range on the car setting deliberately (conservative,
  spec-based — defensible) and make that explicit in copy, or (b) once C (proper
  full-tank-to-full-tank consumption) lands, feed that trusted value into the tank
  range too for one consistent consumption number. Recommend doing this *after* C, so
  the tank range only adopts historical consumption when it's measured correctly.
- Confirmed wiring: vehicle lookup writes the car setting via
  `applyVehicleLookupToSettings` (app.js ~10269), which is the fallback consumption +
  the tank-range input; it does not override trusted historical stats.

## UX-clarity notes (optional, Sonnet)
- D. "Tank range now: 916.7 km full" when there's no full-tank baseline reads like
  the app knows the tank is full. Consider "≈916.7 km on a full tank (no full-tank
  reading logged yet)".
- E. "PLANNING CONFIDENCE: Medium" and "HISTORICAL DATA QUALITY: Limited" shown at
  once are two different confidence concepts; a one-line clarification would help.

## Validation for any fix
`npm run validate` (includes overfill/odometer/tank guards), release-readiness,
`npm run test:e2e` (the tank-range/overfill smoke tests). Manual: a workspace with
real full-tank receipts should show full-tank-to-full-tank L/100km close to the
car setting; the realism gate should stop flipping on a single large first fill.
Runtime files change → version bump (build-info + service-worker + checklist).
