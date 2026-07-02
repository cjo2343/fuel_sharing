Persistent inline banner for errors, warnings, and offline state. Stays visible until the condition clears — unlike Toast which auto-dismisses.

```jsx
<ErrorBanner
  message="Connection lost. Your changes are saved locally."
  variant="offline"
  onRetry={() => {}}
/>

<ErrorBanner
  message="Couldn't load trips. Check your connection."
  variant="error"
  onRetry={() => {}}
  onDismiss={() => {}}
/>

<ErrorBanner
  message="Sara's odometer overlaps with your last trip. Please check."
  variant="warning"
/>
```

**Variants:** `error` (red — failed actions, network errors), `warning` (amber — conflicts, stale data), `offline` (muted green — offline/queued mode).

**Voice guideline:** Say what happened and what the user can do. "Connection lost. Your changes are saved locally." not "Error 503: Service Unavailable."

**When to use which feedback component:**
- **Toast** — Action just completed (success/failure), auto-dismisses after 3s
- **ErrorBanner** — Condition persists until resolved (offline, sync conflict, validation)
- **EmptyState** — Section has zero data, encourage first action
