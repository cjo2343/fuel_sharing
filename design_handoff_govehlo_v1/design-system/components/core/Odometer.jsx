import React from 'react';

/**
 * Odometer — GoVehlo km counter display.
 * Styled as a dark instrument panel. Used in the app header to show
 * total kilometres logged in the current settlement period.
 */
export function Odometer({ value = 0, unit = 'km' }) {
  const formatted = typeof value === 'number'
    ? value.toLocaleString('da-DK')
    : String(value);

  return (
    <div
      role="meter"
      aria-label={`${formatted} ${unit}`}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        minWidth: '196px',
        height: '78px',
        border: '1px solid rgba(17, 23, 22, 0.92)',
        borderRadius: '14px',
        background: 'linear-gradient(180deg, #2b3432 0%, #111716 100%)',
        boxShadow: 'inset 0 0 0 5px rgba(255,255,255,0.06), 0 18px 45px rgba(22,32,31,0.09)',
        color: '#f5f3ea',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* Vertical stripe texture */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: 'repeating-linear-gradient(90deg, transparent 0px 22px, rgba(255,255,255,0.06) 22px 24px)',
        pointerEvents: 'none',
      }} />
      {/* Gloss edge lines */}
      <div style={{
        position: 'absolute',
        inset: '10px 14px',
        borderTop: '1px solid rgba(255,255,255,0.18)',
        borderBottom: '1px solid rgba(0,0,0,0.5)',
        pointerEvents: 'none',
      }} />
      {/* Value */}
      <span style={{
        position: 'relative',
        zIndex: 1,
        fontFamily: "'SF Mono', 'Roboto Mono', ui-monospace, 'Courier New', monospace",
        fontSize: 'clamp(1.38rem, 3vw, 2.05rem)',
        fontWeight: 900,
        letterSpacing: '0.02em',
        lineHeight: 1,
      }}>
        {formatted}
      </span>
      {/* Unit label */}
      <small style={{
        position: 'relative',
        zIndex: 1,
        color: '#c4d1ca',
        fontFamily: 'var(--font-body)',
        fontWeight: 600,
        fontSize: '14px',
        lineHeight: 1,
      }}>
        {unit}
      </small>
    </div>
  );
}
