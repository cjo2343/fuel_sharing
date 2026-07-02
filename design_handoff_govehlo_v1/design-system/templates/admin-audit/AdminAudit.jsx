const { Avatar, Badge } = window.GoVehloDesignSystem_c5fd4e || {};

const AUDIT_ENTRIES = [
  { time: '2026-06-25 14:32:08', actor: 'Christian Jørgensen', type: 'trip_created', entity: 'Trip', id: 'a3f7c2d1', detail: 'Lyngby → Holte, 45.892–45.904 km, driver: Christian', severity: 'info' },
  { time: '2026-06-25 14:28:41', actor: 'Lars Nielsen', type: 'fuel_created', entity: 'Fuel', id: 'b8e2f4a7', detail: 'Circle K Lyngby, 45,20 kr, 3,2 L diesel', severity: 'info' },
  { time: '2026-06-25 14:15:22', actor: 'Sara Andersen', type: 'payment_requested', entity: 'Payment', id: 'c4d93b18', detail: 'Requested 127,50 kr from Mette Hansen', severity: 'info' },
  { time: '2026-06-25 13:58:03', actor: 'Christian Jørgensen', type: 'trip_updated', entity: 'Trip', id: 'd1a3e5c9', detail: 'End odometer corrected 45.892 → 45.905 km', severity: 'warning' },
  { time: '2026-06-25 13:42:17', actor: 'Mette Hansen', type: 'booking_created', entity: 'Booking', id: 'e7f5a2d4', detail: 'Car booked 27. jun 09:00–17:00', severity: 'info' },
  { time: '2026-06-25 13:30:55', actor: 'Anders Pedersen', type: 'payment_marked_paid', entity: 'Payment', id: 'f2b8c6e1', detail: 'Marked 52,00 kr to Lars as paid via MobilePay', severity: 'info' },
  { time: '2026-06-25 12:55:39', actor: 'Lars Nielsen', type: 'trip_deleted', entity: 'Trip', id: 'g9c1d3f7', detail: 'Deleted duplicate entry (45.850–45.862 km)', severity: 'error' },
  { time: '2026-06-25 12:40:12', actor: 'Christian Jørgensen', type: 'settings_saved', entity: 'Settings', id: 'h3d7e9a2', detail: 'Fuel fallback price 14,50 → 15,20 kr/L', severity: 'info' },
  { time: '2026-06-25 11:20:44', actor: 'Sara Andersen', type: 'fuel_created', entity: 'Fuel', id: 'i5e9b1c3', detail: 'OK Holte, 389,00 kr, 28,4 L diesel, full tank', severity: 'info' },
  { time: '2026-06-25 11:05:28', actor: 'Mette Hansen', type: 'trip_created', entity: 'Trip', id: 'j6f0c2d4', detail: 'Virum → Kgs. Lyngby, 45.904–45.912 km', severity: 'info' },
  { time: '2026-06-25 10:30:16', actor: 'Anders Pedersen', type: 'vehicle_lookup_completed', entity: 'System', id: 'k7g2e5f8', detail: 'Nummerplade Tjek lookup for AB 12 345', severity: 'info' },
  { time: '2026-06-25 09:45:33', actor: 'Christian Jørgensen', type: 'settlement_closed', entity: 'Settlement', id: 'l8h4f6g9', detail: 'Closed Maj 2026 — 5 members, 3 net settlements', severity: 'info' },
  { time: '2026-06-25 09:15:07', actor: 'Lars Nielsen', type: 'booking_deleted', entity: 'Booking', id: 'm9i6g7h0', detail: 'Cancelled booking for 25. jun 13:00–18:00', severity: 'warning' },
  { time: '2026-06-24 22:10:55', actor: 'Sara Andersen', type: 'payment_reopened', entity: 'Payment', id: 'n0j8h1i2', detail: 'Reopened 89,00 kr settlement with Anders', severity: 'warning' },
  { time: '2026-06-24 21:30:42', actor: 'Christian Jørgensen', type: 'fuel_updated', entity: 'Fuel', id: 'o1k9i2j3', detail: 'Corrected liters 28,4 → 27,8 L at OK Holte', severity: 'warning' },
  { time: '2026-06-24 19:05:18', actor: 'Mette Hansen', type: 'trip_created', entity: 'Trip', id: 'p2l0j3k4', detail: 'Holte → Birkerød, 45.912–45.928 km', severity: 'info' },
  { time: '2026-06-24 17:42:09', actor: 'Anders Pedersen', type: 'fuel_deleted', entity: 'Fuel', id: 'q3m1k4l5', detail: 'Deleted test fuel entry (generated)', severity: 'error' },
  { time: '2026-06-24 16:20:33', actor: 'Lars Nielsen', type: 'payment_reminder_sent', entity: 'Payment', id: 'r4n2l5m6', detail: 'Reminder sent to Mette for 127,50 kr', severity: 'info' },
  { time: '2026-06-24 14:55:21', actor: 'Christian Jørgensen', type: 'settlement_reopened', entity: 'Settlement', id: 's5o3m6n7', detail: 'Reopened Maj 2026 — missing fuel entry found', severity: 'warning' },
  { time: '2026-06-24 13:10:47', actor: 'Sara Andersen', type: 'booking_updated', entity: 'Booking', id: 't6p4n7o8', detail: 'Changed booking 28. jun 10:00–14:00 → 09:00–15:00', severity: 'info' },
];

