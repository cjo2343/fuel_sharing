import React from 'react';

/**
 * EmptyState — placeholder for sections with no data.
 * Use when a list, table, or card group has zero items.
 *
 * Voice guideline: encouraging and direct.
 * "No trips yet" not "No data available."
 * "Log your first trip" not "Create new entry."
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      padding: compact ? '24px 20px' : '40px 24px',
      gap: compact ? 8 : 12,
    }}>
      {icon && (
        <div style={{
          width: compact ? 40 : 52,
          height: compact ? 40 : 52,
          borderRadius: '50%',
          background: '#D8F3DC',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: compact ? 0 : 4,
        }}>
          {typeof icon === 'string' ? (
            <span style={{
              fontSize: compact ? 18 : 22,
              color: '#2D6A4F',
              lineHeight: 1,
            }}>{icon}</span>
          ) : icon}
        </div>
      )}
      {title && (
        <h3 style={{
          fontFamily: 'var(--font-display, Nunito, sans-serif)',
          fontWeight: 700,
          fontSize: compact ? '15px' : '17px',
          color: 'var(--text-primary, #1A2E1F)',
          margin: 0,
          lineHeight: 1.3,
        }}>
          {title}
        </h3>
      )}
      {description && (
        <p style={{
          fontFamily: 'var(--font-body, Inter, sans-serif)',
          fontSize: compact ? '12px' : '13px',
          color: 'var(--text-muted, #6B8F7A)',
          margin: 0,
          lineHeight: 1.5,
          maxWidth: 260,
        }}>
          {description}
        </p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          style={{
            marginTop: compact ? 4 : 8,
            fontFamily: 'var(--font-display, Nunito, sans-serif)',
            fontWeight: 700,
            fontSize: '14px',
            color: '#FFFFFF',
            background: 'var(--color-forest, #2D6A4F)',
            border: 'none',
            borderRadius: 'var(--radius-md, 12px)',
            padding: '10px 20px',
            cursor: 'pointer',
            minHeight: '44px',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
