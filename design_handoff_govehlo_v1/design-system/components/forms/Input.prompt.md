Standard text input with GoVehlo focus ring and label. Use prefix/suffix for units (kr, km, L).

```jsx
<Input label="Start odometer" type="number" suffix="km" placeholder="45 231" />
<Input label="Fuel price" type="number" prefix="kr" suffix="/L" placeholder="14,50" />
<Input label="Amount" type="number" suffix="kr" error="Must be greater than 0" />
<Input label="Note" placeholder="Optional note" hint="Shown to the group" />
<Input label="Email" type="email" disabled value="christian@govehlo.com" />
```

**Focus state:** Forest green border + 3px green glow ring.
**Error state:** Red border + error message below field.
