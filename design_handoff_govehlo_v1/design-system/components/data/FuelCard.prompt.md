# FuelCard

Fuel receipt log entry row. Use in the Log → Fuel section and History → Settlement audit.

```jsx
<FuelCard
  date="22 jun"
  paidBy="Christian"
  amountDkk={495.90}
  liters={34.2}
  station="Circle K Roskilde"
  fullTank
  onEdit={() => {}}
/>
```

- `amountDkk` and `liters` together auto-derive the kr/L rate shown in monospace
- `fullTank={true}` shows a green "Full tank" chip next to the name
- `onEdit` only renders the Edit action when provided — omit for non-admin users

Always display the DKK amount in amber. Never show a FuelCard without at least `paidBy` and `amountDkk`.
