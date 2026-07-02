/* @ds-bundle: {"format":3,"namespace":"GoVehloDesignSystem_c5fd4e","components":[{"name":"Avatar","sourcePath":"components/core/Avatar.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"Odometer","sourcePath":"components/core/Odometer.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"AmountDisplay","sourcePath":"components/data/AmountDisplay.jsx"},{"name":"FuelCard","sourcePath":"components/data/FuelCard.jsx"},{"name":"SettlementCard","sourcePath":"components/data/SettlementCard.jsx"},{"name":"StatusChip","sourcePath":"components/data/StatusChip.jsx"},{"name":"SummaryBand","sourcePath":"components/data/SummaryBand.jsx"},{"name":"TripCard","sourcePath":"components/data/TripCard.jsx"},{"name":"EmptyState","sourcePath":"components/feedback/EmptyState.jsx"},{"name":"ErrorBanner","sourcePath":"components/feedback/ErrorBanner.jsx"},{"name":"Skeleton","sourcePath":"components/feedback/Skeleton.jsx"},{"name":"Spinner","sourcePath":"components/feedback/Spinner.jsx"},{"name":"Toast","sourcePath":"components/feedback/Toast.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"ParticipantSelector","sourcePath":"components/forms/ParticipantSelector.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"AppHeader","sourcePath":"components/navigation/AppHeader.jsx"},{"name":"BottomNav","sourcePath":"components/navigation/BottomNav.jsx"},{"name":"TabNav","sourcePath":"components/navigation/TabNav.jsx"}],"sourceHashes":{"components/core/Avatar.jsx":"703a3f065a64","components/core/Badge.jsx":"19b15ac5a461","components/core/Button.jsx":"c770ab3d48d1","components/core/Card.jsx":"b71726f69d85","components/core/Odometer.jsx":"2221e756b1ac","components/core/Tag.jsx":"181703d81971","components/data/AmountDisplay.jsx":"b05cd6b658cb","components/data/FuelCard.jsx":"d17af4e59d9e","components/data/SettlementCard.jsx":"14b1870fd9b5","components/data/StatusChip.jsx":"ed8c35779cf4","components/data/SummaryBand.jsx":"1b0cd9adf39c","components/data/TripCard.jsx":"b6a10f5e7ce0","components/feedback/EmptyState.jsx":"fa70b7a15d01","components/feedback/ErrorBanner.jsx":"2621c997adce","components/feedback/Skeleton.jsx":"c37170a0e624","components/feedback/Spinner.jsx":"e2f762f9b8d2","components/feedback/Toast.jsx":"6f76f6f34693","components/forms/Checkbox.jsx":"31dadb736afd","components/forms/Input.jsx":"493f5c37619b","components/forms/ParticipantSelector.jsx":"f8390fb14ebf","components/forms/Select.jsx":"9830bcd1a6e9","components/navigation/AppHeader.jsx":"1ae3611a9e83","components/navigation/BottomNav.jsx":"331a13d26fe9","components/navigation/TabNav.jsx":"7733eae6db9c"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.GoVehloDesignSystem_c5fd4e = window.GoVehloDesignSystem_c5fd4e || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Avatar.jsx
try { (() => {
const PALETTE = [{
  bg: 'var(--color-forest)',
  fg: '#fff'
}, {
  bg: 'var(--color-leaf)',
  fg: '#fff'
}, {
  bg: 'var(--color-amber)',
  fg: 'var(--color-deep-forest)'
}, {
  bg: '#A8D5BA',
  fg: 'var(--color-deep-forest)'
}, {
  bg: 'var(--color-deep-forest)',
  fg: '#fff'
}, {
  bg: '#7EC8A4',
  fg: '#fff'
}];
function colorFor(name) {
  if (!name) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
}
const pxMap = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 52,
  xl: 64
};
function Avatar({
  name,
  src,
  size = 'md',
  online
}) {
  const px = pxMap[size] || pxMap.md;
  const c = colorFor(name);
  const dotSize = Math.max(8, Math.round(px * 0.22));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      display: 'inline-flex',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: px,
      height: px,
      borderRadius: '50%',
      background: src ? 'transparent' : c.bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--font-weight-bold)',
      fontSize: Math.round(px * 0.38),
      color: c.fg,
      overflow: 'hidden',
      flexShrink: 0,
      userSelect: 'none'
    }
  }, src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: name,
    style: {
      width: '100%',
      height: '100%',
      objectFit: 'cover'
    }
  }) : initials(name)), online !== undefined && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      width: dotSize,
      height: dotSize,
      borderRadius: '50%',
      background: online ? 'var(--color-leaf)' : '#C0CCC5',
      border: '2px solid var(--color-warm-white)'
    }
  }));
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
const variantMap = {
  default: {
    background: 'var(--color-mist)',
    color: 'var(--color-forest)'
  },
  success: {
    background: 'var(--color-success-light)',
    color: '#1A7A47'
  },
  money: {
    background: 'var(--color-amber-light)',
    color: '#A0522D'
  },
  pending: {
    background: '#FEF3E0',
    color: '#B07A2A'
  },
  error: {
    background: 'var(--color-error-light)',
    color: 'var(--color-error)'
  },
  neutral: {
    background: '#EAEFEC',
    color: 'var(--text-muted)'
  },
  forest: {
    background: 'var(--color-forest)',
    color: '#fff'
  }
};
const sizeMap = {
  sm: {
    fontSize: '10px',
    padding: '2px 7px',
    height: '18px'
  },
  md: {
    fontSize: '12px',
    padding: '3px 9px',
    height: '22px'
  },
  lg: {
    fontSize: '13px',
    padding: '4px 11px',
    height: '26px'
  }
};
function Badge({
  variant = 'default',
  size = 'md',
  dot = false,
  children
}) {
  const v = variantMap[variant] || variantMap.default;
  const s = sizeMap[size] || sizeMap.md;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-medium)',
      fontSize: s.fontSize,
      height: s.height,
      padding: s.padding,
      borderRadius: 'var(--radius-full)',
      lineHeight: 1,
      whiteSpace: 'nowrap',
      ...v
    }
  }, dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: '5px',
      height: '5px',
      borderRadius: '50%',
      background: v.color,
      flexShrink: 0
    }
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
const {
  useState
} = React;
const sizeMap = {
  sm: {
    padding: '7px 14px',
    fontSize: '13px',
    minHeight: '32px',
    gap: '5px'
  },
  md: {
    padding: '11px 20px',
    fontSize: '15px',
    minHeight: '44px',
    gap: '6px'
  },
  lg: {
    padding: '15px 28px',
    fontSize: '17px',
    minHeight: '52px',
    gap: '7px'
  }
};
const variantStyles = {
  primary: {
    background: 'var(--color-forest)',
    color: '#fff',
    boxShadow: 'var(--shadow-btn)',
    border: 'none'
  },
  secondary: {
    background: 'var(--color-mist)',
    color: 'var(--color-forest)',
    boxShadow: 'none',
    border: 'none'
  },
  ghost: {
    background: 'transparent',
    color: 'var(--color-forest)',
    boxShadow: 'none',
    border: 'none'
  },
  outline: {
    background: 'transparent',
    color: 'var(--color-forest)',
    boxShadow: 'none',
    border: '1.5px solid var(--color-forest)'
  },
  amber: {
    background: 'var(--color-amber)',
    color: 'var(--color-deep-forest)',
    boxShadow: 'var(--shadow-btn-amber)',
    border: 'none'
  },
  danger: {
    background: 'var(--color-error-light)',
    color: 'var(--color-error)',
    boxShadow: 'none',
    border: 'none'
  }
};
const hoverStyles = {
  primary: {
    background: 'var(--color-forest-hover)'
  },
  secondary: {
    background: '#C5E5CE'
  },
  ghost: {
    background: 'var(--color-mist)'
  },
  outline: {
    background: 'var(--color-mist)'
  },
  amber: {
    background: 'var(--color-amber-hover)'
  },
  danger: {
    background: '#F9C8C8'
  }
};
function Button({
  variant = 'primary',
  size = 'md',
  disabled = false,
  onClick,
  children,
  icon,
  fullWidth = false,
  type = 'button'
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const s = sizeMap[size] || sizeMap.md;
  const v = variantStyles[variant] || variantStyles.primary;
  const h = hoverStyles[variant] || {};
  return /*#__PURE__*/React.createElement("button", {
    type: type,
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => {
      setHovered(false);
      setPressed(false);
    },
    onMouseDown: () => setPressed(true),
    onMouseUp: () => setPressed(false),
    style: {
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
      ...(hovered && !disabled && !pressed ? h : {})
    }
  }, icon && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center'
    }
  }, icon), children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
