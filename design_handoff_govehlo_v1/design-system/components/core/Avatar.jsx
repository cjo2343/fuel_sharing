import React from 'react';

const PALETTE = [
  { bg: 'var(--color-forest)',     fg: '#fff' },
  { bg: 'var(--color-leaf)',       fg: '#fff' },
  { bg: 'var(--color-amber)',      fg: 'var(--color-deep-forest)' },
  { bg: '#A8D5BA',                 fg: 'var(--color-deep-forest)' },
  { bg: 'var(--color-deep-forest)', fg: '#fff' },
  { bg: '#7EC8A4',                 fg: '#fff' },
];

function colorFor(name) {
  if (!name) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

const pxMap = { xs: 24, sm: 32, md: 40, lg: 52, xl: 64 };

export function Avatar({ name, src, size = 'md', online }) {
  const px = pxMap[size] || pxMap.md;
  const c = colorFor(name);
  const dotSize = Math.max(8, Math.round(px * 0.22));

  return (
    <div style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <div style={{
        width: px, height: px,
        borderRadius: '50%',
        background: src ? 'transparent' : c.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-display)',
        fontWeight: 'var(--font-weight-bold)',
        fontSize: Math.round(px * 0.38),
        color: c.fg,
        overflow: 'hidden',
        flexShrink: 0,
        userSelect: 'none',
      }}>
        {src
          ? <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : initials(name)
        }
      </div>
      {online !== undefined && (
        <span style={{
          position: 'absolute', bottom: 0, right: 0,
          width: dotSize, height: dotSize,
          borderRadius: '50%',
          background: online ? 'var(--color-leaf)' : '#C0CCC5',
          border: '2px solid var(--color-warm-white)',
        }} />
      )}
    </div>
  );
}
