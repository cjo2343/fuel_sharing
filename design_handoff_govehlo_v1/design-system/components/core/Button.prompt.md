Primary interactive control for all GoVehlo tap actions. Use `variant="amber"` exclusively for money-related actions — never navigation or decoration.

```jsx
<Button variant="primary" size="md">Book car</Button>
<Button variant="amber" size="md">Request 52 kr</Button>
<Button variant="secondary" size="md">View details</Button>
<Button variant="ghost" size="sm">Cancel</Button>
<Button variant="danger" size="md">Delete trip</Button>
<Button variant="primary" size="md" disabled>Saving…</Button>
<Button variant="primary" size="lg" fullWidth>Get started</Button>
```

**Variants:** `primary` (Forest green, shadowed), `secondary` (Mist fill), `ghost` (transparent),
`outline` (Forest border), `amber` (money actions only — costs, payments), `danger` (destructive).

**Sizes:** `sm` (32px min-height), `md` (44px — default, meets touch target), `lg` (52px — hero CTAs).
