import React, { useState } from 'react';

const colorsByDirection = {
  owe:     { iconBg: 'var(--color-amber-light)', amountColor: 'var(--color-amber)',  btnBg: 'var(--color-amber)',  btnColor: 'var(--color-deep-forest)', btnHover: 'var(--color-amber-hover)' },
  receive: { iconBg: 'var(--color-success-light)', amountColor: 'var(--color-leaf)', btnBg: 'var(--color-leaf)',   btnColor: '#fff',                     btnHover: 'var(--color-leaf-hover)' },
  settled: { iconBg: '#EAEFEC',                  amountColor: 'var(--text-muted)',  btnBg: null,                 btnColor: null,                       btnHover: null },
};

export function SettlementCard({ personName, amount, currency = 'kr', direction = 'owe', onAction }) {
  const [hovered, setHovered] = useState(false);
  const c = colorsByDirection[direction] || colorsByDirection.owe;

  const label = direction === 'settled'
    ? `Settled with ${personName}`
    : direction === 'owe'
      ? `You owe ${personName}`
      : `${personName} owes you`;

  const actionLabel = direction === 'owe' ? 'Request' : direction === 'receive' ? 'Mark paid' : null;

  const formatted = typeof amount === 'number'
    ? amount.toFixed(2).replace('.', ',')
    : String(amount);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '14px',
      background: 'var(--color-surface)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-card)',
    }}>
      {/* Avatar circle */}
      <div style={{
        width: '44px', height: '44px',
        borderRadius: '50%',
        background: c.iconBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-display)',
        fontWeight: 'var(--font-weight-bold)',
        fontSize: '15px',
        color: c.amountColor,
        flexShrink: 0,
        userSelect: 'none',
      }}>
        {(personName || '?').slice(0, 2).toUpperCase()}
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--font-body)',
          fontWeight: 'var(--font-weight-medium)',
          fontSize: '12px',
          color: 'var(--text-muted)',
          lineHeight: 1.3,
          marginBottom: '2px',
        }}>
          {label}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
          <span style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 'var(--font-weight-black)',
            fontSize: '22px',
            color: c.amountColor,
            lineHeight: 1,
            letterSpacing: '-0.02em',
          }}>
            {formatted}
          </span>
          <span style={{
            fontFamily: 'var(--font-body)',
            fontWeight: 'var(--font-weight-semibold)',
            fontSize: '14px',
            color: c.amountColor,
            opacity: 0.8,
          }}>
            {currency}
          </span>
        </div>
      </div>

      {/* Action */}
      {actionLabel && (
        <button
          onClick={onAction}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            padding: '8px 14px',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: hovered ? c.btnHover : c.btnBg,
            color: c.btnColor,
            fontFamily: 'var(--font-display)',
            fontWeight: 'var(--font-weight-bold)',
            fontSize: '13px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            transition: 'background 140ms ease',
            flexShrink: 0,
          }}
        >
          {actionLabel}
        </button>
      )}

      {direction === 'settled' && (
        <span style={{
          fontFamily: 'var(--font-body)',
          fontSize: '11px',
          color: 'var(--color-leaf)',
          flexShrink: 0,
          fontWeight: 'var(--font-weight-semibold)',
        }}>
          ✓ Settled
        </span>
      )}
    </div>
  );
}
