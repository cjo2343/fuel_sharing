import React from 'react';

/**
 * Checkbox — single labeled checkbox.
 * 44px touch target, custom indicator styled with DS tokens.
 * Use for binary toggles: "Filled to full tank", settings flags, etc.
 */
export function Checkbox({ label, checked = false, onChange, hint, disabled = false, id }) {
  const checkId = id || `gv-cb-${Math.random().toString(36).slice(2, 7)}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <label
        htmlFor={checkId}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          minHeight: '44px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          userSelect: 'none',
        }}
      >
        {/* Hidden native input for a11y */}
        <input
          id={checkId}
          type="checkbox"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          style={{ position: 'absolute', opacity: 0, width: 0, height: 0, margin: 0 }}
        />

        {/* Custom indicator */}
        <span style={{
          width: '20px',
          height: '20px',
          flexShrink: 0,
          borderRadius: '5px',
          border: `2px solid ${checked ? 'var(--color-forest)' : 'var(--border-color)'}`,
          background: checked ? 'var(--color-forest)' : 'var(--color-surface)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'border-color 140ms ease, background 140ms ease',
        }}>
          {checked && (
            <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
              <path d="M1.5 4.5L4.17 7.5L9.5 1.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </span>

        {/* Label */}
        {label && (
          <span style={{
            fontFamily: 'var(--font-body)',
            fontWeight: 'var(--font-weight-medium)',
            fontSize: 'var(--text-body-size)',
            color: 'var(--text-primary)',
            lineHeight: 1.4,
            flex: 1,
          }}>
            {label}
          </span>
        )}
      </label>

      {hint && (
        <p style={{
          margin: '0 0 0 30px',
          fontFamily: 'var(--font-body)',
          fontSize: 'var(--text-caption-size)',
          color: 'var(--text-muted)',
          lineHeight: 1.4,
        }}>
          {hint}
        </p>
      )}
    </div>
  );
}
