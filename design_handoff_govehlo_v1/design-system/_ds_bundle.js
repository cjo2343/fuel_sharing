/* @ds-bundle: {"format":3,"namespace":"GoVehloDesignSystem_c5fd4e","components":[{"name":"Avatar","sourcePath":"components/core/Avatar.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"Odometer","sourcePath":"components/core/Odometer.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"AmountDisplay","sourcePath":"components/data/AmountDisplay.jsx"},{"name":"FuelCard","sourcePath":"components/data/FuelCard.jsx"},{"name":"SettlementCard","sourcePath":"components/data/SettlementCard.jsx"},{"name":"StatusChip","sourcePath":"components/data/StatusChip.jsx"},{"name":"SummaryBand","sourcePath":"components/data/SummaryBand.jsx"},{"name":"TripCard","sourcePath":"components/data/TripCard.jsx"},{"name":"EmptyState","sourcePath":"components/feedback/EmptyState.jsx"},{"name":"ErrorBanner","sourcePath":"components/feedback/ErrorBanner.jsx"},{"name":"Skeleton","sourcePath":"components/feedback/Skeleton.jsx"},{"name":"Spinner","sourcePath":"components/feedback/Spinner.jsx"},{"name":"Toast","sourcePath":"components/feedback/Toast.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"ParticipantSelector","sourcePath":"components/forms/ParticipantSelector.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"AppHeader","sourcePath":"components/navigation/AppHeader.jsx"},{"name":"BottomNav","sourcePath":"components/navigation/BottomNav.jsx"},{"name":"TabNav","sourcePath":"components/navigation/TabNav.jsx"}],"sourceHashes":{"components/core/Avatar.jsx":"703a3f065a64","components/core/Badge.jsx":"19b15ac5a461","components/core/Button.jsx":"c770ab3d48d1","components/core/Card.jsx":"b71726f69d85","components/core/Odometer.jsx":"2221e756b1ac","components/core/Tag.jsx":"181703d81971","components/data/AmountDisplay.jsx":"b05cd6b658cb","components/data/FuelCard.jsx":"d17af4e59d9e","components/data/SettlementCard.jsx":"14b1870fd9b5","components/data/StatusChip.jsx":"ed8c35779cf4","components/data/SummaryBand.jsx":"1b0cd9adf39c","components/data/TripCard.jsx":"b6a10f5e7ce0","components/feedback/EmptyState.jsx":"fa70b7a15d01","components/feedback/ErrorBanner.jsx":"2621c997adce","components/feedback/Skeleton.jsx":"c37170a0e624","components/feedback/Spinner.jsx":"e2f762f9b8d2","components/feedback/Toast.jsx":"6f76f6f34693","components/forms/Checkbox.jsx":"31dadb736afd","components/forms/Input.jsx":"493f5c37619b","components/forms/ParticipantSelector.jsx":"f8390fb14ebf","components/forms/Select.jsx":"9830bcd1a6e9","components/navigation/AppHeader.jsx":"1ae3611a9e83","components/navigation/BottomNav.jsx":"331a13d26fe9","components/navigation/TabNav.jsx":"7733eae6db9c","design_handoff_govehlo_v1/design-system/templates/admin-audit/AdminAudit.jsx":"20dcc6426211","design_handoff_govehlo_v1/design-system/templates/admin-audit/ds-base.js":"db762691d5ed","design_handoff_govehlo_v1/design-system/templates/admin-dashboard/AdminDashboard.jsx":"ba2bdb7f913c","design_handoff_govehlo_v1/design-system/templates/admin-dashboard/ds-base.js":"db762691d5ed","design_handoff_govehlo_v1/design-system/templates/admin-health/AdminHealth.jsx":"5f9377e2dc61","design_handoff_govehlo_v1/design-system/templates/admin-health/ds-base.js":"db762691d5ed","design_handoff_govehlo_v1/design-system/templates/admin-shared/AdminLayout.jsx":"1a66cdf69a04","design_handoff_govehlo_v1/design-system/templates/govehlo-app/GoVehloApp.jsx":"761a0af4a984","design_handoff_govehlo_v1/design-system/templates/govehlo-app/ds-base.js":"db762691d5ed"},"inlinedExternals":[],"unexposedExports":[]} */

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

