import React from 'react';

const variantMap = {
  default: { background: 'var(--color-deep-forest)', color: '#fff',                     icon: '✓' },
  success: { background: 'var(--color-forest)',      color: '#fff',                     icon: '✓' },
  money:   { background: 'var(--color-amber)',        color: 'var(--color-deep-forest)', icon: '↗' },
  error:   { background: '#C0392B',                  color: '#fff',                     icon: '!' },
  info:    { background: '#2B5797',                  color: '#fff',                     icon: 'i' },
};

export function Toast({ message, variant = 'default', visible = true, onDismiss }) {
  if (!visible) return null;

  const v = variantMap[variant] || variantMap.default;

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '10px',
      padding: '12px 16px',
      borderRadius: 'var(--radius-md)',
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--text-body-size)',
      fontWeight: 'var(--font-weight-medium)',
      maxWidth: '360px',
      boxShadow: 'var(--shadow-elevated)',
      background: v.background,
      color: v.color,
    }}>
      <span style={{
        width: '20px', height: '20px',
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.18)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '10px', fontWeight: 700,
        flexShrink: 0,
      }}>
        {v.icon}
      </span>
      <span style={{ flex: 1 }}>{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} style={{
          background: 'none', border: 'none',
          color: 'inherit', opacity: 0.65,
          cursor: 'pointer', padding: '2px',
          display: 'flex', alignItems: 'center',
          fontSize: '18px', lineHeight: 1,
        }}>×</button>
      )}
    </div>
  );
}
