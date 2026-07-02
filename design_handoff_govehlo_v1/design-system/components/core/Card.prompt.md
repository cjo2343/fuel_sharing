Base surface container for all GoVehlo content. Uses brand-spec 16px radius and green-tinted shadow.

```jsx
<Card padding="md">Basic content card</Card>
<Card padding="lg" elevated>Modal-style elevated card</Card>
<Card tinted padding="md">Mist-green tinted card</Card>
<Card onClick={() => navigate('/trip/1')} padding="md">Tappable trip card</Card>
```

**Padding:** `none`, `sm` (10px), `md` (12px — default, matches `--card-padding`), `lg` (20px), `xl` (24px).
**elevated:** Use for modals, bottom sheets, confirmation dialogs.
**tinted:** Use for secondary cards inside a white card.
