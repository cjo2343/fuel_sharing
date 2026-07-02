# Checkbox

Single labeled checkbox with a 44px touch target and DS-styled indicator.

```jsx
const [fullTank, setFullTank] = useState(false);

<Checkbox
  label="Filled to full tank"
  checked={fullTank}
  onChange={e => setFullTank(e.target.checked)}
  hint="Enables real-world consumption statistics between fills."
/>
```

- Minimum height 44px — always safe to tap on mobile
- `hint` appears indented below the label for secondary context
- Use for binary toggles: "Filled to full tank", settings flags, notification opt-ins

Do not use Checkbox for multi-select participant lists — use ParticipantSelector instead.
