Transient feedback toast per brand spec: payment actions, sync confirmation, destructive undos.

```jsx
<Toast message="Marked as paid." variant="success" visible />
<Toast message="Sara requested 52 kr. Tap to view." variant="money" visible />
<Toast message="Trip saved · 14:05" variant="default" visible />
<Toast message="Connection lost. Retrying…" variant="error" visible onDismiss={() => {}} />
```

**Voice guideline:** Direct, first-person. "Marked as paid." not "Payment receipt acknowledged."
Position fixed at bottom of screen, above nav bar. Animate in from below with `ease-spring`.
