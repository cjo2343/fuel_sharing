import React, { useState } from 'react';

const sizeMap = {
  sm: { padding: '7px 14px', fontSize: '13px', minHeight: '32px', gap: '5px' },
  md: { padding: '11px 20px', fontSize: '15px', minHeight: '44px', gap: '6px' },
  lg: { padding: '15px 28px', fontSize: '17px', minHeight: '52px', gap: '7px' },
};

const variantStyles = {
  primary: { background: 'var(--color-forest)', color: '#fff', boxShadow: 'var(--shadow-btn)', border: 'none' },
  secondary: { background: 'var(--color-mist)', color: 'var(--color-forest)', boxShadow: 'none', border: 'none' },
  ghost: { background: 'transparent', color: 'var(--color-forest)', boxShadow: 'none', border: 'none' },
  outline: { background: 'transparent', color: 'var(--color-forest)', boxShadow: 'none', border: '1.5px solid var(--color-forest)' },
  amber: { background: 'var(--color-amber)', color: 'var(--color-deep-forest)', boxShadow: 'var(--shadow-btn-amber)', border: 'none' },
  danger: { background: 'var(--color-error-light)', color: 'var(--color-error)', boxShadow: 'none', border: 'none' },
};

const hoverStyles = {
  primary: { background: 'var(--color-forest-hover)' },
  secondary: { background: '#C5E5CE' },
  ghost: { background: 'var(--color-mist)' },
  outline: { background: 'var(--color-mist)' },
  amber: { background: 'var(--color-amber-hover)' },
  danger: { background: '#F9C8C8' },
};

export function Button({
  variant = 'primary',
  size = 'md',
  disabled = false,
  onClick,
  children,
  icon,
  fullWidth = false,
  type = 'button',
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const s = sizeMap[size] || sizeMap.md;
  const v = variantStyles[variant] || variantStyles.primary;
  const h = hoverStyles[variant] || {};

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: s.gap,
        fontFamily: 'var(--font-display)',
        fontWeight: 'var(--font-weight-bold)',
        fontSize: s.fontSize,
        minHeight: s.minHeight,
        padding: s.padding,
        borderRadius: 'var(--radius-md)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: fullWidth ? '100%' : 'auto',
        opacity: disabled ? 0.45 : 1,
        letterSpacing: '0.01em',
        lineHeight: 1.1,
        whiteSpace: 'nowrap',
        transition: 'background 140ms ease, box-shadow 140ms ease, transform 100ms ease',
        transform: pressed && !disabled ? 'scale(0.97)' : 'none',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        ...v,
        ...(hovered && !disabled && !pressed ? h : {}),
      }}
    >
      {icon && <span style={{ display: 'inline-flex', alignItems: 'center' }}>{icon}</span>}
      {children}
    </button>
  );
}