// design_handoff_govehlo_v1/design-system/templates/admin-audit/AdminAudit.jsx
try { (() => {
const {
  Avatar,
  Badge
} = window.GoVehloDesignSystem_c5fd4e || {};
const AUDIT_ENTRIES = [{
  time: '2026-06-25 14:32:08',
  actor: 'Christian Jørgensen',
  type: 'trip_created',
  entity: 'Trip',
  id: 'a3f7c2d1',
  detail: 'Lyngby → Holte, 45.892–45.904 km, driver: Christian',
  severity: 'info'
}, {
  time: '2026-06-25 14:28:41',
  actor: 'Lars Nielsen',
  type: 'fuel_created',
  entity: 'Fuel',
  id: 'b8e2f4a7',
  detail: 'Circle K Lyngby, 45,20 kr, 3,2 L diesel',
  severity: 'info'
}, {
  time: '2026-06-25 14:15:22',
  actor: 'Sara Andersen',
  type: 'payment_requested',
  entity: 'Payment',
  id: 'c4d93b18',
  detail: 'Requested 127,50 kr from Mette Hansen',
  severity: 'info'
}, {
  time: '2026-06-25 13:58:03',
  actor: 'Christian Jørgensen',
  type: 'trip_updated',
  entity: 'Trip',
  id: 'd1a3e5c9',
  detail: 'End odometer corrected 45.892 → 45.905 km',
  severity: 'warning'
}, {
  time: '2026-06-25 13:42:17',
  actor: 'Mette Hansen',
  type: 'booking_created',
  entity: 'Booking',
  id: 'e7f5a2d4',
  detail: 'Car booked 27. jun 09:00–17:00',
  severity: 'info'
}, {
  time: '2026-06-25 13:30:55',
  actor: 'Anders Pedersen',
  type: 'payment_marked_paid',
  entity: 'Payment',
  id: 'f2b8c6e1',
  detail: 'Marked 52,00 kr to Lars as paid via MobilePay',
  severity: 'info'
}, {
  time: '2026-06-25 12:55:39',
  actor: 'Lars Nielsen',
  type: 'trip_deleted',
  entity: 'Trip',
  id: 'g9c1d3f7',
  detail: 'Deleted duplicate entry (45.850–45.862 km)',
  severity: 'error'
}, {
  time: '2026-06-25 12:40:12',
  actor: 'Christian Jørgensen',
  type: 'settings_saved',
  entity: 'Settings',
  id: 'h3d7e9a2',
  detail: 'Fuel fallback price 14,50 → 15,20 kr/L',
  severity: 'info'
}, {
  time: '2026-06-25 11:20:44',
  actor: 'Sara Andersen',
  type: 'fuel_created',
  entity: 'Fuel',
  id: 'i5e9b1c3',
  detail: 'OK Holte, 389,00 kr, 28,4 L diesel, full tank',
  severity: 'info'
}, {
  time: '2026-06-25 11:05:28',
  actor: 'Mette Hansen',
  type: 'trip_created',
  entity: 'Trip',
  id: 'j6f0c2d4',
  detail: 'Virum → Kgs. Lyngby, 45.904–45.912 km',
  severity: 'info'
}, {
  time: '2026-06-25 10:30:16',
  actor: 'Anders Pedersen',
  type: 'vehicle_lookup_completed',
  entity: 'System',
  id: 'k7g2e5f8',
  detail: 'Nummerplade Tjek lookup for AB 12 345',
  severity: 'info'
}, {
  time: '2026-06-25 09:45:33',
  actor: 'Christian Jørgensen',
  type: 'settlement_closed',
  entity: 'Settlement',
  id: 'l8h4f6g9',
  detail: 'Closed Maj 2026 — 5 members, 3 net settlements',
  severity: 'info'
}, {
  time: '2026-06-25 09:15:07',
  actor: 'Lars Nielsen',
  type: 'booking_deleted',
  entity: 'Booking',
  id: 'm9i6g7h0',
  detail: 'Cancelled booking for 25. jun 13:00–18:00',
  severity: 'warning'
}, {
  time: '2026-06-24 22:10:55',
  actor: 'Sara Andersen',
  type: 'payment_reopened',
  entity: 'Payment',
  id: 'n0j8h1i2',
  detail: 'Reopened 89,00 kr settlement with Anders',
  severity: 'warning'
}, {
  time: '2026-06-24 21:30:42',
  actor: 'Christian Jørgensen',
  type: 'fuel_updated',
  entity: 'Fuel',
  id: 'o1k9i2j3',
  detail: 'Corrected liters 28,4 → 27,8 L at OK Holte',
  severity: 'warning'
}, {
  time: '2026-06-24 19:05:18',
  actor: 'Mette Hansen',
  type: 'trip_created',
  entity: 'Trip',
  id: 'p2l0j3k4',
  detail: 'Holte → Birkerød, 45.912–45.928 km',
  severity: 'info'
}, {
  time: '2026-06-24 17:42:09',
  actor: 'Anders Pedersen',
  type: 'fuel_deleted',
  entity: 'Fuel',
  id: 'q3m1k4l5',
  detail: 'Deleted test fuel entry (generated)',
  severity: 'error'
}, {
  time: '2026-06-24 16:20:33',
  actor: 'Lars Nielsen',
  type: 'payment_reminder_sent',
  entity: 'Payment',
  id: 'r4n2l5m6',
  detail: 'Reminder sent to Mette for 127,50 kr',
  severity: 'info'
}, {
  time: '2026-06-24 14:55:21',
  actor: 'Christian Jørgensen',
  type: 'settlement_reopened',
  entity: 'Settlement',
  id: 's5o3m6n7',
  detail: 'Reopened Maj 2026 — missing fuel entry found',
  severity: 'warning'
}, {
  time: '2026-06-24 13:10:47',
  actor: 'Sara Andersen',
  type: 'booking_updated',
  entity: 'Booking',
  id: 't6p4n7o8',
  detail: 'Changed booking 28. jun 10:00–14:00 → 09:00–15:00',
  severity: 'info'
}];
const ACTION_LABELS = {
  trip_created: 'Trip created',
  trip_updated: 'Trip updated',
  trip_deleted: 'Trip deleted',
  fuel_created: 'Fuel logged',
  fuel_updated: 'Fuel updated',
  fuel_deleted: 'Fuel deleted',
  booking_created: 'Booking created',
  booking_updated: 'Booking updated',
  booking_deleted: 'Booking cancelled',
  payment_requested: 'Payment requested',
  payment_marked_paid: 'Payment paid',
  payment_reopened: 'Payment reopened',
  payment_reminder_sent: 'Reminder sent',
  settlement_closed: 'Period closed',
  settlement_reopened: 'Period reopened',
  settlement_reset: 'Period reset',
  settings_saved: 'Settings saved',
  vehicle_lookup_completed: 'Vehicle lookup'
};
const TYPE_BADGES = {
  trip_created: 'success',
  trip_updated: 'pending',
  trip_deleted: 'error',
  fuel_created: 'success',
  fuel_updated: 'pending',
  fuel_deleted: 'error',
  booking_created: 'success',
  booking_updated: 'pending',
  booking_deleted: 'error',
  payment_requested: 'money',
  payment_marked_paid: 'success',
  payment_reopened: 'pending',
  payment_reminder_sent: 'neutral',
  settlement_closed: 'forest',
  settlement_reopened: 'pending',
  settlement_reset: 'error',
  settings_saved: 'neutral',
  vehicle_lookup_completed: 'neutral'
};
const SEV_COLORS = {
  info: '#52B788',
  warning: '#F4A261',
  error: '#D95050'
};
const inputStyle = {
  height: 34,
  border: '1px solid #E2EDE8',
  borderRadius: 8,
  padding: '0 10px',
  fontSize: 13,
  fontFamily: "'Inter',sans-serif",
  background: '#fff',
  color: '#1A2E1F',
  outline: 'none'
};
const selectStyle = {
  ...inputStyle,
  paddingRight: 28,
  appearance: 'none',
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236B8F7A' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E\")",
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 10px center',
  cursor: 'pointer'
};
function AuditRow({
  row
}) {
  const AvatarC = Avatar || (({
    name
  }) => React.createElement('div', {
    style: {
      width: 22,
      height: 22,
      borderRadius: '50%',
      background: '#2D6A4F',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontSize: 8,
      fontWeight: 700,
      fontFamily: "'Nunito',sans-serif",
      flexShrink: 0
    }
  }, name.split(' ').map(n => n[0]).join('')));
  const BadgeC = Badge || (({
    variant,
    children
  }) => React.createElement('span', {
    style: {
      fontSize: 10,
      padding: '2px 7px',
      borderRadius: 99,
      background: '#D8F3DC',
      color: '#2D6A4F',
      fontWeight: 500
    }
  }, children));
  const ts = row.time.length > 10 ? row.time.slice(11, 19) : row.time;
  const date = row.time.length > 10 ? row.time.slice(5, 10).replace('-', '/') : '';
  return React.createElement('tr', {
    style: {
      borderBottom: '1px solid #F0F4F2'
    }
  }, React.createElement('td', {
    style: {
      padding: '7px 10px',
      whiteSpace: 'nowrap',
      verticalAlign: 'middle'
    }
  }, React.createElement('div', {
    style: {
      fontFamily: "'Courier New',monospace",
      fontSize: 11,
      color: '#1A2E1F',
      lineHeight: 1.2
    }
  }, ts), date && React.createElement('div', {
    style: {
      fontFamily: "'Inter',sans-serif",
      fontSize: 10,
      color: '#6B8F7A'
    }
  }, date)), React.createElement('td', {
    style: {
      padding: '7px 8px',
      verticalAlign: 'middle'
    }
  }, React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, React.createElement(AvatarC, {
    name: row.actor,
    size: 'xs'
  }), React.createElement('span', {
    style: {
      fontSize: 12,
      fontWeight: 500,
      color: '#1A2E1F',
      fontFamily: "'Inter',sans-serif",
      whiteSpace: 'nowrap'
    }
  }, row.actor))), React.createElement('td', {
    style: {
      padding: '7px 8px',
      verticalAlign: 'middle'
    }
  }, React.createElement(BadgeC, {
    variant: TYPE_BADGES[row.type] || 'neutral',
    size: 'sm'
  }, ACTION_LABELS[row.type] || row.type)), React.createElement('td', {
    style: {
      padding: '7px 8px',
      fontSize: 12,
      fontWeight: 500,
      color: '#3D5C48',
      fontFamily: "'Inter',sans-serif",
      verticalAlign: 'middle'
    }
  }, row.entity), React.createElement('td', {
    style: {
      padding: '7px 8px',
      fontFamily: "'Courier New',monospace",
      fontSize: 11,
      color: '#6B8F7A',
      verticalAlign: 'middle'
    }
  }, row.id.slice(0, 8)), React.createElement('td', {
    style: {
      padding: '7px 10px',
      fontSize: 12,
      color: '#6B8F7A',
      fontFamily: "'Inter',sans-serif",
      maxWidth: 280,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      verticalAlign: 'middle'
    }
  }, row.detail), React.createElement('td', {
    style: {
      padding: '7px 10px',
      verticalAlign: 'middle',
      textAlign: 'center'
    }
  }, React.createElement('span', {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: SEV_COLORS[row.severity] || SEV_COLORS.info,
      display: 'inline-block'
    }
  })));
}
function AdminAuditContent() {
  const [typeFilter, setTypeFilter] = React.useState('all');
  const [actorFilter, setActorFilter] = React.useState('all');
  const filtered = AUDIT_ENTRIES.filter(e => {
    if (typeFilter !== 'all' && !e.type.startsWith(typeFilter)) return false;
    if (actorFilter !== 'all' && !e.actor.startsWith(actorFilter)) return false;
    return true;
  });
  return React.createElement(AdminLayout, {
    activePage: 'audit',
    pageTitle: 'Audit Log',
    pageSubtitle: '247 events · Familien Jørgensen',
    notificationCount: 2
  },
  // Filter bar
  React.createElement('div', {
    style: {
      display: 'flex',
      gap: 10,
      marginBottom: 16,
      flexWrap: 'wrap',
      alignItems: 'center'
    }
  }, React.createElement('select', {
    style: selectStyle,
    value: typeFilter,
    onChange: e => setTypeFilter(e.target.value)
  }, React.createElement('option', {
    value: 'all'
  }, 'All types'), React.createElement('option', {
    value: 'trip'
  }, 'Trips'), React.createElement('option', {
    value: 'fuel'
  }, 'Fuel'), React.createElement('option', {
    value: 'booking'
  }, 'Bookings'), React.createElement('option', {
    value: 'payment'
  }, 'Payments'), React.createElement('option', {
    value: 'settlement'
  }, 'Settlements'), React.createElement('option', {
    value: 'settings'
  }, 'Settings'), React.createElement('option', {
    value: 'vehicle'
  }, 'System')), React.createElement('select', {
    style: selectStyle,
    value: actorFilter,
    onChange: e => setActorFilter(e.target.value)
  }, React.createElement('option', {
    value: 'all'
  }, 'All members'), React.createElement('option', {
    value: 'Christian'
  }, 'Christian'), React.createElement('option', {
    value: 'Lars'
  }, 'Lars'), React.createElement('option', {
    value: 'Sara'
  }, 'Sara'), React.createElement('option', {
    value: 'Mette'
  }, 'Mette'), React.createElement('option', {
    value: 'Anders'
  }, 'Anders')), React.createElement('input', {
    type: 'date',
    style: {
      ...inputStyle,
      width: 130
    },
    defaultValue: '2026-06-24'
  }), React.createElement('input', {
    type: 'date',
    style: {
      ...inputStyle,
      width: 130
    },
    defaultValue: '2026-06-25'
  }), React.createElement('div', {
    style: {
      position: 'relative',
      flex: 1,
      minWidth: 160
    }
  }, React.createElement('span', {
    style: {
      position: 'absolute',
      left: 10,
      top: 8,
      pointerEvents: 'none'
    }
  }, React.createElement(LucideIcon, {
    name: 'search',
    size: 16,
    color: '#6B8F7A'
  })), React.createElement('input', {
    style: {
      ...inputStyle,
      width: '100%',
      paddingLeft: 34
    },
    placeholder: 'Search events\u2026',
    readOnly: true
  }))),
  // Table
  React.createElement('div', {
    style: {
      background: '#fff',
      borderRadius: 12,
      boxShadow: '0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)',
      overflow: 'hidden'
    }
  }, React.createElement('table', {
    style: {
      width: '100%',
      borderCollapse: 'collapse'
    }
  }, React.createElement('thead', null, React.createElement('tr', {
    style: {
      background: '#FAFCFB',
      borderBottom: '1px solid #E2EDE8'
    }
  }, ['Timestamp', 'Actor', 'Action', 'Entity', 'ID', 'Detail', ''].map(h => React.createElement('th', {
    key: h,
    style: {
      padding: '9px 10px',
      fontSize: 10,
      fontWeight: 600,
      color: '#6B8F7A',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      textAlign: h === '' ? 'center' : 'left',
      fontFamily: "'Inter',sans-serif"
    }
  }, h)))), React.createElement('tbody', null, filtered.map((row, i) => React.createElement(AuditRow, {
    key: i,
    row
  }))))),
  // Pagination
  React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 14,
      padding: '0 4px'
    }
  }, React.createElement('span', {
    style: {
      fontSize: 12,
      color: '#6B8F7A',
      fontFamily: "'Inter',sans-serif"
    }
  }, 'Showing 1\u201320 of 247 events'), React.createElement('div', {
    style: {
      display: 'flex',
      gap: 6
    }
  }, React.createElement('button', {
    style: {
      ...inputStyle,
      padding: '0 14px',
      cursor: 'pointer',
      fontWeight: 500,
      color: '#6B8F7A',
      height: 30,
      fontSize: 12
    },
    disabled: true
  }, '\u2190 Previous'), React.createElement('button', {
    style: {
      ...inputStyle,
      padding: '0 14px',
      cursor: 'pointer',
      fontWeight: 500,
      color: '#2D6A4F',
      height: 30,
      fontSize: 12,
      background: '#D8F3DC',
      border: '1px solid #C4D9CD'
    }
  }, 'Next \u2192'))));
}
window.AdminAuditContent = AdminAuditContent;
})(); } catch (e) { __ds_ns.__errors.push({ path: "design_handoff_govehlo_v1/design-system/templates/admin-audit/AdminAudit.jsx", error: String((e && e.message) || e) }); }

