# SummaryBand

A row of 2–4 dark stat tiles. Used at the top of the Settle screen to show period-level numbers.

```jsx
<SummaryBand items={[
  { label: 'Fuel rate',   value: '2,47 kr/km' },
  { label: 'Trip shares', value: '1.234 kr' },
  { label: 'Fuel paid',   value: '895 kr' },
]} />
```

- Format values as strings with Danish number formatting before passing (comma decimal, period thousands)
- Typically 3 items for the Settle screen; accepts 2–4
- Never use SummaryBand for per-person data — use PersonCard or SettlementCard instead
