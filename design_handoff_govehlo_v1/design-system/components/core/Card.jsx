import React, { useState } from 'react';

const paddingMap = {
  none: '0',
  sm:   '10px',
  md:   'var(--card-padding)',
  lg:   '20px',
  xl:   '24px',
};

export function Card({
  children,
  padding = 'md',
  elevated = false,
  tinted = false,
  onClick,
  style: customStyle,
}) {
  const [hovered, setHovered] = useState(false);
  const isClickable = !!onClick;

  return (
    <div
      onClick={onClick}
      onMouseEnter={isClickable ? () => setHovered(true) : undefined}
      onMouseLeave={isClickable ? () => setHovered(false) : undefined}
      style={{
        background: tinted ? 'var(--color-mist)' : 'var(--color-surface)',
        borderRadius: 'var(--radius-lg)',
        padding: paddingMap[padding] || paddingMap.md,
        boxShadow: elevated
          ? 'var(--shadow-elevated)'
          : hovered && isClickable
            ? 'var(--shadow-card-hover)'
            : 'var(--shadow-card)',
        cursor: isClickable ? 'pointer' : 'default',
        transition: 'box-shadow 200ms ease, transform 150ms ease',
        transform: hovered && isClickable ? 'translateY(-1px)' : 'none',
        ...customStyle,
      }}
    >
      {children}
    </div>
  );
}