// design_handoff_govehlo_v1/design-system/templates/admin-audit/ds-base.js
try { (() => {
// Loads this design system into the template. In a consuming project, point
// base at the bound DS folder relative to this file (e.g. '_ds/<folder>' at
// the project root, '../_ds/<folder>' one level down) — one line to edit.
(() => {
  const base = '../..';
  for (const p of ["tokens/fonts.css", "tokens/colors.css", "tokens/typography.css", "tokens/spacing.css", "tokens/borders.css", "tokens/shadows.css", "tokens/motion.css", "styles.css"]) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = base + '/' + p;
    document.head.appendChild(l);
  }
  const s = document.createElement('script');
  s.src = base + '/_ds_bundle.js';
  s.onerror = () => console.error('ds-base.js: failed to load ' + s.src + ' — if this is a consuming project, point the base line in ds-base.js at the bound _ds/<folder> tree relative to this page (e.g. _ds/<folder> at the project root, ../_ds/<folder> one level down); in a fresh design system this can just mean the bundle is not compiled yet');
  document.head.appendChild(s);
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "design_handoff_govehlo_v1/design-system/templates/admin-audit/ds-base.js", error: String((e && e.message) || e) }); }

// design_handoff_govehlo_v1/design-system/templates/admin-dashboard/AdminDashboard.jsx
try { (() => {
const {
  Avatar,
  Badge,
  Card
} = window.GoVehloDesignSystem_c5fd4e || {};
const STAT_TILES = [{
  label: 'Active users',
  value: '5',
  icon: 'users',
  color: '#52B788',
  bg: '#D1F5E3'
}, {
  label: 'Trips this period',
  value: '47',
  icon: 'map-pin',
  color: '#2D6A4F',
  bg: '#D8F3DC'
}, {
  label: 'Fuel entries',
  value: '12',
  icon: 'fuel',
  color: '#2D6A4F',
  bg: '#D8F3DC'
}, {
  label: 'Pending settlements',
  value: '3',
  icon: 'arrow-up-down',
  color: '#F4A261',
  bg: '#FDE8D8'
}, {
  label: 'Errors (24h)',
  value: '0',
  icon: 'alert-circle',
  color: '#52B788',
  bg: '#D1F5E3',
  good: true
}, {
  label: 'Warnings (24h)',
  value: '2',
  icon: 'alert-triangle',
  color: '#F4A261',
  bg: '#FDE8D8'
}];
const HEALTH_ITEMS = [{
  label: 'Supabase',
  status: 'Connected',
  detail: '42 ms',
  color: '#52B788'
}, {
  label: 'Render',
  status: 'Running',
  detail: 'v452',
  color: '#52B788'
}, {
  label: 'Database',
  status: 'Matched',
  detail: '5 / 47 / 12',
  color: '#52B788'
}];
const ACTIVITY = [{
  time: '14:32',
  actor: 'Christian Jørgensen',
  type: 'trip_created',
  badge: 'success',
  entity: 'Trip',
  detail: 'Lyngby → Holte, 12 km',
  id: 'a3f7'
}, {
  time: '14:28',
  actor: 'Lars Nielsen',
  type: 'fuel_created',
  badge: 'success',
  entity: 'Fuel',
  detail: 'Circle K Lyngby, 45,20 kr, 3,2 L',
  id: 'b8e2'
}, {
  time: '14:15',
  actor: 'Sara Andersen',
  type: 'payment_requested',
  badge: 'money',
  entity: 'Payment',
  detail: 'Requested 127,50 kr from Mette',
  id: 'c4d9'
}, {
  time: '13:58',
  actor: 'Christian Jørgensen',
  type: 'trip_updated',
  badge: 'pending',
  entity: 'Trip',
  detail: 'Updated end odometer 45.892 → 45.905 km',
  id: 'd1a3'
}, {
  time: '13:42',
  actor: 'Mette Hansen',
  type: 'booking_created',
  badge: 'success',
  entity: 'Booking',
  detail: 'Booked car for 27. jun, 09:00–17:00',
  id: 'e7f5'
}, {
  time: '13:30',
  actor: 'Anders Pedersen',
  type: 'payment_marked_paid',
  badge: 'success',
  entity: 'Payment',
  detail: 'Marked 52,00 kr to Lars as paid',
  id: 'f2b8'
}, {
  time: '12:55',
  actor: 'Lars Nielsen',
  type: 'trip_deleted',
  badge: 'error',
  entity: 'Trip',
  detail: 'Deleted duplicate trip entry',
  id: 'g9c1'
}, {
  time: '12:40',
  actor: 'Christian Jørgensen',
  type: 'settings_saved',
  badge: 'neutral',
  entity: 'Settings',
  detail: 'Updated fuel fallback price 14,50 → 15,20 kr/L',
  id: 'h3d7'
}, {
  time: '11:20',
  actor: 'Sara Andersen',
  type: 'fuel_created',
  badge: 'success',
  entity: 'Fuel',
  detail: 'OK Holte, 389,00 kr, 28,4 L, full tank',
  id: 'i5e9'
}, {
  time: '11:05',
  actor: 'Mette Hansen',
  type: 'trip_created',
  badge: 'success',
  entity: 'Trip',
  detail: 'Virum → Kgs. Lyngby, 8 km',
  id: 'j6f0'
}, {
  time: '10:30',
  actor: 'Anders Pedersen',
  type: 'vehicle_lookup',
  badge: 'neutral',
  entity: 'System',
  detail: 'Vehicle lookup completed for AB 12 345',
  id: 'k7g2'
}, {
  time: '09:45',
  actor: 'Christian Jørgensen',
  type: 'settlement_closed',
  badge: 'forest',
  entity: 'Settlement',
  detail: 'Closed period Maj 2026, 5 settlements',
  id: 'l8h4'
}, {
  time: '09:15',
  actor: 'Lars Nielsen',
  type: 'booking_deleted',
  badge: 'error',
  entity: 'Booking',
  detail: 'Cancelled booking for 25. jun',
  id: 'm9i6'
}, {
  time: 'Yesterday',
  actor: 'Sara Andersen',
  type: 'payment_reopened',
  badge: 'pending',
  entity: 'Payment',
  detail: 'Reopened 89,00 kr settlement with Anders',
  id: 'n0j8'
}, {
  time: 'Yesterday',
  actor: 'Christian Jørgensen',
  type: 'fuel_updated',
  badge: 'pending',
  entity: 'Fuel',
  detail: 'Corrected liters 28,4 → 27,8 L at OK Holte',
  id: 'o1k9'
}];
const ACTION_LABELS = {
  trip_created: 'Created',
  trip_updated: 'Updated',
  trip_deleted: 'Deleted',
  fuel_created: 'Created',
  fuel_updated: 'Updated',
  fuel_deleted: 'Deleted',
  booking_created: 'Created',
  booking_updated: 'Updated',
  booking_deleted: 'Cancelled',
  payment_requested: 'Requested',
  payment_marked_paid: 'Paid',
  payment_reopened: 'Reopened',
  settlement_closed: 'Closed',
  settings_saved: 'Saved',
  vehicle_lookup: 'Lookup'
};
function StatTile({
  label,
  value,
  icon,
  color,
  bg
}) {
  return React.createElement('div', {
    style: {
      background: '#fff',
      borderRadius: 12,
      padding: '16px 18px',
      boxShadow: '0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 14,
      minWidth: 0
    }
  }, React.createElement('div', {
    style: {
      width: 36,
      height: 36,
      borderRadius: 10,
      background: bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0
    }
  }, React.createElement(LucideIcon, {
    name: icon,
    size: 18,
    color
  })), React.createElement('div', {
    style: {
      minWidth: 0
    }
  }, React.createElement('div', {
    style: {
      fontFamily: "'Inter', sans-serif",
      fontSize: 11,
      fontWeight: 500,
      color: '#6B8F7A',
      textTransform: 'uppercase',
      letterSpacing: '0.05em'
    }
  }, label), React.createElement('div', {
    style: {
      fontFamily: "'Nunito', sans-serif",
      fontWeight: 900,
      fontSize: 28,
      color: '#1A2E1F',
      lineHeight: 1.1,
      marginTop: 2
    }
  }, value)));
}
function HealthMini({
  label,
  status,
  detail,
  color
}) {
  return React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 16px',
      background: '#fff',
      borderRadius: 10,
      boxShadow: '0 1px 3px rgba(26,46,31,.06)',
      flex: 1,
      minWidth: 0
    }
  }, React.createElement('span', {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      flexShrink: 0
    }
  }), React.createElement('span', {
    style: {
      fontFamily: "'Inter', sans-serif",
      fontSize: 13,
      fontWeight: 600,
      color: '#1A2E1F'
    }
  }, label), React.createElement('span', {
    style: {
      fontFamily: "'Inter', sans-serif",
      fontSize: 12,
      color: '#6B8F7A'
    }
  }, status), React.createElement('span', {
    style: {
      marginLeft: 'auto',
      fontFamily: "'Courier New', monospace",
      fontSize: 11,
      color: '#6B8F7A',
      flexShrink: 0
    }
  }, detail));
}
function ActivityRow({
  row
}) {
  const AvatarC = Avatar || (({
    name
  }) => React.createElement('div', {
    style: {
      width: 24,
      height: 24,
      borderRadius: '50%',
      background: '#2D6A4F',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontSize: 9,
      fontWeight: 700,
      fontFamily: "'Nunito',sans-serif",
      flexShrink: 0
    }
  }, name.split(' ').map(n => n[0]).join('')));
  const BadgeC = Badge || (({
    variant,
    children
  }) => React.createElement('span', {
    style: {
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 99,
      background: '#D8F3DC',
      color: '#2D6A4F',
      fontWeight: 500
    }
  }, children));
  return React.createElement('tr', {
    style: {
      borderBottom: '1px solid #F0F4F2'
    }
  }, React.createElement('td', {
    style: {
      padding: '8px 12px',
      fontFamily: "'Courier New', monospace",
      fontSize: 11,
      color: '#6B8F7A',
      whiteSpace: 'nowrap'
    }
  }, row.time), React.createElement('td', {
    style: {
      padding: '8px 8px',
      whiteSpace: 'nowrap'
    }
  }, React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, React.createElement(AvatarC, {
    name: row.actor,
    size: 'xs'
  }), React.createElement('span', {
    style: {
      fontSize: 13,
      fontWeight: 500,
      color: '#1A2E1F',
      fontFamily: "'Inter',sans-serif"
    }
  }, row.actor.split(' ')[0]))), React.createElement('td', {
    style: {
      padding: '8px 8px'
    }
  }, React.createElement(BadgeC, {
    variant: row.badge,
    size: 'sm'
  }, ACTION_LABELS[row.type] || row.type)), React.createElement('td', {
    style: {
      padding: '8px 8px',
      fontSize: 12,
      color: '#3D5C48',
      fontFamily: "'Inter',sans-serif",
      fontWeight: 500
    }
  }, row.entity), React.createElement('td', {
    style: {
      padding: '8px 12px',
      fontSize: 12,
      color: '#6B8F7A',
      fontFamily: "'Inter',sans-serif",
      maxWidth: 300,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, row.detail));
}
function AdminDashboardContent() {
  return React.createElement(AdminLayout, {
    activePage: 'dashboard',
    pageTitle: 'Dashboard',
    pageSubtitle: 'Familien Jørgensen · Last updated 2 minutes ago',
    notificationCount: 2
  },
  // Stat tiles
  React.createElement('div', {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 14,
      marginBottom: 20
    }
  }, STAT_TILES.map((t, i) => React.createElement(StatTile, {
    key: i,
    ...t
  }))),
  // Health strip
  React.createElement('div', {
    style: {
      display: 'flex',
      gap: 12,
      marginBottom: 24
    }
  }, HEALTH_ITEMS.map((h, i) => React.createElement(HealthMini, {
    key: i,
    ...h
  }))),
  // Section header
  React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12
    }
  }, React.createElement('h2', {
    style: {
      fontFamily: "'Nunito', sans-serif",
      fontWeight: 700,
      fontSize: 17,
      color: '#1A2E1F',
      margin: 0
    }
  }, 'Recent activity'), React.createElement('span', {
    style: {
      fontSize: 12,
      color: '#2D6A4F',
      fontWeight: 500,
      cursor: 'pointer',
      fontFamily: "'Inter',sans-serif"
    }
  }, 'View all →')),
  // Activity table
  React.createElement('div', {
    style: {
      background: '#fff',
      borderRadius: 12,
      boxShadow: '0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)',
      overflow: 'hidden'
    }
  }, React.createElement('table', {
    style: {
      width: '100%',
      borderCollapse: 'collapse'
    }
  }, React.createElement('thead', null, React.createElement('tr', {
    style: {
      background: '#FAFCFB',
      borderBottom: '1px solid #E2EDE8'
    }
  }, ['Time', 'Actor', 'Action', 'Entity', 'Detail'].map(h => React.createElement('th', {
    key: h,
    style: {
      padding: '10px 12px',
      fontSize: 11,
      fontWeight: 600,
      color: '#6B8F7A',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      textAlign: 'left',
      fontFamily: "'Inter',sans-serif"
    }
  }, h)))), React.createElement('tbody', null, ACTIVITY.map((row, i) => React.createElement(ActivityRow, {
    key: i,
    row
  }))))));
}
window.AdminDashboardContent = AdminDashboardContent;
})(); } catch (e) { __ds_ns.__errors.push({ path: "design_handoff_govehlo_v1/design-system/templates/admin-dashboard/AdminDashboard.jsx", error: String((e && e.message) || e) }); }