const {
  useState
} = React;
const paddingMap = {
  none: '0',
  sm: '10px',
  md: 'var(--card-padding)',
  lg: '20px',
  xl: '24px'
};
function Card({
  children,
  padding = 'md',
  elevated = false,
  tinted = false,
  onClick,
  style: customStyle
}) {
  const [hovered, setHovered] = useState(false);
  const isClickable = !!onClick;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    onMouseEnter: isClickable ? () => setHovered(true) : undefined,
    onMouseLeave: isClickable ? () => setHovered(false) : undefined,
    style: {
      background: tinted ? 'var(--color-mist)' : 'var(--color-surface)',
      borderRadius: 'var(--radius-lg)',
      padding: paddingMap[padding] || paddingMap.md,
      boxShadow: elevated ? 'var(--shadow-elevated)' : hovered && isClickable ? 'var(--shadow-card-hover)' : 'var(--shadow-card)',
      cursor: isClickable ? 'pointer' : 'default',
      transition: 'box-shadow 200ms ease, transform 150ms ease',
      transform: hovered && isClickable ? 'translateY(-1px)' : 'none',
      ...customStyle
    }
  }, children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Odometer.jsx
try { (() => {
/**
 * Odometer — GoVehlo km counter display.
 * Styled as a dark instrument panel. Used in the app header to show
 * total kilometres logged in the current settlement period.
 */
function Odometer({
  value = 0,
  unit = 'km'
}) {
  const formatted = typeof value === 'number' ? value.toLocaleString('da-DK') : String(value);
  return /*#__PURE__*/React.createElement("div", {
    role: "meter",
    "aria-label": `${formatted} ${unit}`,
    style: {
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
      userSelect: 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: 'repeating-linear-gradient(90deg, transparent 0px 22px, rgba(255,255,255,0.06) 22px 24px)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: '10px 14px',
      borderTop: '1px solid rgba(255,255,255,0.18)',
      borderBottom: '1px solid rgba(0,0,0,0.5)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'relative',
      zIndex: 1,
      fontFamily: "'SF Mono', 'Roboto Mono', ui-monospace, 'Courier New', monospace",
      fontSize: 'clamp(1.38rem, 3vw, 2.05rem)',
      fontWeight: 900,
      letterSpacing: '0.02em',
      lineHeight: 1
    }
  }, formatted), /*#__PURE__*/React.createElement("small", {
    style: {
      position: 'relative',
      zIndex: 1,
      color: '#c4d1ca',
      fontFamily: 'var(--font-body)',
      fontWeight: 600,
      fontSize: '14px',
      lineHeight: 1
    }
  }, unit));
}
Object.assign(__ds_scope, { Odometer });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Odometer.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
const colorMap = {
  default: {
    background: 'var(--color-mist)',
    color: 'var(--color-forest)'
  },
  amber: {
    background: 'var(--color-amber-light)',
    color: '#A0522D'
  },
  leaf: {
    background: 'var(--color-success-light)',
    color: '#1A7A47'
  },
  neutral: {
    background: '#EAEFEC',
    color: 'var(--text-muted)'
  }
};
function Tag({
  label,
  color = 'default',
  onRemove
}) {
  const c = colorMap[color] || colorMap.default;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '4px 10px',
      borderRadius: 'var(--radius-full)',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-medium)',
      fontSize: '12px',
      lineHeight: 1,
      whiteSpace: 'nowrap',
      ...c
    }
  }, label, onRemove && /*#__PURE__*/React.createElement("button", {
    onClick: onRemove,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '14px',
      height: '14px',
      borderRadius: '50%',
      border: 'none',
      background: 'rgba(0,0,0,0.1)',
      color: 'inherit',
      cursor: 'pointer',
      padding: 0,
      fontSize: '10px',
      lineHeight: 1,
      marginLeft: '1px'
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/data/AmountDisplay.jsx
try { (() => {
const sizeMap = {
  sm: {
    amount: '20px',
    currency: '13px',
    label: '11px'
  },
  md: {
    amount: '28px',
    currency: '16px',
    label: '12px'
  },
  lg: {
    amount: '40px',
    currency: '20px',
    label: '13px'
  },
  xl: {
    amount: '52px',
    currency: '24px',
    label: '14px'
  }
};
const directionColor = {
  owe: 'var(--color-amber)',
  receive: 'var(--color-leaf)',
  settled: 'var(--text-muted)'
};
function AmountDisplay({
  amount,
  currency = 'kr',
  direction = 'owe',
  label,
  size = 'lg'
}) {
  const s = sizeMap[size] || sizeMap.lg;
  const color = directionColor[direction] || directionColor.owe;
  const formatted = typeof amount === 'number' ? amount.toFixed(2).replace('.', ',') : String(amount);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '2px'
    }
  }, label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-medium)',
      fontSize: s.label,
      color: 'var(--text-muted)',
      lineHeight: 1.3
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: '4px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--font-weight-black)',
      fontSize: s.amount,
      color,
      lineHeight: 1,
      letterSpacing: '-0.02em'
    }
  }, formatted), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-semibold)',
      fontSize: s.currency,
      color,
      lineHeight: 1,
      opacity: 0.8
    }
  }, currency)));
}
Object.assign(__ds_scope, { AmountDisplay });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/AmountDisplay.jsx", error: String((e && e.message) || e) }); }

