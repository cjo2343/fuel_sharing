import React, { useEffect } from 'react';

let _spinInjected = false;
function injectSpin() {
  if (_spinInjected) return;
  const s = document.createElement('style');
  s.textContent = '@keyframes gv-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(s);
  _spinInjected = true;
}

const SIZE_MAP = {
  sm: 16,
  md: 24,
  lg: 32,
};

const COLOR_MAP = {
  forest: 'var(--color-forest, #2D6A4F)',
  white:  '#FFFFFF',
  muted:  'var(--text-muted, #6B8F7A)',
  amber:  'var(--color-amber, #F4A261)',
};

/**
 * Spinner — circular loading indicator.
 * Use for in-progress actions (saving, syncing, requesting).
 * Pair with a label for accessibility.
 */
export function Spinner({
  size = 'md',
  color = 'forest',
  label,
  style: custom,
}) {
  useEffect(() => { injectSpin(); }, []);

  const px = SIZE_MAP[size] || SIZE_MAP.md;
  const c  = COLOR_MAP[color] || color;
  const stroke = px <= 16 ? 2.5 : 2;

  return (
    <span
      role="status"
      aria-label={label || 'Loading'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        ...custom,
      }}
    >
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        fill="none"
        style={{
          animation: 'gv-spin 0.8s linear infinite',
          flexShrink: 0,
        }}
      >
        <circle
          cx="12" cy="12" r="10"
          stroke={c}
          strokeWidth={stroke}
          strokeLinecap="round"
          opacity="0.2"
        />
        <path
          d="M12 2a10 10 0 0 1 10 10"
          stroke={c}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      </svg>
      {label && (
        <span style={{
          fontFamily: 'var(--font-body, Inter, sans-serif)',
          fontSize: px <= 16 ? '12px' : '13px',
          fontWeight: 500,
          color: 'var(--text-secondary, #3D5C48)',
        }}>
          {label}
        </span>
      )}
    </span>
  );
}