// design_handoff_govehlo_v1/design-system/templates/admin-dashboard/ds-base.js
try { (() => {
// Loads this design system into the template. In a consuming project, point
// base at the bound DS folder relative to this file (e.g. '_ds/<folder>' at
// the project root, '../_ds/<folder>' one level down) — one line to edit.
(() => {
  const base = '../..';
  for (const p of ["tokens/fonts.css", "tokens/colors.css", "tokens/typography.css", "tokens/spacing.css", "tokens/borders.css", "tokens/shadows.css", "tokens/motion.css", "styles.css"]) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = base + '/' + p;
    document.head.appendChild(l);
  }
  const s = document.createElement('script');
  s.src = base + '/_ds_bundle.js';
  s.onerror = () => console.error('ds-base.js: failed to load ' + s.src + ' — if this is a consuming project, point the base line in ds-base.js at the bound _ds/<folder> tree relative to this page (e.g. _ds/<folder> at the project root, ../_ds/<folder> one level down); in a fresh design system this can just mean the bundle is not compiled yet');
  document.head.appendChild(s);
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "design_handoff_govehlo_v1/design-system/templates/admin-dashboard/ds-base.js", error: String((e && e.message) || e) }); }

// design_handoff_govehlo_v1/design-system/templates/admin-health/AdminHealth.jsx
try { (() => {
const {
  Button
} = window.GoVehloDesignSystem_c5fd4e || {};
const HEALTH_CARDS = [{
  title: 'Supabase Connection',
  status: 'ok',
  statusLabel: 'Connected',
  value: '42 ms',
  detail: 'Last probe 2 min ago',
  icon: 'database'
}, {
  title: 'Render Service',
  status: 'ok',
  statusLabel: 'Running',
  value: '14d 6h',
  detail: 'Uptime · v452 · No cold-start issues',
  icon: 'server'
}, {
  title: 'Database Tables',
  status: 'ok',
  statusLabel: 'All matched',
  value: '5 / 47 / 12 / 3 / 8',
  detail: 'Members · Trips · Fuel · Periods · Requests',
  icon: 'table-2'
}, {
  title: 'Read Mode',
  status: 'ok',
  statusLabel: 'Active',
  value: 'Normalized',
  detail: 'Tables primary, JSON fallback/backup',
  icon: 'check-circle'
}, {
  title: 'Open Period',
  status: 'ok',
  statusLabel: '1 open',
  value: 'Juni 2026',
  detail: 'ID a3f7\u2026c2d1 · Status: open',
  icon: 'calendar'
}, {
  title: 'Settlement Requests',
  status: 'warning',
  statusLabel: '2 stale',
  value: '6 current',
  detail: '6 current requests, 2 stale active rows',
  icon: 'arrow-up-down',
  action: 'clean'
}, {
  title: 'Soft-Deleted Rows',
  status: 'info',
  statusLabel: 'Audit kept',
  value: '3 trips, 1 fuel',
  detail: 'Soft-deleted rows kept for history',
  icon: 'trash-2',
  action: 'purge'
}, {
  title: 'JSON Backup',
  status: 'ok',
  statusLabel: 'Fresh',
  value: '14:32 today',
  detail: 'Last snapshot · State matches app (5/47/12)',
  icon: 'hard-drive'
}, {
  title: 'Vehicle Provider',
  status: 'ok',
  statusLabel: 'Available',
  value: 'Nummerplade Tjek',
  detail: 'Last lookup 09:15 today · No errors',
  icon: 'car'
}];
const STATUS_COLORS = {
  ok: '#52B788',
  warning: '#F4A261',
  error: '#D95050',
  info: '#6B8F7A'
};
const STATUS_BG = {
  ok: '#D1F5E3',
  warning: '#FDE8D8',
  error: '#FDEDED',
  info: '#EAEFEC'
};
function HealthCard({
  card
}) {
  const color = STATUS_COLORS[card.status];
  const bg = STATUS_BG[card.status];
  const BtnC = Button || (({
    children,
    ...p
  }) => React.createElement('button', {
    style: {
      fontSize: 12,
      padding: '5px 12px',
      borderRadius: 8,
      border: '1px solid #E2EDE8',
      background: '#fff',
      cursor: 'pointer',
      fontFamily: "'Inter',sans-serif",
      fontWeight: 500,
      color: '#1A2E1F'
    },
    ...p
  }, children));
  return React.createElement('div', {
    style: {
      background: '#fff',
      borderRadius: 12,
      padding: '18px 20px',
      boxShadow: '0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)',
      borderLeft: '4px solid ' + color,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minHeight: 130
    }
  },
  // Header
  React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, React.createElement('div', {
    style: {
      width: 32,
      height: 32,
      borderRadius: 8,
      background: bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0
    }
  }, React.createElement(LucideIcon, {
    name: card.icon,
    size: 16,
    color
  })), React.createElement('div', {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, React.createElement('div', {
    style: {
      fontFamily: "'Nunito',sans-serif",
      fontWeight: 700,
      fontSize: 14,
      color: '#1A2E1F',
      lineHeight: 1.2
    }
  }, card.title), React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 2
    }
  }, React.createElement('span', {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: color,
      flexShrink: 0
    }
  }), React.createElement('span', {
    style: {
      fontFamily: "'Inter',sans-serif",
      fontSize: 11,
      fontWeight: 500,
      color
    }
  }, card.statusLabel)))),
  // Value
  React.createElement('div', {
    style: {
      fontFamily: "'Nunito',sans-serif",
      fontWeight: 900,
      fontSize: 22,
      color: '#1A2E1F',
      lineHeight: 1.15
    }
  }, card.value),
  // Detail
  React.createElement('div', {
    style: {
      fontFamily: "'Inter',sans-serif",
      fontSize: 12,
      color: '#6B8F7A',
      lineHeight: 1.4,
      marginTop: 'auto'
    }
  }, card.detail),
  // Action button
  card.action && React.createElement('div', {
    style: {
      marginTop: 4
    }
  }, card.action === 'clean' ? React.createElement(BtnC, {
    variant: 'danger',
    size: 'sm',
    onClick: () => {}
  }, 'Clean stale requests') : React.createElement(BtnC, {
    variant: 'outline',
    size: 'sm',
    onClick: () => {}
  }, 'Purge test rows')));
}
function AdminHealthContent() {
  const now = new Date().toLocaleString('da-DK', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
  return React.createElement(AdminLayout, {
    activePage: 'health',
    pageTitle: 'System Health',
    pageSubtitle: 'All systems operational \u00b7 Last checked ' + now,
    notificationCount: 2
  },
  // Summary strip
  React.createElement('div', {
    style: {
      display: 'flex',
      gap: 12,
      marginBottom: 20,
      flexWrap: 'wrap'
    }
  }, [{
    label: 'Services',
    count: '3/3',
    color: '#52B788',
    text: 'healthy'
  }, {
    label: 'Warnings',
    count: '2',
    color: '#F4A261',
    text: 'active'
  }, {
    label: 'Errors',
    count: '0',
    color: '#52B788',
    text: 'none'
  }, {
    label: 'Uptime',
    count: '99.8%',
    color: '#52B788',
    text: '30 days'
  }].map((s, i) => React.createElement('div', {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 18px',
      background: '#fff',
      borderRadius: 10,
      boxShadow: '0 1px 3px rgba(26,46,31,.06)',
      flex: '1 1 160px',
      minWidth: 140
    }
  }, React.createElement('span', {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: s.color,
      flexShrink: 0
    }
  }), React.createElement('div', null, React.createElement('div', {
    style: {
      fontFamily: "'Nunito',sans-serif",
      fontWeight: 800,
      fontSize: 18,
      color: '#1A2E1F',
      lineHeight: 1.1
    }
  }, s.count), React.createElement('div', {
    style: {
      fontFamily: "'Inter',sans-serif",
      fontSize: 11,
      color: '#6B8F7A'
    }
  }, s.label + ' \u00b7 ' + s.text))))),
  // Cards grid
  React.createElement('div', {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 16
    }
  }, HEALTH_CARDS.map((card, i) => React.createElement(HealthCard, {
    key: i,
    card
  }))));
}
window.AdminHealthContent = AdminHealthContent;
})(); } catch (e) { __ds_ns.__errors.push({ path: "design_handoff_govehlo_v1/design-system/templates/admin-health/AdminHealth.jsx", error: String((e && e.message) || e) }); }