// components/data/FuelCard.jsx
try { (() => {
const {
  useState
} = React;
function FuelIcon() {
  return /*#__PURE__*/React.createElement("svg", {
    width: "20",
    height: "20",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M3 22V9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v13"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 11h12"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M17 5l2.5 2.5-2.5 2.5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19.5 7.5v5a2 2 0 0 1-2 2"
  }));
}

/**
 * FuelCard — fuel receipt log entry row.
 * Use in Log → Fuel and History → Settlement audit.
 * Shows payer, liters, kr/L rate, and total amount in amber.
 */
function FuelCard({
  date,
  paidBy,
  amountDkk,
  liters,
  station,
  fullTank,
  onEdit
}) {
  const [hovered, setHovered] = useState(false);
  const rate = liters && amountDkk && liters > 0 ? (amountDkk / liters).toFixed(2).replace('.', ',') : null;
  const fmtAmount = typeof amountDkk === 'number' ? amountDkk.toFixed(2).replace('.', ',') : null;
  const details = [liters != null ? `${liters.toFixed(1)} L` : null, rate ? `${rate} kr/L` : null, station || null].filter(Boolean).join(' · ');
  return /*#__PURE__*/React.createElement("div", {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '12px 14px',
      background: 'var(--color-surface)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: hovered ? 'var(--shadow-card-hover)' : 'var(--shadow-card)',
      transition: 'box-shadow 180ms ease'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '40px',
      height: '40px',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--color-amber-light)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      color: '#A0522D'
    }
  }, /*#__PURE__*/React.createElement(FuelIcon, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      marginBottom: '2px',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--font-weight-bold)',
      fontSize: 'var(--text-body-size)',
      color: 'var(--text-primary)'
    }
  }, paidBy || 'Fuel'), fullTank && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '10px',
      color: 'var(--color-leaf)',
      fontWeight: 'var(--font-weight-semibold)',
      background: 'var(--color-success-light)',
      borderRadius: 'var(--radius-full)',
      padding: '1px 7px',
      lineHeight: '16px'
    }
  }, "Full tank")), details && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-mono-size)',
      color: 'var(--text-muted)',
      letterSpacing: 'var(--text-mono-letter-spacing)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, details)), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'right',
      flexShrink: 0
    }
  }, fmtAmount && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--font-weight-extrabold)',
      fontSize: '18px',
      color: 'var(--color-amber)',
      lineHeight: 1,
      letterSpacing: '-0.01em'
    }
  }, fmtAmount, " kr"), date && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '11px',
      color: 'var(--text-muted)',
      marginTop: '3px'
    }
  }, date), onEdit && /*#__PURE__*/React.createElement("button", {
    onClick: onEdit,
    style: {
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
      padding: 0
    }
  }, "Edit")));
}
Object.assign(__ds_scope, { FuelCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/FuelCard.jsx", error: String((e && e.message) || e) }); }

// components/data/SettlementCard.jsx
try { (() => {
const {
  useState
} = React;
const colorsByDirection = {
  owe: {
    iconBg: 'var(--color-amber-light)',
    amountColor: 'var(--color-amber)',
    btnBg: 'var(--color-amber)',
    btnColor: 'var(--color-deep-forest)',
    btnHover: 'var(--color-amber-hover)'
  },
  receive: {
    iconBg: 'var(--color-success-light)',
    amountColor: 'var(--color-leaf)',
    btnBg: 'var(--color-leaf)',
    btnColor: '#fff',
    btnHover: 'var(--color-leaf-hover)'
  },
  settled: {
    iconBg: '#EAEFEC',
    amountColor: 'var(--text-muted)',
    btnBg: null,
    btnColor: null,
    btnHover: null
  }
};
function SettlementCard({
  personName,
  amount,
  currency = 'kr',
  direction = 'owe',
  onAction
}) {
  const [hovered, setHovered] = useState(false);
  const c = colorsByDirection[direction] || colorsByDirection.owe;
  const label = direction === 'settled' ? `Settled with ${personName}` : direction === 'owe' ? `You owe ${personName}` : `${personName} owes you`;
  const actionLabel = direction === 'owe' ? 'Request' : direction === 'receive' ? 'Mark paid' : null;
  const formatted = typeof amount === 'number' ? amount.toFixed(2).replace('.', ',') : String(amount);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '14px',
      background: 'var(--color-surface)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-card)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '44px',
      height: '44px',
      borderRadius: '50%',
      background: c.iconBg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--font-weight-bold)',
      fontSize: '15px',
      color: c.amountColor,
      flexShrink: 0,
      userSelect: 'none'
    }
  }, (personName || '?').slice(0, 2).toUpperCase()), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-medium)',
      fontSize: '12px',
      color: 'var(--text-muted)',
      lineHeight: 1.3,
      marginBottom: '2px'
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: '3px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--font-weight-black)',
      fontSize: '22px',
      color: c.amountColor,
      lineHeight: 1,
      letterSpacing: '-0.02em'
    }
  }, formatted), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-semibold)',
      fontSize: '14px',
      color: c.amountColor,
      opacity: 0.8
    }
  }, currency))), actionLabel && /*#__PURE__*/React.createElement("button", {
    onClick: onAction,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    style: {
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
      flexShrink: 0
    }
  }, actionLabel), direction === 'settled' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '11px',
      color: 'var(--color-leaf)',
      flexShrink: 0,
      fontWeight: 'var(--font-weight-semibold)'
    }
  }, "\u2713 Settled"));
}
Object.assign(__ds_scope, { SettlementCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/SettlementCard.jsx", error: String((e && e.message) || e) }); }

// components/data/StatusChip.jsx
try { (() => {
const VARIANTS = {
  open: {
    background: 'var(--color-amber-light)',
    color: '#A0522D'
  },
  requested: {
    background: 'var(--color-blue-soft)',
    color: 'var(--color-blue)'
  },
  paid: {
    background: 'var(--color-success-light)',
    color: '#1A7A47'
  },
  pending: {
    background: '#FEF3E0',
    color: '#B07A2A'
  }
};
const LABELS = {
  open: 'Open',
  requested: 'Requested',
  paid: 'Paid',
  pending: 'Pending'
};

/**
 * StatusChip — settlement payment status pill.
 * Use on SettlementCard, PeriodCard, and the Payments tab.
 *
 * The `requested` status uses --color-blue, which exists exclusively
 * for this payment-flow state. Do not use blue for other UI purposes.
 */
function StatusChip({
  status = 'open',
  label
}) {
  const v = VARIANTS[status] || VARIANTS.open;
  const displayLabel = label || LABELS[status] || status;
  return /*#__PURE__*/React.createElement("span", {
    style: {
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
      ...v
    }
  }, displayLabel);
}
Object.assign(__ds_scope, { StatusChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/StatusChip.jsx", error: String((e && e.message) || e) }); }

// components/data/SummaryBand.jsx
try { (() => {
/**
 * SummaryBand — row of dark stat tiles.
 * Used at the top of the Settle screen to show period-level numbers
 * (fuel rate, trip total, fuel paid). Typically 3 items.
 */
function SummaryBand({
  items = []
}) {
  const count = Math.max(1, items.length);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
      gap: '12px'
    }
  }, items.map((item, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      minHeight: '104px',
      border: '1px solid rgba(22, 32, 31, 0.12)',
      borderRadius: 'var(--radius-lg)',
      background: 'radial-gradient(circle at top right, rgba(47, 125, 99, 0.22), transparent 60%), var(--color-deep-forest)',
      color: '#fff',
      padding: '18px',
      display: 'grid',
      alignContent: 'space-between',
      boxShadow: 'var(--shadow-card)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 500,
      fontSize: '13px',
      color: '#c9d5d1',
      lineHeight: 1.3
    }
  }, item.label), /*#__PURE__*/React.createElement("strong", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 900,
      fontSize: 'clamp(1.4rem, 4vw, 2.4rem)',
      letterSpacing: '-0.04em',
      lineHeight: 1.05,
      overflowWrap: 'anywhere',
      color: '#fff'
    }
  }, item.value))));
}
Object.assign(__ds_scope, { SummaryBand });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/SummaryBand.jsx", error: String((e && e.message) || e) }); }

// components/data/TripCard.jsx
try { (() => {
const {
  useState
} = React;
function TripCard({
  date,
  startOdo,
  endOdo,
  driver,
  cost,
  onClick
}) {
  const [hovered, setHovered] = useState(false);
  const km = endOdo != null && startOdo != null ? endOdo - startOdo : null;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '12px',
      background: 'var(--color-surface)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: hovered ? 'var(--shadow-card-hover)' : 'var(--shadow-card)',
      cursor: onClick ? 'pointer' : 'default',
      transition: 'box-shadow 180ms ease, transform 120ms ease',
      transform: hovered && onClick ? 'translateY(-1px)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '40px',
      height: '40px',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--color-mist)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      fontSize: '20px'
    }
  }, "\uD83D\uDE97"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--font-weight-bold)',
      fontSize: 'var(--text-body-size)',
      color: 'var(--text-primary)',
      marginBottom: '2px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, driver || 'Trip'), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-mono-size)',
      color: 'var(--text-muted)',
      letterSpacing: 'var(--text-mono-letter-spacing)'
    }
  }, startOdo != null ? startOdo.toLocaleString('da-DK') : '—', ' → ', endOdo != null ? endOdo.toLocaleString('da-DK') : '—', km != null ? ` · ${km} km` : '')), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'right',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-semibold)',
      fontSize: '14px',
      color: cost != null ? 'var(--color-amber)' : 'var(--text-muted)',
      lineHeight: 1.2
    }
  }, cost != null ? `${typeof cost === 'number' ? cost.toFixed(2).replace('.', ',') : cost} kr` : '—'), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '11px',
      color: 'var(--text-muted)',
      marginTop: '2px'
    }
  }, date || '')));
}
Object.assign(__ds_scope, { TripCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/TripCard.jsx", error: String((e && e.message) || e) }); }

// components/feedback/EmptyState.jsx
try { (() => {
/**
 * EmptyState — placeholder for sections with no data.
 * Use when a list, table, or card group has zero items.
 *
 * Voice guideline: encouraging and direct.
 * "No trips yet" not "No data available."
 * "Log your first trip" not "Create new entry."
 */
function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      padding: compact ? '24px 20px' : '40px 24px',
      gap: compact ? 8 : 12
    }
  }, icon && /*#__PURE__*/React.createElement("div", {
    style: {
      width: compact ? 40 : 52,
      height: compact ? 40 : 52,
      borderRadius: '50%',
      background: '#D8F3DC',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: compact ? 0 : 4
    }
  }, typeof icon === 'string' ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: compact ? 18 : 22,
      color: '#2D6A4F',
      lineHeight: 1
    }
  }, icon) : icon), title && /*#__PURE__*/React.createElement("h3", {
    style: {
      fontFamily: 'var(--font-display, Nunito, sans-serif)',
      fontWeight: 700,
      fontSize: compact ? '15px' : '17px',
      color: 'var(--text-primary, #1A2E1F)',
      margin: 0,
      lineHeight: 1.3
    }
  }, title), description && /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body, Inter, sans-serif)',
      fontSize: compact ? '12px' : '13px',
      color: 'var(--text-muted, #6B8F7A)',
      margin: 0,
      lineHeight: 1.5,
      maxWidth: 260
    }
  }, description), action && /*#__PURE__*/React.createElement("button", {
    onClick: action.onClick,
    style: {
      marginTop: compact ? 4 : 8,
      fontFamily: 'var(--font-display, Nunito, sans-serif)',
      fontWeight: 700,
      fontSize: '14px',
      color: '#FFFFFF',
      background: 'var(--color-forest, #2D6A4F)',
      border: 'none',
      borderRadius: 'var(--radius-md, 12px)',
      padding: '10px 20px',
      cursor: 'pointer',
      minHeight: '44px'
    }
  }, action.label));
}
Object.assign(__ds_scope, { EmptyState });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/EmptyState.jsx", error: String((e && e.message) || e) }); }

