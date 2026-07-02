import React from 'react';

export function BottomNav({ items = [], active, onSelect }) {
  return (
    <nav style={{
      display: 'flex',
      alignItems: 'stretch',
      height: 'var(--nav-height)',
      background: 'var(--color-surface)',
      boxShadow: 'var(--shadow-nav)',
      borderTop: '1px solid var(--border-color)',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    }}>
      {items.map((item, i) => {
        const isActive = active === item.id || active === i;
        return (
          <button
            key={item.id || i}
            onClick={() => onSelect && onSelect(item.id || i)}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '8px 4px',
              color: isActive ? 'var(--color-forest)' : 'var(--text-muted)',
              transition: 'color 140ms ease',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <span style={{ fontSize: '22px', lineHeight: 1, display: 'block' }}>{item.icon}</span>
            <span style={{
              fontFamily: 'var(--font-body)',
              fontWeight: isActive ? 'var(--font-weight-semibold)' : 'var(--font-weight-regular)',
              fontSize: '10px',
              lineHeight: 1,
            }}>
              {item.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
