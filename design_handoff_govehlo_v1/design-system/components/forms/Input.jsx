import React, { useState } from 'react';

export function Input({
  label,
  type = 'text',
  placeholder,
  value,
  onChange,
  prefix,
  suffix,
  hint,
  error,
  disabled = false,
  id,
}) {
  const [focused, setFocused] = useState(false);
  const inputId = id || `gv-input-${Math.random().toString(36).slice(2, 7)}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', width: '100%' }}>
      {label && (
        <label htmlFor={inputId} style={{
          fontFamily: 'var(--font-body)',
          fontWeight: 'var(--font-weight-medium)',
          fontSize: 'var(--text-label-size)',
          color: 'var(--text-secondary)',
          lineHeight: 1.4,
        }}>
          {label}
        </label>
      )}

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '0 14px',
        height: '48px',
        background: disabled ? '#F4F6F5' : 'var(--color-surface)',
        borderRadius: 'var(--radius-md)',
        border: `1.5px solid ${error ? 'var(--color-error)' : focused ? 'var(--color-forest)' : 'var(--border-color)'}`,
        boxShadow: focused ? 'var(--shadow-focus)' : 'none',
        transition: 'border-color 150ms ease, box-shadow 150ms ease',
      }}>
        {prefix && (
          <span style={{
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-body)',
            fontSize: '15px',
            flexShrink: 0,
          }}>
            {prefix}
          </span>
        )}
        <input
          id={inputId}
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontFamily: 'var(--font-body)',
            fontSize: 'var(--text-body-size)',
            fontWeight: 'var(--font-weight-regular)',
            color: 'var(--text-primary)',
            height: '100%',
            minWidth: 0,
          }}
        />
        {suffix && (
          <span style={{
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-body)',
            fontSize: '15px',
            flexShrink: 0,
          }}>
            {suffix}
          </span>
        )}
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