// components/feedback/ErrorBanner.jsx
try { (() => {
const VARIANTS = {
  error: {
    background: '#FDEDED',
    borderColor: '#D95050',
    color: '#D95050',
    textColor: '#8B2E2E',
    icon: '!'
  },
  warning: {
    background: '#FDE8D8',
    borderColor: '#F4A261',
    color: '#F4A261',
    textColor: '#7D4A1A',
    icon: '!'
  },
  offline: {
    background: '#EAEFEC',
    borderColor: '#6B8F7A',
    color: '#6B8F7A',
    textColor: '#3D5C48',
    icon: '↯'
  }
};

/**
 * ErrorBanner — persistent inline banner for errors, warnings, and offline state.
 *
 * Unlike Toast (transient), ErrorBanner stays visible until the condition clears.
 * Use for: network failures, sync conflicts, offline mode, validation summaries.
 *
 * Voice guideline: say what happened and what the user can do.
 * "Connection lost. Your changes are saved locally." not "Error 503."
 */
function ErrorBanner({
  message,
  variant = 'error',
  onRetry,
  onDismiss,
  children
}) {
  const v = VARIANTS[variant] || VARIANTS.error;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '12px 14px',
      background: v.background,
      borderRadius: 'var(--radius-md, 12px)',
      borderLeft: '3px solid ' + v.borderColor
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 20,
      height: 20,
      borderRadius: '50%',
      background: v.borderColor,
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 10,
      fontWeight: 800,
      flexShrink: 0,
      marginTop: 1
    }
  }, v.icon), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body, Inter, sans-serif)',
      fontSize: '13px',
      fontWeight: 500,
      color: v.textColor,
      margin: 0,
      lineHeight: 1.45
    }
  }, message), children, onRetry && /*#__PURE__*/React.createElement("button", {
    onClick: onRetry,
    style: {
      marginTop: 8,
      fontFamily: 'var(--font-body, Inter, sans-serif)',
      fontSize: '12px',
      fontWeight: 600,
      color: v.borderColor,
      background: 'none',
      border: 'none',
      padding: 0,
      cursor: 'pointer',
      textDecoration: 'underline',
      textDecorationColor: 'transparent',
      transition: 'text-decoration-color 140ms ease'
    },
    onMouseEnter: e => e.target.style.textDecorationColor = v.borderColor,
    onMouseLeave: e => e.target.style.textDecorationColor = 'transparent'
  }, "Retry")), onDismiss && /*#__PURE__*/React.createElement("button", {
    onClick: onDismiss,
    style: {
      background: 'none',
      border: 'none',
      color: v.color,
      cursor: 'pointer',
      padding: 2,
      fontSize: 16,
      lineHeight: 1,
      opacity: 0.6,
      flexShrink: 0
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { ErrorBanner });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/ErrorBanner.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Skeleton.jsx
try { (() => {
const {
  useEffect
} = React;
let _injected = false;
function injectShimmer() {
  if (_injected) return;
  const s = document.createElement('style');
  s.textContent = '@keyframes gv-shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}';
  document.head.appendChild(s);
  _injected = true;
}
const PRESETS = {
  line: {
    w: '100%',
    h: '14px',
    r: '6px'
  },
  title: {
    w: '55%',
    h: '20px',
    r: '6px'
  },
  circle: {
    w: '40px',
    h: '40px',
    r: '50%'
  },
  card: {
    w: '100%',
    h: '80px',
    r: 'var(--radius-lg, 16px)'
  },
  button: {
    w: '120px',
    h: '44px',
    r: 'var(--radius-md, 12px)'
  }
};

/**
 * Skeleton — shimmer placeholder for loading content.
 * Compose multiples into a loading card, trip row, fuel row, etc.
 *
 * Uses the Mist palette (#D8F3DC → #EBF7EE shimmer) so loading
 * states feel on-brand rather than generic grey.
 */
function Skeleton({
  variant = 'line',
  width,
  height,
  radius,
  count = 1,
  gap = 8,
  style: custom
}) {
  useEffect(() => {
    injectShimmer();
  }, []);
  const p = PRESETS[variant] || PRESETS.line;
  function block(i) {
    const isLastLine = variant === 'line' && count > 1 && i === count - 1;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        width: isLastLine ? '65%' : width || p.w,
        height: height || p.h,
        borderRadius: radius || p.r,
        background: 'linear-gradient(90deg, #D8F3DC 25%, #EBF7EE 50%, #D8F3DC 75%)',
        backgroundSize: '200% 100%',
        animation: 'gv-shimmer 1.6s ease-in-out infinite',
        animationDelay: i * 0.12 + 's',
        flexShrink: 0,
        ...custom
      }
    });
  }
  if (count <= 1) return block(0);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap
    }
  }, Array.from({
    length: count
  }, (_, i) => block(i)));
}
Object.assign(__ds_scope, { Skeleton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Skeleton.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Spinner.jsx
try { (() => {
const {
  useEffect
} = React;
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
  lg: 32
};
const COLOR_MAP = {
  forest: 'var(--color-forest, #2D6A4F)',
  white: '#FFFFFF',
  muted: 'var(--text-muted, #6B8F7A)',
  amber: 'var(--color-amber, #F4A261)'
};

/**
 * Spinner — circular loading indicator.
 * Use for in-progress actions (saving, syncing, requesting).
 * Pair with a label for accessibility.
 */
function Spinner({
  size = 'md',
  color = 'forest',
  label,
  style: custom
}) {
  useEffect(() => {
    injectSpin();
  }, []);
  const px = SIZE_MAP[size] || SIZE_MAP.md;
  const c = COLOR_MAP[color] || color;
  const stroke = px <= 16 ? 2.5 : 2;
  return /*#__PURE__*/React.createElement("span", {
    role: "status",
    "aria-label": label || 'Loading',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      ...custom
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: px,
    height: px,
    viewBox: "0 0 24 24",
    fill: "none",
    style: {
      animation: 'gv-spin 0.8s linear infinite',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10",
    stroke: c,
    strokeWidth: stroke,
    strokeLinecap: "round",
    opacity: "0.2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 2a10 10 0 0 1 10 10",
    stroke: c,
    strokeWidth: stroke,
    strokeLinecap: "round"
  })), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body, Inter, sans-serif)',
      fontSize: px <= 16 ? '12px' : '13px',
      fontWeight: 500,
      color: 'var(--text-secondary, #3D5C48)'
    }
  }, label));
}
Object.assign(__ds_scope, { Spinner });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Spinner.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
const variantMap = {
  default: {
    background: 'var(--color-deep-forest)',
    color: '#fff',
    icon: '✓'
  },
  success: {
    background: 'var(--color-forest)',
    color: '#fff',
    icon: '✓'
  },
  money: {
    background: 'var(--color-amber)',
    color: 'var(--color-deep-forest)',
    icon: '↗'
  },
  error: {
    background: '#C0392B',
    color: '#fff',
    icon: '!'
  },
  info: {
    background: '#2B5797',
    color: '#fff',
    icon: 'i'
  }
};
function Toast({
  message,
  variant = 'default',
  visible = true,
  onDismiss
}) {
  if (!visible) return null;
  const v = variantMap[variant] || variantMap.default;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '10px',
      padding: '12px 16px',
      borderRadius: 'var(--radius-md)',
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--text-body-size)',
      fontWeight: 'var(--font-weight-medium)',
      maxWidth: '360px',
      boxShadow: 'var(--shadow-elevated)',
      background: v.background,
      color: v.color
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: '20px',
      height: '20px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.18)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '10px',
      fontWeight: 700,
      flexShrink: 0
    }
  }, v.icon), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }, message), onDismiss && /*#__PURE__*/React.createElement("button", {
    onClick: onDismiss,
    style: {
      background: 'none',
      border: 'none',
      color: 'inherit',
      opacity: 0.65,
      cursor: 'pointer',
      padding: '2px',
      display: 'flex',
      alignItems: 'center',
      fontSize: '18px',
      lineHeight: 1
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
/**
 * Checkbox — single labeled checkbox.
 * 44px touch target, custom indicator styled with DS tokens.
 * Use for binary toggles: "Filled to full tank", settings flags, etc.
 */
function Checkbox({
  label,
  checked = false,
  onChange,
  hint,
  disabled = false,
  id
}) {
  const checkId = id || `gv-cb-${Math.random().toString(36).slice(2, 7)}`;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '3px'
    }
  }, /*#__PURE__*/React.createElement("label", {
    htmlFor: checkId,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      minHeight: '44px',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      userSelect: 'none'
    }
  }, /*#__PURE__*/React.createElement("input", {
    id: checkId,
    type: "checkbox",
    checked: checked,
    onChange: onChange,
    disabled: disabled,
    style: {
      position: 'absolute',
      opacity: 0,
      width: 0,
      height: 0,
      margin: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: '20px',
      height: '20px',
      flexShrink: 0,
      borderRadius: '5px',
      border: `2px solid ${checked ? 'var(--color-forest)' : 'var(--border-color)'}`,
      background: checked ? 'var(--color-forest)' : 'var(--color-surface)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'border-color 140ms ease, background 140ms ease'
    }
  }, checked && /*#__PURE__*/React.createElement("svg", {
    width: "11",
    height: "9",
    viewBox: "0 0 11 9",
    fill: "none"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M1.5 4.5L4.17 7.5L9.5 1.5",
    stroke: "#fff",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }))), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-medium)',
      fontSize: 'var(--text-body-size)',
      color: 'var(--text-primary)',
      lineHeight: 1.4,
      flex: 1
    }
  }, label)), hint && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '0 0 0 30px',
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--text-caption-size)',
      color: 'var(--text-muted)',
      lineHeight: 1.4
    }
  }, hint));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