const ACTION_LABELS = {
  trip_created: 'Trip created', trip_updated: 'Trip updated', trip_deleted: 'Trip deleted',
  fuel_created: 'Fuel logged', fuel_updated: 'Fuel updated', fuel_deleted: 'Fuel deleted',
  booking_created: 'Booking created', booking_updated: 'Booking updated', booking_deleted: 'Booking cancelled',
  payment_requested: 'Payment requested', payment_marked_paid: 'Payment paid', payment_reopened: 'Payment reopened', payment_reminder_sent: 'Reminder sent',
  settlement_closed: 'Period closed', settlement_reopened: 'Period reopened', settlement_reset: 'Period reset',
  settings_saved: 'Settings saved', vehicle_lookup_completed: 'Vehicle lookup',
};

const TYPE_BADGES = {
  trip_created: 'success', trip_updated: 'pending', trip_deleted: 'error',
  fuel_created: 'success', fuel_updated: 'pending', fuel_deleted: 'error',
  booking_created: 'success', booking_updated: 'pending', booking_deleted: 'error',
  payment_requested: 'money', payment_marked_paid: 'success', payment_reopened: 'pending', payment_reminder_sent: 'neutral',
  settlement_closed: 'forest', settlement_reopened: 'pending', settlement_reset: 'error',
  settings_saved: 'neutral', vehicle_lookup_completed: 'neutral',
};

const SEV_COLORS = { info: '#52B788', warning: '#F4A261', error: '#D95050' };

const inputStyle = { height: 34, border: '1px solid #E2EDE8', borderRadius: 8, padding: '0 10px', fontSize: 13, fontFamily: "'Inter',sans-serif", background: '#fff', color: '#1A2E1F', outline: 'none' };
const selectStyle = { ...inputStyle, paddingRight: 28, appearance: 'none', backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236B8F7A' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E\")", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', cursor: 'pointer' };

