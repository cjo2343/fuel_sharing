import React from 'react';

export function AppHeader({ greeting, subtitle, actions, compact = false }) {
  return (
    <header style={{
      background: 'var(--color-forest)',
      padding: compact
        ? '12px var(--screen-padding-x)'
        : '20px var(--screen-padding-x) 24px',
      display: 'flex',
      alignItems: compact ? 'center' : 'flex-end',
      justifyContent: 'space-between',
      minHeight: compact ? '52px' : 'var(--header-height)',
      paddingTop: compact
        ? '12px'
        : 'max(20px, env(safe-area-inset-top, 20px))',
    }}>
      <div>
        {greeting && (
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontWeight: compact
              ? 'var(--font-weight-bold)'
              : 'var(--font-weight-extrabold)',
            fontSize: compact
              ? 'var(--text-heading-size)'
              : 'var(--text-title-size)',
            color: '#fff',
            margin: 0,
            lineHeight: 1.2,
          }}>
            {greeting}
          </h1>
        )}
        {subtitle && (
          <p style={{
            fontFamily: 'var(--font-body)',
            fontSize: 'var(--text-caption-size)',
            color: 'rgba(255,255,255,0.70)',
            margin: '3px 0 0',
            lineHeight: 1.3,
          }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {actions}
        </div>
      )}
    </header>
  );
}