// design_handoff_govehlo_v1/design-system/templates/admin-health/ds-base.js
try { (() => {
// Loads this design system into the template. In a consuming project, point
// base at the bound DS folder relative to this file (e.g. '_ds/<folder>' at
// the project root, '../_ds/<folder>' one level down) — one line to edit.
(() => {
  const base = '../..';
  for (const p of ["tokens/fonts.css", "tokens/colors.css", "tokens/typography.css", "tokens/spacing.css", "tokens/borders.css", "tokens/shadows.css", "tokens/motion.css", "styles.css"]) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = base + '/' + p;
    document.head.appendChild(l);
  }
  const s = document.createElement('script');
  s.src = base + '/_ds_bundle.js';
  s.onerror = () => console.error('ds-base.js: failed to load ' + s.src + ' — if this is a consuming project, point the base line in ds-base.js at the bound _ds/<folder> tree relative to this page (e.g. _ds/<folder> at the project root, ../_ds/<folder> one level down); in a fresh design system this can just mean the bundle is not compiled yet');
  document.head.appendChild(s);
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "design_handoff_govehlo_v1/design-system/templates/admin-health/ds-base.js", error: String((e && e.message) || e) }); }

// design_handoff_govehlo_v1/design-system/templates/admin-shared/AdminLayout.jsx
try { (() => {
(function () {
  var Avatar = (window.GoVehloDesignSystem_c5fd4e || {}).Avatar;
  var adminLayoutStyles = {
    root: {
      display: 'flex',
      height: '100vh',
      overflow: 'hidden',
      fontFamily: "'Inter', system-ui, sans-serif"
    },
    sidebar: {
      width: 240,
      flexShrink: 0,
      background: '#1A2E1F',
      display: 'flex',
      flexDirection: 'column',
      color: '#fff'
    },
    sidebarHeader: {
      padding: '20px 20px 24px',
      display: 'flex',
      alignItems: 'center',
      gap: 10
    },
    sidebarLogo: {
      width: 32,
      height: 32,
      borderRadius: 8,
      background: '#2D6A4F',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    },
    sidebarTitle: {
      fontFamily: "'Nunito', sans-serif",
      fontWeight: 800,
      fontSize: 18,
      color: '#fff',
      letterSpacing: '-0.01em'
    },
    sidebarSubtitle: {
      fontFamily: "'Inter', sans-serif",
      fontSize: 10,
      color: 'rgba(255,255,255,0.45)',
      fontWeight: 500,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      marginTop: 2
    },
    nav: {
      flex: 1,
      padding: '0 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    },
    navItem: active => ({
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 12px',
      borderRadius: 10,
      cursor: 'pointer',
      border: 'none',
      width: '100%',
      textAlign: 'left',
      background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
      color: active ? '#fff' : 'rgba(255,255,255,0.55)',
      fontFamily: "'Inter', sans-serif",
      fontWeight: active ? 600 : 400,
      fontSize: 14,
      transition: 'background 140ms ease, color 140ms ease'
    }),
    sidebarFooter: {
      padding: '16px 20px',
      borderTop: '1px solid rgba(255,255,255,0.08)',
      display: 'flex',
      alignItems: 'center',
      gap: 10
    },
    main: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    },
    topBar: {
      height: 56,
      flexShrink: 0,
      background: '#fff',
      borderBottom: '1px solid #E2EDE8',
      display: 'flex',
      alignItems: 'center',
      padding: '0 24px',
      gap: 16
    },
    searchWrap: {
      flex: 1,
      maxWidth: 420,
      position: 'relative'
    },
    searchInput: {
      width: '100%',
      height: 36,
      border: '1px solid #E2EDE8',
      borderRadius: 8,
      padding: '0 12px 0 36px',
      fontSize: 13,
      fontFamily: "'Inter', sans-serif",
      background: '#F7F9F8',
      outline: 'none',
      color: '#1A2E1F'
    },
    searchIcon: {
      position: 'absolute',
      left: 10,
      top: 8,
      color: '#6B8F7A',
      pointerEvents: 'none'
    },
    bellWrap: {
      position: 'relative',
      cursor: 'pointer',
      padding: 6
    },
    bellDot: count => ({
      display: count > 0 ? 'flex' : 'none',
      position: 'absolute',
      top: 2,
      right: 2,
      width: 16,
      height: 16,
      borderRadius: '50%',
      background: '#D95050',
      color: '#fff',
      fontSize: 9,
      fontWeight: 700,
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'Inter', sans-serif"
    }),
    content: {
      flex: 1,
      overflow: 'auto',
      background: '#F7F9F8',
      padding: 24
    },
    pageTitle: {
      fontFamily: "'Nunito', sans-serif",
      fontWeight: 800,
      fontSize: 22,
      color: '#1A2E1F',
      margin: 0,
      lineHeight: 1.25
    },
    pageSub: {
      fontFamily: "'Inter', sans-serif",
      fontSize: 13,
      color: '#6B8F7A',
      margin: '2px 0 0'
    }
  };
  var NAV_ITEMS = [{
    id: 'dashboard',
    label: 'Dashboard',
    icon: 'layout-dashboard'
  }, {
    id: 'audit',
    label: 'Audit Log',
    icon: 'scroll-text'
  }, {
    id: 'health',
    label: 'System Health',
    icon: 'activity'
  }];
  function LucideIcon({
    name,
    size = 18,
    color = 'currentColor'
  }) {
    const ref = React.useRef(null);
    React.useEffect(() => {
      if (ref.current && window.lucide) {
        ref.current.innerHTML = '';
        const el = document.createElement('i');
        el.setAttribute('data-lucide', name);
        el.style.width = size + 'px';
        el.style.height = size + 'px';
        ref.current.appendChild(el);
        window.lucide.createIcons({
          nodes: [el]
        });
      }
    }, [name, size]);
    return React.createElement('span', {
      ref,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        color,
        width: size,
        height: size
      }
    });
  }
  function AdminLayout({
    activePage = 'dashboard',
    pageTitle,
    pageSubtitle,
    notificationCount = 0,
    children
  }) {
    const s = adminLayoutStyles;
    return React.createElement('div', {
      style: s.root
    },
    // Sidebar
    React.createElement('aside', {
      style: s.sidebar
    }, React.createElement('div', {
      style: s.sidebarHeader
    }, React.createElement('div', {
      style: s.sidebarLogo
    }, React.createElement('svg', {
      width: 18,
      height: 18,
      viewBox: '0 0 512 512',
      fill: 'none'
    }, React.createElement('path', {
      d: 'M 0 140 C 140 80 380 420 512 385',
      stroke: '#D8F3DC',
      strokeWidth: 44,
      fill: 'none',
      strokeLinecap: 'round'
    }), React.createElement('circle', {
      cx: 259,
      cy: 253,
      r: 22,
      fill: '#F4A261'
    }))), React.createElement('div', null, React.createElement('div', {
      style: s.sidebarTitle
    }, 'GoVehlo'), React.createElement('div', {
      style: s.sidebarSubtitle
    }, 'Admin'))), React.createElement('nav', {
      style: s.nav
    }, NAV_ITEMS.map(item => React.createElement('button', {
      key: item.id,
      style: s.navItem(activePage === item.id),
      onClick: () => {}
    }, React.createElement(LucideIcon, {
      name: item.icon,
      size: 18
    }), item.label))), React.createElement('div', {
      style: s.sidebarFooter
    }, Avatar ? React.createElement(Avatar, {
      name: 'Christian Jørgensen',
      size: 'sm'
    }) : React.createElement('div', {
      style: {
        width: 32,
        height: 32,
        borderRadius: '50%',
        background: '#2D6A4F'
      }
    }), React.createElement('div', null, React.createElement('div', {
      style: {
        fontSize: 13,
        fontWeight: 600,
        color: '#fff'
      }
    }, 'Christian J.'), React.createElement('div', {
      style: {
        fontSize: 10,
        color: 'rgba(255,255,255,0.5)'
      }
    }, 'App owner')))),
    // Main
    React.createElement('div', {
      style: s.main
    }, React.createElement('header', {
      style: s.topBar
    }, React.createElement('div', {
      style: s.searchWrap
    }, React.createElement('span', {
      style: s.searchIcon
    }, React.createElement(LucideIcon, {
      name: 'search',
      size: 16,
      color: '#6B8F7A'
    })), React.createElement('input', {
      style: s.searchInput,
      placeholder: 'Search events, members, actions\u2026',
      readOnly: true
    })), React.createElement('div', {
      style: s.bellWrap
    }, React.createElement(LucideIcon, {
      name: 'bell',
      size: 20,
      color: '#6B8F7A'
    }), React.createElement('span', {
      style: s.bellDot(notificationCount)
    }, notificationCount > 0 ? notificationCount : '')), React.createElement('div', {
      style: {
        width: 1,
        height: 28,
        background: '#E2EDE8'
      }
    }), React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, Avatar ? React.createElement(Avatar, {
      name: 'Christian Jørgensen',
      size: 'sm'
    }) : null, React.createElement('span', {
      style: {
        fontSize: 13,
        fontWeight: 500,
        color: '#1A2E1F'
      }
    }, 'Christian J.'))), React.createElement('main', {
      style: s.content
    }, (pageTitle || pageSubtitle) && React.createElement('div', {
      style: {
        marginBottom: 20
      }
    }, pageTitle && React.createElement('h1', {
      style: s.pageTitle
    }, pageTitle), pageSubtitle && React.createElement('p', {
      style: s.pageSub
    }, pageSubtitle)), children)));
  }
  window.AdminLayout = AdminLayout;
  window.LucideIcon = LucideIcon;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "design_handoff_govehlo_v1/design-system/templates/admin-shared/AdminLayout.jsx", error: String((e && e.message) || e) }); }

// design_handoff_govehlo_v1/design-system/templates/govehlo-app/GoVehloApp.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// GoVehlo App Template
// Requires: GoVehlo Design System bundle loaded via ds-base.js

const {
  useState
} = React;

// Access DS at render time — ensures bundle is loaded before use
function ds() {
  return window.GoVehloDesignSystem_c5fd4e || {};
}

/* ── Sample data ─────────────────────────────────────────────── */
const MEMBERS = ['Christian', 'Lars', 'Sara', 'Mikkel'];
const TRIPS = [{
  id: 1,
  driver: 'Christian',
  startOdo: 45231,
  endOdo: 45318,
  cost: 22.50,
  date: '22 jun'
}, {
  id: 2,
  driver: 'Lars',
  startOdo: 45318,
  endOdo: 45502,
  cost: 47.00,
  date: '18 jun'
}, {
  id: 3,
  driver: 'Sara',
  startOdo: 45502,
  endOdo: 45571,
  cost: 17.60,
  date: '15 jun'
}, {
  id: 4,
  driver: 'Christian',
  startOdo: 45571,
  endOdo: 45660,
  cost: 22.75,
  date: '12 jun'
}];
const FUEL = [{
  id: 1,
  paidBy: 'Christian',
  amountDkk: 495.90,
  liters: 34.2,
  station: 'Circle K Roskilde',
  fullTank: true,
  date: '22 jun'
}, {
  id: 2,
  paidBy: 'Lars',
  amountDkk: 409.00,
  liters: 28.5,
  station: 'Q8 København',
  fullTank: false,
  date: '15 jun'
}, {
  id: 3,
  paidBy: 'Sara',
  amountDkk: 452.60,
  liters: 31.0,
  station: 'Shell Taastrup',
  fullTank: true,
  date: ' 8 jun'
}];
const SETTLEMENTS = [{
  personName: 'Lars',
  amount: 52.00,
  direction: 'owe',
  status: 'open'
}, {
  personName: 'Sara',
  amount: 120.50,
  direction: 'receive',
  status: 'requested'
}, {
  personName: 'Mikkel',
  amount: 34.00,
  direction: 'settled',
  status: 'paid'
}];
const TABS = [{
  id: 'log',
  label: 'Log'
}, {
  id: 'book',
  label: 'Book'
}, {
  id: 'settle',
  label: 'Settle'
}, {
  id: 'payments',
  label: 'Payments',
  badge: 1
}, {
  id: 'history',
  label: 'History'
}, {
  id: 'insights',
  label: 'Insights'
}];

/* ── Helpers ─────────────────────────────────────────────────── */
function SLabel({
  children,
  top
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 11,
      fontWeight: 600,
      color: 'var(--text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '.07em',
      padding: top ? '14px 16px 6px' : '0 0 6px'
    }
  }, children);
}
function SubTabs({
  options,
  active,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      padding: '12px 16px 4px'
    }
  }, options.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.id,
    onClick: () => onChange(o.id),
    style: {
      padding: '6px 16px',
      borderRadius: 9999,
      border: 'none',
      cursor: 'pointer',
      fontFamily: 'var(--font-body)',
      fontSize: 13,
      fontWeight: 600,
      minHeight: 44,
      background: active === o.id ? 'var(--color-forest)' : 'var(--color-mist)',
      color: active === o.id ? '#fff' : 'var(--color-forest)',
      transition: 'background 140ms ease'
    }
  }, o.label)));
}

