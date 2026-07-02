Lead element for settlement and fuel cards — the number should always dominate the layout.

```jsx
<AmountDisplay amount={52.00} direction="owe" label="You owe Lars" size="lg" />
<AmountDisplay amount={120.50} direction="receive" label="Sara owes you" size="lg" />
<AmountDisplay amount={8.17} direction="owe" currency="€" size="xl" />
<AmountDisplay amount={0} direction="settled" label="All settled" size="md" />
```

**Colour:** amber=owe (money color), leaf=receive (positive), muted=settled.
**Format:** Danish comma decimal ("52,00 kr"). Nunito Black — heavy weight signals importance.
**Sizes:** `sm`, `md`, `lg` (default), `xl` (hero / onboarding).
