# ParticipantSelector

Checkbox grid for selecting which group members join a trip or booking estimate.
Use in Log → Trip ("Split between") and Book → Estimate ("People joining").

```jsx
const [sel, setSel] = useState(['christian', 'lars']);

<ParticipantSelector
  participants={[
    { id: 'christian', name: 'Christian' },
    { id: 'lars',      name: 'Lars' },
    { id: 'sara',      name: 'Sara' },
    { id: 'mikkel',    name: 'Mikkel' },
  ]}
  selected={sel}
  onChange={setSel}
/>
```

- The trip driver should be pre-selected and should stay in the list
- Works with plain string arrays too: `participants={['Christian', 'Lars']}`
- Lays out in an auto-fit grid — 2 per row on mobile, up to 4 on desktop
