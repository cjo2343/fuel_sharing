import React from 'react';

const variantMap = {
  default:  { background: 'var(--color-mist)',          color: 'var(--color-forest)' },
  success:  { background: 'var(--color-success-light)', color: '#1A7A47' },
  money:    { background: 'var(--color-amber-light)',   color: '#A0522D' },
  pending:  { background: '#FEF3E0',                    color: '#B07A2A' },
  error:    { background: 'var(--color-error-light)',   color: 'var(--color-error)' },
  neutral:  { background: '#EAEFEC',                    color: 'var(--text-muted)' },
  forest:   { background: 'var(--color-forest)',        color: '#fff' },
};

const sizeMap = {
  sm: { fontSize: '10px', padding: '2px 7px',  height: '18px' },
  md: { fontSize: '12px', padding: '3px 9px',  height: '22px' },
  lg: { fontSize: '13px', padding: '4px 11px', height: '26px' },
};

export function Badge({ variant = 'default', size = 'md', dot = false, children }) {
  const v = variantMap[variant] || variantMap.default;
  const s = sizeMap[size] || sizeMap.md;

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-medium)',
      fontSize: s.fontSize,
      height: s.height,
      padding: s.padding,
      borderRadius: 'var(--radius-full)',
      lineHeight: 1,
      whiteSpace: 'nowrap',
      ...v,
    }}>
      {dot && (
        <span style={{
          width: '5px', height: '5px',
          borderRadius: '50%',
          background: v.color,
          flexShrink: 0,
        }} />
      )}
      {children}
    </span>
  );
}
