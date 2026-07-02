# Select

Dropdown field. Same visual language as Input — 48px height, focus ring, label/hint/error.

```jsx
<Select
  label="Fuel type"
  value={fuelType}
  onChange={e => setFuelType(e.target.value)}
  options={[
    { value: 'diesel', label: 'Diesel' },
    { value: '95',     label: 'Petrol 95' },
  ]}
/>
```

- Pass options as strings or `{ value, label }` objects
- `placeholder` renders as a disabled first option (use for "Choose…" prompts)
- Matches `Input` sizing exactly — swap freely in form grids

Use Select for: fuel type, location privacy mode, payer, driver (when not locked).
