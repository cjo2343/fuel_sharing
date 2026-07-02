Trip list row — odometer values in monospace for fast scanning, cost in amber.

```jsx
<TripCard
  driver="Christian"
  startOdo={45231}
  endOdo={45318}
  cost={22.50}
  date="15 jun"
  onClick={() => navigate('/trip/12')}
/>
<TripCard driver="Lars" startOdo={45318} endOdo={45502} cost={47.00} date="18 jun" />
```

**Key:** Odometer values use `--font-mono` (Courier New) per spec for fast scanning.
Cost in `--color-amber`. Driver name in `--font-display` bold. Hover lifts card by 1px.
