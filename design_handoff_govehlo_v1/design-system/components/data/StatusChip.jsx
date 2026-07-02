import React from 'react';

const VARIANTS = {
  open:      { background: 'var(--color-amber-light)',   color: '#A0522D' },
  requested: { background: 'var(--color-blue-soft)',     color: 'var(--color-blue)' },
  paid:      { background: 'var(--color-success-light)', color: '#1A7A47' },
  pending:   { background: '#FEF3E0',                    color: '#B07A2A' },
};

const LABELS = {
  open:      'Open',
  requested: 'Requested',
  paid:      'Paid',
  pending:   'Pending',
};

/**
 * StatusChip — settlement payment status pill.
 * Use on SettlementCard, PeriodCard, and the Payments tab.
 *
 * The `requested` status uses --color-blue, which exists exclusively
 * for this payment-flow state. Do not use blue for other UI purposes.
 */
export function StatusChip({ status = 'open', label }) {
  const v = VARIANTS[status] || VARIANTS.open;
  const displayLabel = label || LABELS[status] || status;

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      minHeight: '22px',
      padding: '0 9px',
      borderRadius: 'var(--radius-full)',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-medium)',
      fontSize: '12px',
      lineHeight: 1,
      whiteSpace: 'nowrap',
      ...v,
    }}>
      {displayLabel}
    </span>
  );
}
