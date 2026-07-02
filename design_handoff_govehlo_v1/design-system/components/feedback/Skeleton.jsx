import React, { useEffect } from 'react';

let _injected = false;
function injectShimmer() {
  if (_injected) return;
  const s = document.createElement('style');
  s.textContent = '@keyframes gv-shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}';
  document.head.appendChild(s);
  _injected = true;
}

const PRESETS = {
  line:   { w: '100%', h: '14px', r: '6px' },
  title:  { w: '55%',  h: '20px', r: '6px' },
  circle: { w: '40px', h: '40px', r: '50%' },
  card:   { w: '100%', h: '80px', r: 'var(--radius-lg, 16px)' },
  button: { w: '120px', h: '44px', r: 'var(--radius-md, 12px)' },
};

/**
 * Skeleton — shimmer placeholder for loading content.
 * Compose multiples into a loading card, trip row, fuel row, etc.
 *
 * Uses the Mist palette (#D8F3DC → #EBF7EE shimmer) so loading
 * states feel on-brand rather than generic grey.
 */
export function Skeleton({
  variant = 'line',
  width,
  height,
  radius,
  count = 1,
  gap = 8,
  style: custom,
}) {
  useEffect(() => { injectShimmer(); }, []);

  const p = PRESETS[variant] || PRESETS.line;

  function block(i) {
    const isLastLine = variant === 'line' && count > 1 && i === count - 1;
    return (
      <div key={i} style={{
        width: isLastLine ? '65%' : (width || p.w),
        height: height || p.h,
        borderRadius: radius || p.r,
        background: 'linear-gradient(90deg, #D8F3DC 25%, #EBF7EE 50%, #D8F3DC 75%)',
        backgroundSize: '200% 100%',
        animation: 'gv-shimmer 1.6s ease-in-out infinite',
        animationDelay: (i * 0.12) + 's',
        flexShrink: 0,
        ...custom,
      }} />
    );
  }

  if (count <= 1) return block(0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: count }, (_, i) => block(i))}
    </div>
  );
}