const {
  useState
} = React;
function Input({
  label,
  type = 'text',
  placeholder,
  value,
  onChange,
  prefix,
  suffix,
  hint,
  error,
  disabled = false,
  id
}) {
  const [focused, setFocused] = useState(false);
  const inputId = id || `gv-input-${Math.random().toString(36).slice(2, 7)}`;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '5px',
      width: '100%'
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: inputId,
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-medium)',
      fontSize: 'var(--text-label-size)',
      color: 'var(--text-secondary)',
      lineHeight: 1.4
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '0 14px',
      height: '48px',
      background: disabled ? '#F4F6F5' : 'var(--color-surface)',
      borderRadius: 'var(--radius-md)',
      border: `1.5px solid ${error ? 'var(--color-error)' : focused ? 'var(--color-forest)' : 'var(--border-color)'}`,
      boxShadow: focused ? 'var(--shadow-focus)' : 'none',
      transition: 'border-color 150ms ease, box-shadow 150ms ease'
    }
  }, prefix && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)',
      fontFamily: 'var(--font-body)',
      fontSize: '15px',
      flexShrink: 0
    }
  }, prefix), /*#__PURE__*/React.createElement("input", {
    id: inputId,
    type: type,
    placeholder: placeholder,
    value: value,
    onChange: onChange,
    disabled: disabled,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    style: {
      flex: 1,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--text-body-size)',
      fontWeight: 'var(--font-weight-regular)',
      color: 'var(--text-primary)',
      height: '100%',
      minWidth: 0
    }
  }), suffix && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)',
      fontFamily: 'var(--font-body)',
      fontSize: '15px',
      flexShrink: 0
    }
  }, suffix)), (hint || error) && /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--text-caption-size)',
      color: error ? 'var(--color-error)' : 'var(--text-muted)',
      margin: 0,
      lineHeight: 1.4
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/ParticipantSelector.jsx
try { (() => {
/**
 * ParticipantSelector — checkbox grid for selecting trip participants.
 * Use in Log → Trip (Split between) and Book → Estimate (People joining).
 */
function ParticipantSelector({
  participants = [],
  selected = [],
  onChange
}) {
  const toggle = id => {
    const next = selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id];
    onChange && onChange(next);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(136px, 1fr))',
      gap: '8px'
    }
  }, participants.map(p => {
    const id = typeof p === 'object' ? p.id || p.name : p;
    const name = typeof p === 'object' ? p.name || p.id : p;
    const isOn = selected.includes(id);
    return /*#__PURE__*/React.createElement("button", {
      key: id,
      type: "button",
      onClick: () => toggle(id),
      style: {
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
        WebkitTapHighlightColor: 'transparent'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: '18px',
        height: '18px',
        flexShrink: 0,
        borderRadius: '4px',
        border: `2px solid ${isOn ? 'var(--color-forest)' : 'var(--border-color)'}`,
        background: isOn ? 'var(--color-forest)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'border-color 140ms ease, background 140ms ease'
      }
    }, isOn && /*#__PURE__*/React.createElement("svg", {
      width: "10",
      height: "8",
      viewBox: "0 0 10 8",
      fill: "none"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M1.5 4L3.83 6.5L8.5 1.5",
      stroke: "#fff",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }))), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, name));
  }));
}
Object.assign(__ds_scope, { ParticipantSelector });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/ParticipantSelector.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
const {
  useState
} = React;
/**
 * Select — dropdown field.
 * Same visual language as Input: 48px height, focus ring, label/hint/error.
 * Pass options as strings or { value, label } objects.
 */
