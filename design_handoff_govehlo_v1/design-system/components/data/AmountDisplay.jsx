import React from 'react';

const sizeMap = {
  sm: { amount: '20px', currency: '13px', label: '11px' },
  md: { amount: '28px', currency: '16px', label: '12px' },
  lg: { amount: '40px', currency: '20px', label: '13px' },
  xl: { amount: '52px', currency: '24px', label: '14px' },
};

const directionColor = {
  owe:     'var(--color-amber)',
  receive: 'var(--color-leaf)',
  settled: 'var(--text-muted)',
};

export function AmountDisplay({
  amount,
  currency = 'kr',
  direction = 'owe',
  label,
  size = 'lg',
}) {
  const s = sizeMap[size] || sizeMap.lg;
  const color = directionColor[direction] || directionColor.owe;
  const formatted = typeof amount === 'number'
    ? amount.toFixed(2).replace('.', ',')
    : String(amount);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px' }}>
      {label && (
        <span style={{
          fontFamily: 'var(--font-body)',
          fontWeight: 'var(--font-weight-medium)',
          fontSize: s.label,
          color: 'var(--text-muted)',
          lineHeight: 1.3,
        }}>
          {label}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
        <span style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 'var(--font-weight-black)',
          fontSize: s.amount,
          color,
          lineHeight: 1,
          letterSpacing: '-0.02em',
        }}>
          {formatted}
        </span>
        <span style={{
          fontFamily: 'var(--font-body)',
          fontWeight: 'var(--font-weight-semibold)',
          fontSize: s.currency,
          color,
          lineHeight: 1,
          opacity: 0.8,
        }}>
          {currency}
        </span>
      </div>
    </div>
  );
}
