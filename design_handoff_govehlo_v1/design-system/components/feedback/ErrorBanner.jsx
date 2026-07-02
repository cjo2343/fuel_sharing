import React from 'react';

const VARIANTS = {
  error: {
    background: '#FDEDED',
    borderColor: '#D95050',
    color: '#D95050',
    textColor: '#8B2E2E',
    icon: '!',
  },
  warning: {
    background: '#FDE8D8',
    borderColor: '#F4A261',
    color: '#F4A261',
    textColor: '#7D4A1A',
    icon: '!',
  },
  offline: {
    background: '#EAEFEC',
    borderColor: '#6B8F7A',
    color: '#6B8F7A',
    textColor: '#3D5C48',
    icon: '↯',
  },
};

/**
 * ErrorBanner — persistent inline banner for errors, warnings, and offline state.
 *
 * Unlike Toast (transient), ErrorBanner stays visible until the condition clears.
 * Use for: network failures, sync conflicts, offline mode, validation summaries.
 *
 * Voice guideline: say what happened and what the user can do.
 * "Connection lost. Your changes are saved locally." not "Error 503."
 */
export function ErrorBanner({
  message,
  variant = 'error',
  onRetry,
  onDismiss,
  children,
}) {
  const v = VARIANTS[variant] || VARIANTS.error;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '12px 14px',
      background: v.background,
      borderRadius: 'var(--radius-md, 12px)',
      borderLeft: '3px solid ' + v.borderColor,
    }}>
      <span style={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        background: v.borderColor,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 800,
        flexShrink: 0,
        marginTop: 1,
      }}>
        {v.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontFamily: 'var(--font-body, Inter, sans-serif)',
          fontSize: '13px',
          fontWeight: 500,
          color: v.textColor,
          margin: 0,
          lineHeight: 1.45,
        }}>
          {message}
        </p>
        {children}
        {onRetry && (
          <button
            onClick={onRetry}
            style={{
              marginTop: 8,
              fontFamily: 'var(--font-body, Inter, sans-serif)',
              fontSize: '12px',
              fontWeight: 600,
              color: v.borderColor,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              textDecoration: 'underline',
              textDecorationColor: 'transparent',
              transition: 'text-decoration-color 140ms ease',
            }}
            onMouseEnter={e => e.target.style.textDecorationColor = v.borderColor}
            onMouseLeave={e => e.target.style.textDecorationColor = 'transparent'}
          >
            Retry
          </button>
        )}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: v.color,
            cursor: 'pointer',
            padding: 2,
            fontSize: 16,
            lineHeight: 1,
            opacity: 0.6,
            flexShrink: 0,
          }}
        >×</button>
      )}
    </div>
  );
}
