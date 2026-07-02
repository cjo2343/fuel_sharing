Forest-green app header. Home screen uses full height with personal greeting; other screens use compact mode.

```jsx
// Home
<AppHeader
  greeting="Good morning, Christian."
  subtitle="Saved · 14:05"
/>

// Inner screen
<AppHeader compact greeting="Trips" />

// With actions
<AppHeader
  compact
  greeting="Fuel Log"
  actions={<IconButton icon={<PlusIcon />} label="Add fuel" />}
/>
```

**Voice:** Personalised greeting by first name. Sync state in subtitle ("Saved · 14:05" or "Saving…").
Background: always `var(--color-forest)`. Text: white.
