Empty-data placeholder for when a list or section has zero items. Use encouraging, direct copy.

```jsx
<EmptyState
  icon="📍"
  title="No trips yet"
  description="Log your first trip to start tracking distances."
  action={{ label: 'Log trip', onClick: () => {} }}
/>

<EmptyState
  icon="⛽"
  title="No fuel entries"
  description="Add a fuel receipt after your next fill-up."
  compact
/>

<EmptyState
  icon="✓"
  title="All settled"
  description="No outstanding balances this period."
/>
```

**Voice:** "No trips yet" not "No data available." "Log your first trip" not "Create new entry."
**Compact:** Use `compact` when the empty state appears inside a card or inline section.
**Icon:** Pass an emoji string or a React node (e.g. a Lucide icon element).
