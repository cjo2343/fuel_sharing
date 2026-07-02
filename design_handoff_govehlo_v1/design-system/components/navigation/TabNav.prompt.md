# TabNav

Horizontal scrollable pill-tab navigation. The primary navigation pattern for GoVehlo's app sections.

```jsx
<TabNav
  sticky
  items={[
    { id: 'log',      label: 'Log' },
    { id: 'book',     label: 'Book' },
    { id: 'settle',   label: 'Settle' },
    { id: 'payments', label: 'Payments', badge: 2 },
    { id: 'history',  label: 'History' },
    { id: 'insights', label: 'Insights' },
  ]}
  active="log"
  onSelect={setTab}
/>
```

- Set `sticky={true}` so the nav pins to the top on scroll
- Tabs scroll horizontally when they overflow — never wrap them to a second line
- The `badge` prop shows a red count on a tab (e.g., unpaid payments count)
- App tab order: Log · Book · Settle · Payments · History · Insights · About · Account · Admin
