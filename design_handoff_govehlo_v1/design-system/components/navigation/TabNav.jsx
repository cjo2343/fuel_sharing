import React from 'react';

/**
 * TabNav — horizontal scrollable pill-tab navigation.
 * The primary navigation pattern for GoVehlo's app sections.
 * Set sticky={true} for in-page use so it pins to the top on scroll.
 */
export function TabNav({ items = [], active, onSelect, sticky = false }) {
  return (
    <nav
      aria-label="Sections"
      style={{
        display: 'flex',
        gap: '8px',
        padding: '10px 0 16px',
        margin: '-6px 0 6px',
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        ...(sticky ? {
          position: 'sticky',
          top: 0,
          zIndex: 20,
          background: 'linear-gradient(180deg, var(--color-warm-white) 0%, rgba(247,249,248,0.94) 72%, rgba(247,249,248,0) 100%)',
        } : {}),
      }}
    >
      {items.map((item, i) => {
        const id = item.id !== undefined ? item.id : i;
        const isActive = active === id;

        return (
          <button
            key={id}
            onClick={() => onSelect && onSelect(id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '7px',
              flexShrink: 0,
              minHeight: '42px',
              padding: '0 16px',
              borderRadius: 'var(--radius-full)',
              border: `1px solid ${isActive ? 'var(--color-forest)' : 'var(--border-color)'}`,
              background: isActive ? 'var(--color-mist)' : 'var(--color-surface)',
              color: isActive ? 'var(--color-forest)' : 'var(--text-muted)',
              fontFamily: 'var(--font-body)',
              fontWeight: isActive
                ? 'var(--font-weight-semibold)'
                : 'var(--font-weight-regular)',
              fontSize: '14px',
              letterSpacing: '0.01em',
              cursor: 'pointer',
              boxShadow: 'var(--shadow-card)',
              transition: 'color 140ms ease, border-color 140ms ease, background 140ms ease',
              WebkitTapHighlightColor: 'transparent',
              whiteSpace: 'nowrap',
            }}
          >
            {item.label}
            {item.badge != null && item.badge > 0 && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: '20px',
                height: '20px',
                padding: '0 5px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--color-error)',
                color: '#fff',
                fontSize: '11px',
                fontWeight: 700,
                lineHeight: 1,
              }}>
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