function AuditRow({ row }) {
  const AvatarC = Avatar || (({ name }) => React.createElement('div', { style: { width: 22, height: 22, borderRadius: '50%', background: '#2D6A4F', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 8, fontWeight: 700, fontFamily: "'Nunito',sans-serif", flexShrink: 0 } }, name.split(' ').map(n => n[0]).join('')));
  const BadgeC = Badge || (({ variant, children }) => React.createElement('span', { style: { fontSize: 10, padding: '2px 7px', borderRadius: 99, background: '#D8F3DC', color: '#2D6A4F', fontWeight: 500 } }, children));
  const ts = row.time.length > 10 ? row.time.slice(11, 19) : row.time;
  const date = row.time.length > 10 ? row.time.slice(5, 10).replace('-', '/') : '';
  return React.createElement('tr', { style: { borderBottom: '1px solid #F0F4F2' } },
    React.createElement('td', { style: { padding: '7px 10px', whiteSpace: 'nowrap', verticalAlign: 'middle' } },
      React.createElement('div', { style: { fontFamily: "'Courier New',monospace", fontSize: 11, color: '#1A2E1F', lineHeight: 1.2 } }, ts),
      date && React.createElement('div', { style: { fontFamily: "'Inter',sans-serif", fontSize: 10, color: '#6B8F7A' } }, date)
    ),
    React.createElement('td', { style: { padding: '7px 8px', verticalAlign: 'middle' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        React.createElement(AvatarC, { name: row.actor, size: 'xs' }),
        React.createElement('span', { style: { fontSize: 12, fontWeight: 500, color: '#1A2E1F', fontFamily: "'Inter',sans-serif", whiteSpace: 'nowrap' } }, row.actor)
      )
    ),
    React.createElement('td', { style: { padding: '7px 8px', verticalAlign: 'middle' } },
      React.createElement(BadgeC, { variant: TYPE_BADGES[row.type] || 'neutral', size: 'sm' }, ACTION_LABELS[row.type] || row.type)
    ),
    React.createElement('td', { style: { padding: '7px 8px', fontSize: 12, fontWeight: 500, color: '#3D5C48', fontFamily: "'Inter',sans-serif", verticalAlign: 'middle' } }, row.entity),
    React.createElement('td', { style: { padding: '7px 8px', fontFamily: "'Courier New',monospace", fontSize: 11, color: '#6B8F7A', verticalAlign: 'middle' } }, row.id.slice(0, 8)),
    React.createElement('td', { style: { padding: '7px 10px', fontSize: 12, color: '#6B8F7A', fontFamily: "'Inter',sans-serif", maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' } }, row.detail),
    React.createElement('td', { style: { padding: '7px 10px', verticalAlign: 'middle', textAlign: 'center' } },
      React.createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', background: SEV_COLORS[row.severity] || SEV_COLORS.info, display: 'inline-block' } })
    )
  );
}

function AdminAuditContent() {
  const [typeFilter, setTypeFilter] = React.useState('all');
  const [actorFilter, setActorFilter] = React.useState('all');

  const filtered = AUDIT_ENTRIES.filter(e => {
    if (typeFilter !== 'all' && !e.type.startsWith(typeFilter)) return false;
    if (actorFilter !== 'all' && !e.actor.startsWith(actorFilter)) return false;
    return true;
  });

  return React.createElement(AdminLayout, { activePage: 'audit', pageTitle: 'Audit Log', pageSubtitle: '247 events · Familien Jørgensen', notificationCount: 2 },
    // Filter bar
    React.createElement('div', { style: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' } },
      React.createElement('select', { style: selectStyle, value: typeFilter, onChange: e => setTypeFilter(e.target.value) },
        React.createElement('option', { value: 'all' }, 'All types'),
        React.createElement('option', { value: 'trip' }, 'Trips'),
        React.createElement('option', { value: 'fuel' }, 'Fuel'),
        React.createElement('option', { value: 'booking' }, 'Bookings'),
        React.createElement('option', { value: 'payment' }, 'Payments'),
        React.createElement('option', { value: 'settlement' }, 'Settlements'),
        React.createElement('option', { value: 'settings' }, 'Settings'),
        React.createElement('option', { value: 'vehicle' }, 'System')
      ),
      React.createElement('select', { style: selectStyle, value: actorFilter, onChange: e => setActorFilter(e.target.value) },
        React.createElement('option', { value: 'all' }, 'All members'),
        React.createElement('option', { value: 'Christian' }, 'Christian'),
        React.createElement('option', { value: 'Lars' }, 'Lars'),
        React.createElement('option', { value: 'Sara' }, 'Sara'),
        React.createElement('option', { value: 'Mette' }, 'Mette'),
        React.createElement('option', { value: 'Anders' }, 'Anders')
      ),
      React.createElement('input', { type: 'date', style: { ...inputStyle, width: 130 }, defaultValue: '2026-06-24' }),
      React.createElement('input', { type: 'date', style: { ...inputStyle, width: 130 }, defaultValue: '2026-06-25' }),
      React.createElement('div', { style: { position: 'relative', flex: 1, minWidth: 160 } },
        React.createElement('span', { style: { position: 'absolute', left: 10, top: 8, pointerEvents: 'none' } },
          React.createElement(LucideIcon, { name: 'search', size: 16, color: '#6B8F7A' })
        ),
        React.createElement('input', { style: { ...inputStyle, width: '100%', paddingLeft: 34 }, placeholder: 'Search events\u2026', readOnly: true })
      )
    ),
    // Table
    React.createElement('div', { style: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)', overflow: 'hidden' } },
      React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
        React.createElement('thead', null,
          React.createElement('tr', { style: { background: '#FAFCFB', borderBottom: '1px solid #E2EDE8' } },
            ['Timestamp', 'Actor', 'Action', 'Entity', 'ID', 'Detail', ''].map(h =>
              React.createElement('th', { key: h, style: { padding: '9px 10px', fontSize: 10, fontWeight: 600, color: '#6B8F7A', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: h === '' ? 'center' : 'left', fontFamily: "'Inter',sans-serif" } }, h)
            )
          )
        ),
        React.createElement('tbody', null,
          filtered.map((row, i) => React.createElement(AuditRow, { key: i, row }))
        )
      )
    ),
    // Pagination
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, padding: '0 4px' } },
      React.createElement('span', { style: { fontSize: 12, color: '#6B8F7A', fontFamily: "'Inter',sans-serif" } }, 'Showing 1\u201320 of 247 events'),
      React.createElement('div', { style: { display: 'flex', gap: 6 } },
        React.createElement('button', { style: { ...inputStyle, padding: '0 14px', cursor: 'pointer', fontWeight: 500, color: '#6B8F7A', height: 30, fontSize: 12 }, disabled: true }, '\u2190 Previous'),
        React.createElement('button', { style: { ...inputStyle, padding: '0 14px', cursor: 'pointer', fontWeight: 500, color: '#2D6A4F', height: 30, fontSize: 12, background: '#D8F3DC', border: '1px solid #C4D9CD' } }, 'Next \u2192')
      )
    )
  );
}

window.AdminAuditContent = AdminAuditContent;