/* ── Home ────────────────────────────────────────────────────── */
function HomeScreen() {
  const {
    Avatar,
    TripCard,
    AmountDisplay
  } = ds();
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '16px 16px 0',
      background: '#fff',
      borderRadius: 16,
      padding: 16,
      boxShadow: '0 1px 3px rgba(26,46,31,.07),0 2px 8px rgba(26,46,31,.04)',
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      borderRight: '1px solid var(--border-color)',
      paddingRight: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 11,
      fontWeight: 500,
      color: 'var(--text-muted)',
      marginBottom: 4
    }
  }, "You owe"), /*#__PURE__*/React.createElement(AmountDisplay, {
    amount: 52.00,
    direction: "owe",
    size: "lg"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 12,
      color: 'var(--text-secondary)',
      marginTop: 4
    }
  }, "to Lars")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      paddingLeft: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 11,
      fontWeight: 500,
      color: 'var(--text-muted)',
      marginBottom: 4
    }
  }, "Owed to you"), /*#__PURE__*/React.createElement(AmountDisplay, {
    amount: 120.50,
    direction: "receive",
    size: "lg"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 12,
      color: 'var(--text-secondary)',
      marginTop: 4
    }
  }, "from Sara"))), /*#__PURE__*/React.createElement(SLabel, {
    top: true
  }, "Your group"), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px',
      display: 'flex',
      gap: 20
    }
  }, MEMBERS.map((name, i) => /*#__PURE__*/React.createElement("div", {
    key: name,
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: name,
    size: "md",
    online: i < 3
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 11,
      color: 'var(--text-secondary)',
      fontWeight: 500
    }
  }, name)))), /*#__PURE__*/React.createElement(SLabel, {
    top: true
  }, "Recent trips"), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, TRIPS.slice(0, 3).map(t => /*#__PURE__*/React.createElement(TripCard, {
    key: t.id,
    driver: t.driver,
    startOdo: t.startOdo,
    endOdo: t.endOdo,
    cost: t.cost,
    date: t.date,
    onClick: () => {}
  }))));
}

