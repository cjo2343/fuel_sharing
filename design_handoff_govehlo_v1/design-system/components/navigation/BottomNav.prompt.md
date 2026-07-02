Primary PWA navigation bar fixed at the bottom. Five tabs per brand spec.

```jsx
const tabs = [
  { id: 'home',       icon: <HomeIcon />,       label: 'Home' },
  { id: 'trips',      icon: <RouteIcon />,      label: 'Trips' },
  { id: 'fuel',       icon: <FuelIcon />,       label: 'Fuel' },
  { id: 'settlement', icon: <SettleIcon />,     label: 'Settlement' },
  { id: 'history',    icon: <HistoryIcon />,    label: 'History' },
];

<BottomNav items={tabs} active="home" onSelect={setTab} />
```

Active tab: Forest green label + semibold text. Inactive: `--text-muted`.
Height: 64px (`--nav-height`) + `safe-area-inset-bottom` for iPhone.
