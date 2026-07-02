import React, { useState } from 'react';

export function TripCard({ date, startOdo, endOdo, driver, cost, onClick }) {
  const [hovered, setHovered] = useState(false);
  const km = (endOdo != null && startOdo != null) ? endOdo - startOdo : null;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '12px',
        background: 'var(--color-surface)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: hovered ? 'var(--shadow-card-hover)' : 'var(--shadow-card)',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 180ms ease, transform 120ms ease',
        transform: hovered && onClick ? 'translateY(-1px)' : 'none',
      }}
    >
      {/* Icon */}
      <div style={{
        width: '40px', height: '40px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-mist)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        fontSize: '20px',
      }}>
        🚗
      </div>

      {/* Trip info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 'var(--font-weight-bold)',
          fontSize: 'var(--text-body-size)',
          color: 'var(--text-primary)',
          marginBottom: '2px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {driver || 'Trip'}
        </div>
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-mono-size)',
          color: 'var(--text-muted)',
          letterSpacing: 'var(--text-mono-letter-spacing)',
        }}>
          {startOdo != null ? startOdo.toLocaleString('da-DK') : '—'}
          {' → '}
          {endOdo != null ? endOdo.toLocaleString('da-DK') : '—'}
          {km != null ? ` · ${km} km` : ''}
        </div>
      </div>

      {/* Cost + date */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{
          fontFamily: 'var(--font-body)',
          fontWeight: 'var(--font-weight-semibold)',
          fontSize: '14px',
          color: cost != null ? 'var(--color-amber)' : 'var(--text-muted)',
          lineHeight: 1.2,
        }}>
          {cost != null
            ? `${typeof cost === 'number' ? cost.toFixed(2).replace('.', ',') : cost} kr`
            : '—'}
        </div>
        <div style={{
          fontFamily: 'var(--font-body)',
          fontSize: '11px',
          color: 'var(--text-muted)',
          marginTop: '2px',
        }}>
          {date || ''}
        </div>
      </div>
    </div>
  );
}
