Shimmer loading placeholder for content that hasn't arrived yet. Uses the Mist green palette so loading states feel on-brand.

```jsx
<Skeleton variant="line" count={3} />
<Skeleton variant="title" />
<Skeleton variant="circle" />
<Skeleton variant="card" />
<Skeleton variant="button" />
```

**Composition:** Build loading skeletons for specific cards by composing primitives:

```jsx
{/* Trip card skeleton */}
<div style={{display:'flex', gap:12, alignItems:'center'}}>
  <Skeleton variant="circle" width={36} height={36} />
  <div style={{flex:1}}>
    <Skeleton variant="title" />
    <Skeleton variant="line" width="80%" />
  </div>
  <Skeleton variant="button" width={60} height={22} />
</div>
```

**Presets:** `line` (14px text), `title` (20px heading), `circle` (40px avatar), `card` (80px full-width), `button` (120×44).
Use `count` to stack text lines — the last line is shortened to 65% for realism.
