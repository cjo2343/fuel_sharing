# Odometer

Dark instrument-panel km counter. Use in the app header to show total kilometres logged in the current settlement period.

```jsx
<Odometer value={1679} unit="km" />
```

- `value` — numeric km value, formatted with Danish locale (period as thousands separator)
- `unit` — label beside the number, default "km"

Never use Odometer for anything other than an odometer/distance reading. It is a visually distinctive brand element — do not repurpose it as a generic stat display.
