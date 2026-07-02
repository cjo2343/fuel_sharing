import React from 'react';

/**
 * SummaryBand — row of dark stat tiles.
 * Used at the top of the Settle screen to show period-level numbers
 * (fuel rate, trip total, fuel paid). Typically 3 items.
 */
export function SummaryBand({ items = [] }) {
  const count = Math.max(1, items.length);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
      gap: '12px',
    }}>
      {items.map((item, i) => (
        <div key={i} style={{
          minHeight: '104px',
          border: '1px solid rgba(22, 32, 31, 0.12)',
          borderRadius: 'var(--radius-lg)',
          background: 'radial-gradient(circle at top right, rgba(47, 125, 99, 0.22), transparent 60%), var(--color-deep-forest)',
          color: '#fff',
          padding: '18px',
          display: 'grid',
          alignContent: 'space-between',
          boxShadow: 'var(--shadow-card)',
        }}>
          <span style={{
            fontFamily: 'var(--font-body)',
            fontWeight: 500,
            fontSize: '13px',
            color: '#c9d5d1',
            lineHeight: 1.3,
          }}>
            {item.label}
          </span>
          <strong style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 900,
            fontSize: 'clamp(1.4rem, 4vw, 2.4rem)',
            letterSpacing: '-0.04em',
            lineHeight: 1.05,
            overflowWrap: 'anywhere',
            color: '#fff',
          }}>
            {item.value}
          </strong>
        </div>
      ))}
    </div>
  );
}
