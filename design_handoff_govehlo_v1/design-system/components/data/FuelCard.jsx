import React, { useState } from 'react';

function FuelIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 22V9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v13"/>
      <path d="M3 11h12"/>
      <path d="M17 5l2.5 2.5-2.5 2.5"/>
      <path d="M19.5 7.5v5a2 2 0 0 1-2 2"/>
    </svg>
  );
}

/**
 * FuelCard — fuel receipt log entry row.
 * Use in Log → Fuel and History → Settlement audit.
 * Shows payer, liters, kr/L rate, and total amount in amber.
 */
export function FuelCard({ date, paidBy, amountDkk, liters, station, fullTank, onEdit }) {
  const [hovered, setHovered] = useState(false);

  const rate = liters && amountDkk && liters > 0
    ? (amountDkk / liters).toFixed(2).replace('.', ',')
    : null;

  const fmtAmount = typeof amountDkk === 'number'
    ? amountDkk.toFixed(2).replace('.', ',')
    : null;

  const details = [
    liters != null ? `${liters.toFixed(1)} L` : null,
    rate ? `${rate} kr/L` : null,
    station || null,
  ].filter(Boolean).join(' · ');

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '12px 14px',
        background: 'var(--color-surface)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: hovered ? 'var(--shadow-card-hover)' : 'var(--shadow-card)',
        transition: 'box-shadow 180ms ease',
      }}
    >
      {/* Fuel icon badge */}
      <div style={{
        width: '40px',
        height: '40px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-amber-light)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        color: '#A0522D',
      }}>
        <FuelIcon />
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginBottom: '2px',
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 'var(--font-weight-bold)',
            fontSize: 'var(--text-body-size)',
            color: 'var(--text-primary)',
          }}>
            {paidBy || 'Fuel'}
          </span>
          {fullTank && (
            <span style={{
              fontFamily: 'var(--font-body)',
              fontSize: '10px',
              color: 'var(--color-leaf)',
              fontWeight: 'var(--font-weight-semibold)',
              background: 'var(--color-success-light)',
              borderRadius: 'var(--radius-full)',
              padding: '1px 7px',
              lineHeight: '16px',
            }}>
              Full tank
            </span>
          )}
        </div>
        {details && (
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-mono-size)',
            color: 'var(--text-muted)',
            letterSpacing: 'var(--text-mono-letter-spacing)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {details}
          </div>
        )}
      </div>

      {/* Amount + date + edit */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        {fmtAmount && (
          <div style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 'var(--font-weight-extrabold)',
            fontSize: '18px',
            color: 'var(--color-amber)',
            lineHeight: 1,
            letterSpacing: '-0.01em',
          }}>
            {fmtAmount} kr
          </div>
        )}
        {date && (
          <div style={{
            fontFamily: 'var(--font-body)',
            fontSize: '11px',
            color: 'var(--text-muted)',
            marginTop: '3px',
          }}>
            {date}
          </div>
        )}
        {onEdit && (
          <button
            onClick={onEdit}
            style={{
              marginTop: '4px',
              display: 'block',
              marginLeft: 'auto',
              fontFamily: 'var(--font-body)',
              fontSize: '11px',
              color: 'var(--color-forest)',
              fontWeight: 'var(--font-weight-semibold)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Edit
          </button>
        )}
      </div>
    </div>
  );
}