/* ── Log ─────────────────────────────────────────────────────── */
function LogScreen({
  onToast
}) {
  const {
    Button,
    Input,
    Select,
    Checkbox,
    ParticipantSelector,
    FuelCard
  } = ds();
  const [view, setView] = useState('trip');
  const [split, setSplit] = useState(['Christian']);
  const [fullTank, setFullTank] = useState(false);

  // Null-guard until bundle regenerates
  const SafeSelect = Select || Input;
  const SafeCheckbox = Checkbox || null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement(SubTabs, {
    options: [{
      id: 'trip',
      label: 'Trip'
    }, {
      id: 'fuel',
      label: 'Fuel'
    }],
    active: view,
    onChange: setView
  }), view === 'trip' && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 16px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(SLabel, null, "Log distance"), /*#__PURE__*/React.createElement(Input, {
    label: "Driver",
    value: "Christian",
    disabled: true
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Date",
    type: "date",
    value: "2026-06-24",
    onChange: () => {}
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Input, {
    label: "Start odometer",
    type: "number",
    placeholder: "45 318",
    suffix: "km"
  }), /*#__PURE__*/React.createElement(Input, {
    label: "End odometer",
    type: "number",
    placeholder: "45 402",
    suffix: "km"
  })), /*#__PURE__*/React.createElement(Input, {
    label: "Note",
    placeholder: "Optional"
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 13,
      fontWeight: 500,
      color: 'var(--text-secondary)',
      marginBottom: 8
    }
  }, "Split between"), /*#__PURE__*/React.createElement(ParticipantSelector, {
    participants: MEMBERS.map(m => ({
      id: m,
      name: m
    })),
    selected: split,
    onChange: setSplit
  })), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    fullWidth: true,
    onClick: () => onToast('Trip logged.')
  }, "Add trip")), view === 'fuel' && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 16px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(SLabel, null, "Log fuel payment"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Input, {
    label: "Paid by",
    value: "Christian",
    disabled: true
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Date",
    type: "date",
    value: "2026-06-24",
    onChange: () => {}
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Amount paid",
    type: "number",
    placeholder: "0,00",
    suffix: "kr"
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Liters added",
    type: "number",
    placeholder: "Required",
    suffix: "L"
  })), /*#__PURE__*/React.createElement(Input, {
    label: "Station / place",
    placeholder: "Type or pick nearby"
  }), SafeCheckbox && React.createElement(SafeCheckbox, {
    label: 'Filled to full tank',
    checked: fullTank,
    onChange: e => setFullTank(e.target.checked),
    hint: 'Enables real-world L/100 km statistics between full-tank fills.'
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    fullWidth: true,
    onClick: () => onToast('Fuel logged.')
  }, "Add fuel"), /*#__PURE__*/React.createElement(SLabel, {
    top: true
  }, "Recent fuel logs"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, FUEL.map(f => /*#__PURE__*/React.createElement(FuelCard, _extends({
    key: f.id
  }, f))))));
}

/* ── Book ────────────────────────────────────────────────────── */
function BookScreen({
  onToast
}) {
  const {
    Button,
    Input,
    ParticipantSelector
  } = ds();
  const [dist, setDist] = useState('');
  const [people, setPeople] = useState(['Christian']);
  const est = dist && people.length > 0 ? (parseFloat(dist) * 2.47 / people.length).toFixed(2).replace('.', ',') : null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '12px 16px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(SLabel, null, "Estimate trip cost"), /*#__PURE__*/React.createElement(Input, {
    label: "Planned distance",
    type: "number",
    placeholder: "e.g. 350",
    suffix: "km",
    value: dist,
    onChange: e => setDist(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Input, {
    label: "From",
    placeholder: "Roskilde"
  }), /*#__PURE__*/React.createElement(Input, {
    label: "To",
    placeholder: "Aarhus"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 13,
      fontWeight: 500,
      color: 'var(--text-secondary)',
      marginBottom: 8
    }
  }, "People joining"), /*#__PURE__*/React.createElement(ParticipantSelector, {
    participants: MEMBERS.map(m => ({
      id: m,
      name: m
    })),
    selected: people,
    onChange: setPeople
  })), est && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      background: 'var(--color-mist)',
      borderRadius: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 12,
      color: 'var(--text-muted)'
    }
  }, "Estimated cost per person"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 900,
      fontSize: 32,
      color: 'var(--color-amber)',
      letterSpacing: '-0.02em',
      marginTop: 4,
      lineHeight: 1
    }
  }, est, " kr"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 12,
      color: 'var(--text-muted)',
      marginTop: 6
    }
  }, dist, " km \xD7 2,47 kr/km \xF7 ", people.length, " ", people.length === 1 ? 'person' : 'people')), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    fullWidth: true,
    onClick: () => onToast('Booking added.')
  }, "Add booking"));
}

/* ── Settle ──────────────────────────────────────────────────── */
function SettleScreen({
  onToast
}) {
  const {
    SummaryBand,
    SettlementCard,
    StatusChip,
    Button
  } = ds();
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '12px 16px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(SummaryBand, {
    items: [{
      label: 'Fuel rate',
      value: '2,47 kr/km'
    }, {
      label: 'Trip shares',
      value: '1.357 kr'
    }, {
      label: 'Fuel paid',
      value: '1.358 kr'
    }]
  }), /*#__PURE__*/React.createElement(SLabel, {
    top: true
  }, "Who pays whom"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, SETTLEMENTS.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(SettlementCard, {
    personName: s.personName,
    amount: s.amount,
    direction: s.direction,
    onAction: () => onToast(s.direction === 'owe' ? `Payment requested from ${s.personName}.` : `Marked paid by ${s.personName}.`)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      paddingRight: 4
    }
  }, /*#__PURE__*/React.createElement(StatusChip, {
    status: s.status
  }))))), /*#__PURE__*/React.createElement(Button, {
    variant: "outline",
    fullWidth: true,
    onClick: () => onToast('Period closed.')
  }, "Close period"));
}

/* ── Payments ────────────────────────────────────────────────── */
function PaymentsScreen({
  onToast
}) {
  const {
    Button,
    StatusChip,
    Avatar
  } = ds();
  const unpaid = [{
    person: 'Lars',
    amount: 52.00,
    requested: '19 jun',
    period: 'Jun 2026'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '12px 16px 24px'
    }
  }, /*#__PURE__*/React.createElement(SLabel, null, "Unpaid payments"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 13,
      color: 'var(--text-muted)',
      margin: '0 0 12px',
      lineHeight: 1.45
    }
  }, "Requested payments not yet marked paid, from current and closed settlements."), unpaid.map((p, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      background: '#fff',
      borderRadius: 16,
      padding: 14,
      boxShadow: '0 1px 3px rgba(26,46,31,.07)',
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: p.person,
    size: "md"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 15,
      color: 'var(--text-primary)'
    }
  }, "You owe ", p.person), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 11,
      color: 'var(--text-muted)',
      marginTop: 2
    }
  }, p.period, " \xB7 Requested ", p.requested)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 900,
      fontSize: 22,
      color: 'var(--color-amber)',
      letterSpacing: '-0.02em'
    }
  }, p.amount.toFixed(2).replace('.', ','), " kr")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(StatusChip, {
    status: "requested"
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "amber",
    size: "sm",
    onClick: () => onToast(`Marked paid to ${p.person}.`)
  }, "Mark paid")))));
}

