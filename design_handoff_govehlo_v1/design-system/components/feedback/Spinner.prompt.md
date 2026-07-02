Circular loading indicator for actions in progress — saving, syncing, requesting payment.

```jsx
<Spinner size="md" color="forest" />
<Spinner size="sm" color="white" label="Saving…" />
<Spinner size="lg" color="amber" label="Requesting payment…" />
```

**Sizes:** `sm` (16px — inline with text), `md` (24px — buttons, cards), `lg` (32px — page-level).
**Colors:** `forest` (default), `white` (on dark backgrounds), `muted` (secondary), `amber` (money actions).

Use inside buttons during submission: replace the label text with `<Spinner size="sm" color="white" />`.
Always pair with `label` for screen readers, or use `aria-label` on the parent container.