function Select({
  label,
  value,
  onChange,
  options = [],
  placeholder,
  hint,
  error,
  disabled = false,
  id
}) {
  const [focused, setFocused] = useState(false);
  const selectId = id || `gv-select-${Math.random().toString(36).slice(2, 7)}`;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '5px',
      width: '100%'
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: selectId,
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--font-weight-medium)',
      fontSize: 'var(--text-label-size)',
      color: 'var(--text-secondary)',
      lineHeight: 1.4
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("select", {
    id: selectId,
    value: value,
    onChange: onChange,
    disabled: disabled,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    style: {
      width: '100%',
      height: '48px',
      padding: '0 40px 0 14px',
      appearance: 'none',
      WebkitAppearance: 'none',
      background: disabled ? '#F4F6F5' : 'var(--color-surface)',
      borderRadius: 'var(--radius-md)',
      border: `1.5px solid ${error ? 'var(--color-error)' : focused ? 'var(--color-forest)' : 'var(--border-color)'}`,
      boxShadow: focused ? 'var(--shadow-focus)' : 'none',
      color: 'var(--text-primary)',
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--text-body-size)',
      fontWeight: 'var(--font-weight-regular)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      outline: 'none',
      transition: 'border-color 150ms ease, box-shadow 150ms ease'
    }
  }, placeholder && /*#__PURE__*/React.createElement("option", {
    value: "",
    disabled: true
  }, placeholder), options.map(o => {
    const val = typeof o === 'object' ? o.value : o;
    const lbl = typeof o === 'object' ? o.label : o;
    return /*#__PURE__*/React.createElement("option", {
      key: val,
      value: val
    }, lbl);
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      right: '14px',
      top: '50%',
      transform: 'translateY(-50%)',
      pointerEvents: 'none',
      color: 'var(--text-muted)',
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "14",
    height: "14",
    viewBox: "0 0 14 14",
    fill: "none"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M3 5l4 4 4-4",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  })))), (hint || error) && /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--text-caption-size)',
      color: error ? 'var(--color-error)' : 'var(--text-muted)',
      margin: 0,
      lineHeight: 1.4
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/navigation/AppHeader.jsx
try { (() => {
function AppHeader({
  greeting,
  subtitle,
  actions,
  compact = false
}) {
  return /*#__PURE__*/React.createElement("header", {
    style: {
      background: 'var(--color-forest)',
      padding: compact ? '12px var(--screen-padding-x)' : '20px var(--screen-padding-x) 24px',
      display: 'flex',
      alignItems: compact ? 'center' : 'flex-end',
      justifyContent: 'space-between',
      minHeight: compact ? '52px' : 'var(--header-height)',
      paddingTop: compact ? '12px' : 'max(20px, env(safe-area-inset-top, 20px))'
    }
  }, /*#__PURE__*/React.createElement("div", null, greeting && /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: compact ? 'var(--font-weight-bold)' : 'var(--font-weight-extrabold)',
      fontSize: compact ? 'var(--text-heading-size)' : 'var(--text-title-size)',
      color: '#fff',
      margin: 0,
      lineHeight: 1.2
    }
  }, greeting), subtitle && /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--text-caption-size)',
      color: 'rgba(255,255,255,0.70)',
      margin: '3px 0 0',
      lineHeight: 1.3
    }
  }, subtitle)), actions && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '8px',
      alignItems: 'center'
    }
  }, actions));
}
Object.assign(__ds_scope, { AppHeader });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/AppHeader.jsx", error: String((e && e.message) || e) }); }

