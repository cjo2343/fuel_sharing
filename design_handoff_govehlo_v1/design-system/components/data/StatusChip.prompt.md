# StatusChip

Settlement payment status indicator pill. Use on settlement cards, period archive cards, and the Payments tab.

```jsx
<StatusChip status="open" />
<StatusChip status="requested" />
<StatusChip status="paid" />
```

Status → colour mapping:
- `open`      → amber  → payment not yet requested
- `requested` → blue   → payment requested via MobilePay
- `paid`      → green  → payment confirmed
- `pending`   → warm   → generic awaiting state

**Blue rule:** The `requested` status is the only place `--color-blue` is used in GoVehlo. Do not use blue for navigation, decoration, or any other status.
