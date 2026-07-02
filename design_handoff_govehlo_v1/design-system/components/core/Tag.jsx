import React from 'react';

const colorMap = {
  default: { background: 'var(--color-mist)',          color: 'var(--color-forest)' },
  amber:   { background: 'var(--color-amber-light)',   color: '#A0522D' },
  leaf:    { background: 'var(--color-success-light)', color: '#1A7A47' },
  neutral: { background: '#EAEFEC',                    color: 'var(--text-muted)' },
};

export function Tag({ label, color = 'default', onRemove }) {
  const c = colorMap[color] || colorMap.default;

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '4px 10px',
      borderRadius: 'var(--radius-full)',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-medium)',
      fontSize: '12px',
      lineHeight: 1,
      whiteSpace: 'nowrap',
      ...c,
    }}>
      {label}
      {onRemove && (
        <button onClick={onRemove} style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '14px', height: '14px',
          borderRadius: '50%',
          border: 'none',
          background: 'rgba(0,0,0,0.1)',
          color: 'inherit',
          cursor: 'pointer',
          padding: 0,
          fontSize: '10px',
          lineHeight: 1,
          marginLeft: '1px',
        }}>×</button>
      )}
    </span>
  );
}