// components/navigation/BottomNav.jsx
try { (() => {
function BottomNav({
  items = [],
  active,
  onSelect
}) {
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      display: 'flex',
      alignItems: 'stretch',
      height: 'var(--nav-height)',
      background: 'var(--color-surface)',
      boxShadow: 'var(--shadow-nav)',
      borderTop: '1px solid var(--border-color)',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)'
    }
  }, items.map((item, i) => {
    const isActive = active === item.id || active === i;
    return /*#__PURE__*/React.createElement("button", {
      key: item.id || i,
      onClick: () => onSelect && onSelect(item.id || i),
      style: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '3px',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '8px 4px',
        color: isActive ? 'var(--color-forest)' : 'var(--text-muted)',
        transition: 'color 140ms ease',
        WebkitTapHighlightColor: 'transparent'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '22px',
        lineHeight: 1,
        display: 'block'
      }
    }, item.icon), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'var(--font-body)',
        fontWeight: isActive ? 'var(--font-weight-semibold)' : 'var(--font-weight-regular)',
        fontSize: '10px',
        lineHeight: 1
      }
    }, item.label));
  }));
}
Object.assign(__ds_scope, { BottomNav });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/BottomNav.jsx", error: String((e && e.message) || e) }); }

// components/navigation/TabNav.jsx
try { (() => {
/**
 * TabNav — horizontal scrollable pill-tab navigation.
 * The primary navigation pattern for GoVehlo's app sections.
 * Set sticky={true} for in-page use so it pins to the top on scroll.
 */
function TabNav({
  items = [],
  active,
  onSelect,
  sticky = false
}) {
  return /*#__PURE__*/React.createElement("nav", {
    "aria-label": "Sections",
    style: {
      display: 'flex',
      gap: '8px',
      padding: '10px 0 16px',
      margin: '-6px 0 6px',
      overflowX: 'auto',
      WebkitOverflowScrolling: 'touch',
      scrollbarWidth: 'none',
      msOverflowStyle: 'none',
      ...(sticky ? {
        position: 'sticky',
        top: 0,
        zIndex: 20,
        background: 'linear-gradient(180deg, var(--color-warm-white) 0%, rgba(247,249,248,0.94) 72%, rgba(247,249,248,0) 100%)'
      } : {})
    }
  }, items.map((item, i) => {
    const id = item.id !== undefined ? item.id : i;
    const isActive = active === id;
    return /*#__PURE__*/React.createElement("button", {
      key: id,
      onClick: () => onSelect && onSelect(id),
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '7px',
        flexShrink: 0,
        minHeight: '42px',
        padding: '0 16px',
        borderRadius: 'var(--radius-full)',
        border: `1px solid ${isActive ? 'var(--color-forest)' : 'var(--border-color)'}`,
        background: isActive ? 'var(--color-mist)' : 'var(--color-surface)',
        color: isActive ? 'var(--color-forest)' : 'var(--text-muted)',
        fontFamily: 'var(--font-body)',
        fontWeight: isActive ? 'var(--font-weight-semibold)' : 'var(--font-weight-regular)',
        fontSize: '14px',
        letterSpacing: '0.01em',
        cursor: 'pointer',
        boxShadow: 'var(--shadow-card)',
        transition: 'color 140ms ease, border-color 140ms ease, background 140ms ease',
        WebkitTapHighlightColor: 'transparent',
        whiteSpace: 'nowrap'
      }
    }, item.label, item.badge != null && item.badge > 0 && /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '20px',
        height: '20px',
        padding: '0 5px',
        borderRadius: 'var(--radius-full)',
        background: 'var(--color-error)',
        color: '#fff',
        fontSize: '11px',
        fontWeight: 700,
        lineHeight: 1
      }
    }, item.badge));
  }));
}
Object.assign(__ds_scope, { TabNav });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/TabNav.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Odometer = __ds_scope.Odometer;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.AmountDisplay = __ds_scope.AmountDisplay;

__ds_ns.FuelCard = __ds_scope.FuelCard;

__ds_ns.SettlementCard = __ds_scope.SettlementCard;

__ds_ns.StatusChip = __ds_scope.StatusChip;

__ds_ns.SummaryBand = __ds_scope.SummaryBand;

__ds_ns.TripCard = __ds_scope.TripCard;

__ds_ns.EmptyState = __ds_scope.EmptyState;

__ds_ns.ErrorBanner = __ds_scope.ErrorBanner;

__ds_ns.Skeleton = __ds_scope.Skeleton;

__ds_ns.Spinner = __ds_scope.Spinner;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.ParticipantSelector = __ds_scope.ParticipantSelector;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.AppHeader = __ds_scope.AppHeader;

__ds_ns.BottomNav = __ds_scope.BottomNav;

__ds_ns.TabNav = __ds_scope.TabNav;

})();