/* ── History ─────────────────────────────────────────────────── */
function HistoryScreen() {
  const {
    TripCard,
    FuelCard
  } = ds();
  const [section, setSection] = useState('trips');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement(SubTabs, {
    options: [{
      id: 'trips',
      label: 'Trips'
    }, {
      id: 'fuel',
      label: 'Fuel'
    }, {
      id: 'archive',
      label: 'Closed'
    }],
    active: section,
    onChange: setSection
  }), section === 'trips' && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 16px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, TRIPS.map(t => /*#__PURE__*/React.createElement(TripCard, {
    key: t.id,
    driver: t.driver,
    startOdo: t.startOdo,
    endOdo: t.endOdo,
    cost: t.cost,
    date: t.date,
    onClick: () => {}
  }))), section === 'fuel' && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 16px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, FUEL.map(f => /*#__PURE__*/React.createElement(FuelCard, _extends({
    key: f.id
  }, f)))), section === 'archive' && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 16px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, [{
    month: 'Jun 2026',
    trips: 4,
    dist: '517 km',
    total: '1.357 kr',
    status: 'paid'
  }, {
    month: 'May 2026',
    trips: 3,
    dist: '487 km',
    total: '891 kr',
    status: 'paid'
  }].map(p => /*#__PURE__*/React.createElement("div", {
    key: p.month,
    style: {
      background: '#fff',
      borderRadius: 16,
      padding: 14,
      boxShadow: '0 1px 3px rgba(26,46,31,.07)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 15,
      color: 'var(--text-primary)'
    }
  }, p.month), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 12,
      color: 'var(--text-muted)',
      marginTop: 2
    }
  }, p.trips, " trips \xB7 ", p.dist)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 800,
      fontSize: 18,
      color: 'var(--color-amber)'
    }
  }, p.total)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4,1fr)',
      gap: 8
    }
  }, [['Trips', p.trips], ['Distance', p.dist], ['Fuel', '895 kr'], ['Rate', '2,47 kr/km']].map(([l, v]) => /*#__PURE__*/React.createElement("div", {
    key: l,
    style: {
      border: '1px solid var(--border-color)',
      borderRadius: 10,
      padding: '8px 10px',
      background: '#fbfcfb'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 9,
      fontWeight: 700,
      color: 'var(--text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '.04em',
      marginBottom: 2
    }
  }, l), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 800,
      fontSize: 13,
      color: 'var(--text-primary)'
    }
  }, v))))))));
}

/* ── Insights ────────────────────────────────────────────────── */
function InsightsScreen() {
  const {
    SummaryBand
  } = ds();
  const intel = [{
    label: 'DKK/km',
    value: '2,47 kr'
  }, {
    label: 'DKK/L',
    value: '14,50 kr'
  }, {
    label: 'L/100 km',
    value: '5,3 L'
  }, {
    label: 'Confidence',
    value: 'High'
  }];
  const stations = [{
    name: 'Circle K Roskilde',
    rate: '14,50 kr/L',
    count: 3,
    best: true
  }, {
    name: 'Q8 København',
    rate: '14,63 kr/L',
    count: 2,
    best: false
  }, {
    name: 'Shell Taastrup',
    rate: '14,60 kr/L',
    count: 2,
    best: false
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '12px 16px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(SLabel, null, "Fuel intelligence"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 10
    }
  }, intel.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.label,
    style: {
      border: '1px solid var(--border-color)',
      borderRadius: 16,
      background: '#fff',
      padding: '12px 14px',
      boxShadow: '0 1px 3px rgba(26,46,31,.07)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 10,
      fontWeight: 700,
      color: 'var(--text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '.06em',
      marginBottom: 6
    }
  }, s.label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 900,
      fontSize: 22,
      color: 'var(--text-primary)',
      letterSpacing: '-0.02em',
      lineHeight: 1
    }
  }, s.value)))), /*#__PURE__*/React.createElement(SLabel, {
    top: true
  }, "Monthly summary \u2014 June 2026"), /*#__PURE__*/React.createElement(SummaryBand, {
    items: [{
      label: 'Distance',
      value: '517 km'
    }, {
      label: 'Your share',
      value: '214 kr'
    }, {
      label: 'Trips',
      value: '4'
    }]
  }), /*#__PURE__*/React.createElement(SLabel, {
    top: true
  }, "Station insights"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, stations.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.name,
    style: {
      background: '#fff',
      borderRadius: 16,
      padding: '12px 14px',
      boxShadow: '0 1px 3px rgba(26,46,31,.07)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 14,
      color: 'var(--text-primary)'
    }
  }, s.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: 'var(--text-muted)',
      letterSpacing: '.04em',
      marginTop: 2
    }
  }, s.rate, " \xB7 ", s.count, " receipts")), s.best && /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--color-success-light)',
      color: '#1A7A47',
      borderRadius: 9999,
      padding: '3px 10px',
      fontSize: 11,
      fontWeight: 600,
      fontFamily: 'var(--font-body)'
    }
  }, "Best price")))));
}

/* ── App shell ───────────────────────────────────────────────── */
function App() {
  const {
    AppHeader,
    Odometer,
    TabNav
  } = ds();
  const [tab, setTab] = useState('log');
  const [toast, setToast] = useState(null);
  const showToast = msg => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      width: '100%',
      height: '100%',
      background: 'var(--color-warm-white)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'var(--font-body)',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(AppHeader, {
    greeting: "Good morning, Christian.",
    subtitle: "Database \xB7 Saved 14:05",
    actions: React.createElement(Odometer, {
      value: 1679,
      unit: 'km'
    }),
    compact: false
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flexShrink: 0,
      padding: '0 16px',
      background: 'var(--color-warm-white)'
    }
  }, /*#__PURE__*/React.createElement(TabNav, {
    items: TABS,
    active: tab,
    onSelect: setTab
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto'
    }
  }, tab === 'log' && React.createElement(LogScreen, {
    onToast: showToast
  }), tab === 'book' && React.createElement(BookScreen, {
    onToast: showToast
  }), tab === 'settle' && React.createElement(SettleScreen, {
    onToast: showToast
  }), tab === 'payments' && React.createElement(PaymentsScreen, {
    onToast: showToast
  }), tab === 'history' && React.createElement(HistoryScreen, null), tab === 'insights' && React.createElement(InsightsScreen, null)), toast && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 16,
      left: 12,
      right: 12,
      zIndex: 200,
      background: 'var(--color-deep-forest)',
      color: '#fff',
      borderRadius: 12,
      padding: '12px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      boxShadow: 'var(--shadow-elevated)',
      fontFamily: 'var(--font-body)',
      fontSize: 14,
      fontWeight: 500,
      animation: 'slideUp .22s ease'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 20,
      height: 20,
      borderRadius: '50%',
      background: 'rgba(255,255,255,.18)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 10,
      fontWeight: 700,
      flexShrink: 0
    }
  }, "\u2713"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }, toast), /*#__PURE__*/React.createElement("button", {
    onClick: () => setToast(null),
    style: {
      background: 'none',
      border: 'none',
      color: 'rgba(255,255,255,.6)',
      cursor: 'pointer',
      fontSize: 18,
      lineHeight: 1,
      padding: 0
    }
  }, "\xD7")));
}
window.GoVehloApp = App;
})(); } catch (e) { __ds_ns.__errors.push({ path: "design_handoff_govehlo_v1/design-system/templates/govehlo-app/GoVehloApp.jsx", error: String((e && e.message) || e) }); }

// design_handoff_govehlo_v1/design-system/templates/govehlo-app/ds-base.js
try { (() => {
// Loads this design system into the template. In a consuming project, point
// base at the bound DS folder relative to this file (e.g. '_ds/<folder>' at
// the project root, '../_ds/<folder>' one level down) — one line to edit.
(() => {
  const base = '../..';
  for (const p of ["tokens/fonts.css", "tokens/colors.css", "tokens/typography.css", "tokens/spacing.css", "tokens/borders.css", "tokens/shadows.css", "tokens/motion.css", "styles.css"]) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = base + '/' + p;
    document.head.appendChild(l);
  }
  const s = document.createElement('script');
  s.src = base + '/_ds_bundle.js';
  s.onerror = () => console.error('ds-base.js: failed to load ' + s.src + ' — if this is a consuming project, point the base line in ds-base.js at the bound _ds/<folder> tree relative to this page (e.g. _ds/<folder> at the project root, ../_ds/<folder> one level down); in a fresh design system this can just mean the bundle is not compiled yet');
  document.head.appendChild(s);
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "design_handoff_govehlo_v1/design-system/templates/govehlo-app/ds-base.js", error: String((e && e.message) || e) }); }

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
