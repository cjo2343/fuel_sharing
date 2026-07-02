import React from 'react';

/**
 * ParticipantSelector — checkbox grid for selecting trip participants.
 * Use in Log → Trip (Split between) and Book → Estimate (People joining).
 */
export function ParticipantSelector({ participants = [], selected = [], onChange }) {
  const toggle = (id) => {
    const next = selected.includes(id)
      ? selected.filter(s => s !== id)
      : [...selected, id];
    onChange && onChange(next);
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(136px, 1fr))',
      gap: '8px',
    }}>
      {participants.map(p => {
        const id   = typeof p === 'object' ? (p.id   || p.name) : p;
        const name = typeof p === 'object' ? (p.name || p.id)   : p;
        const isOn = selected.includes(id);

        return (
          <button
            key={id}
            type="button"
            onClick={() => toggle(id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              minHeight: '44px',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              border: `1.5px solid ${isOn ? 'var(--color-forest)' : 'var(--border-color)'}`,
              background: isOn ? 'var(--color-mist)' : 'var(--color-surface)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontFamily: 'var(--font-body)',
              fontWeight: isOn ? 'var(--font-weight-semibold)' : 'var(--font-weight-regular)',
              fontSize: '14px',
              textAlign: 'left',
              transition: 'border-color 140ms ease, background 140ms ease',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {/* Checkbox indicator */}
            <span style={{
              width: '18px',
              height: '18px',
              flexShrink: 0,
              borderRadius: '4px',
              border: `2px solid ${isOn ? 'var(--color-forest)' : 'var(--border-color)'}`,
              background: isOn ? 'var(--color-forest)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'border-color 140ms ease, background 140ms ease',
            }}>
              {isOn && (
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path d="M1.5 4L3.83 6.5L8.5 1.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </span>
            <span style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
