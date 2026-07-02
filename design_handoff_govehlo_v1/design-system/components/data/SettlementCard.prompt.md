Settlement balance row. Lead with the number per GoVehlo data hierarchy — the amount dominates.

```jsx
<SettlementCard personName="Lars" amount={52.00} direction="owe" onAction={handleRequest} />
<SettlementCard personName="Sara" amount={120.50} direction="receive" onAction={handlePaid} />
<SettlementCard personName="Mikkel" amount={34.00} direction="settled" />
```

**CTA:** `direction="owe"` → amber "Request" button. `direction="receive"` → leaf "Mark paid".
**Settled:** shows leaf checkmark, no action button.
