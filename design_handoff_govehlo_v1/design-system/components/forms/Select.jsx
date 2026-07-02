import React, { useState } from 'react';

/**
 * Select — dropdown field.
 * Same visual language as Input: 48px height, focus ring, label/hint/error.
 * Pass options as strings or { value, label } objects.
 */
export function Select({
  label,
  value,
  onChange,
  options = [],
  placeholder,
  hint,
  error,
  disabled = false,
  id,
}) {
  const [focused, setFocused] = useState(false);
  const selectId = id || `gv-select-${Math.random().toString(36).slice(2, 7)}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', width: '100%' }}>
      {label && (
        <label htmlFor={selectId} style={{
          fontFamily: 'var(--font-body)',
          fontWeight: 'var(--font-weight-medium)',
          fontSize: 'var(--text-label-size)',
          color: 'var(--text-secondary)',
          lineHeight: 1.4,
        }}>
          {label}
        </label>
      )}

      <div style={{ position: 'relative' }}>
        <select
          id={selectId}
          value={value}
          onChange={onChange}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            width: '100%',
            height: '48px',
            padding: '0 40px 0 14px',
            appearance: 'none',
            WebkitAppearance: 'none',
            background: disabled ? '#F4F6F5' : 'var(--color-surface)',
            borderRadius: 'var(--radius-md)',
            border: `1.5px solid ${error ? 'var(--color-error)' : focused ? 'var(--color-forest)' : 'var(--border-color)'}`,
            boxShadow: focused ? 'var(--shadow-focus)' : 'none',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-body)',
            fontSize: 'var(--text-body-size)',
            fontWeight: 'var(--font-weight-regular)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            outline: 'none',
            transition: 'border-color 150ms ease, box-shadow 150ms ease',
          }}
        >
          {placeholder && (
            <option value="" disabled>{placeholder}</option>
          )}
          {options.map(o => {
            const val = typeof o === 'object' ? o.value : o;
            const lbl = typeof o === 'object' ? o.label : o;
            return <option key={val} value={val}>{lbl}</option>;
          })}
        </select>

        {/* Chevron */}
        <span style={{
          position: 'absolute',
          right: '14px',
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          color: 'var(--text-muted)',
          display: 'flex',
          alignItems: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </div>

      {(hint || error) && (
        <p style={{
          fontFamily: 'var(--font-body)',
          fontSize: 'var(--text-caption-size)',
          color: error ? 'var(--color-error)' : 'var(--text-muted)',
          margin: 0,
          lineHeight: 1.4,
        }}>
          {error || hint}
        </p>
      )}
    </div>
  );
}
