const { Avatar, Badge, Card } = window.GoVehloDesignSystem_c5fd4e || {};

const STAT_TILES = [
  { label: 'Active users', value: '5', icon: 'users', color: '#52B788', bg: '#D1F5E3' },
  { label: 'Trips this period', value: '47', icon: 'map-pin', color: '#2D6A4F', bg: '#D8F3DC' },
  { label: 'Fuel entries', value: '12', icon: 'fuel', color: '#2D6A4F', bg: '#D8F3DC' },
  { label: 'Pending settlements', value: '3', icon: 'arrow-up-down', color: '#F4A261', bg: '#FDE8D8' },
  { label: 'Errors (24h)', value: '0', icon: 'alert-circle', color: '#52B788', bg: '#D1F5E3', good: true },
  { label: 'Warnings (24h)', value: '2', icon: 'alert-triangle', color: '#F4A261', bg: '#FDE8D8' },
];

const HEALTH_ITEMS = [
  { label: 'Supabase', status: 'Connected', detail: '42 ms', color: '#52B788' },
  { label: 'Render', status: 'Running', detail: 'v452', color: '#52B788' },
  { label: 'Database', status: 'Matched', detail: '5 / 47 / 12', color: '#52B788' },
];

const ACTIVITY = [
  { time: '14:32', actor: 'Christian Jørgensen', type: 'trip_created', badge: 'success', entity: 'Trip', detail: 'Lyngby → Holte, 12 km', id: 'a3f7' },
  { time: '14:28', actor: 'Lars Nielsen', type: 'fuel_created', badge: 'success', entity: 'Fuel', detail: 'Circle K Lyngby, 45,20 kr, 3,2 L', id: 'b8e2' },
  { time: '14:15', actor: 'Sara Andersen', type: 'payment_requested', badge: 'money', entity: 'Payment', detail: 'Requested 127,50 kr from Mette', id: 'c4d9' },
  { time: '13:58', actor: 'Christian Jørgensen', type: 'trip_updated', badge: 'pending', entity: 'Trip', detail: 'Updated end odometer 45.892 → 45.905 km', id: 'd1a3' },
  { time: '13:42', actor: 'Mette Hansen', type: 'booking_created', badge: 'success', entity: 'Booking', detail: 'Booked car for 27. jun, 09:00–17:00', id: 'e7f5' },
  { time: '13:30', actor: 'Anders Pedersen', type: 'payment_marked_paid', badge: 'success', entity: 'Payment', detail: 'Marked 52,00 kr to Lars as paid', id: 'f2b8' },
  { time: '12:55', actor: 'Lars Nielsen', type: 'trip_deleted', badge: 'error', entity: 'Trip', detail: 'Deleted duplicate trip entry', id: 'g9c1' },
  { time: '12:40', actor: 'Christian Jørgensen', type: 'settings_saved', badge: 'neutral', entity: 'Settings', detail: 'Updated fuel fallback price 14,50 → 15,20 kr/L', id: 'h3d7' },
  { time: '11:20', actor: 'Sara Andersen', type: 'fuel_created', badge: 'success', entity: 'Fuel', detail: 'OK Holte, 389,00 kr, 28,4 L, full tank', id: 'i5e9' },
  { time: '11:05', actor: 'Mette Hansen', type: 'trip_created', badge: 'success', entity: 'Trip', detail: 'Virum → Kgs. Lyngby, 8 km', id: 'j6f0' },
  { time: '10:30', actor: 'Anders Pedersen', type: 'vehicle_lookup', badge: 'neutral', entity: 'System', detail: 'Vehicle lookup completed for AB 12 345', id: 'k7g2' },
  { time: '09:45', actor: 'Christian Jørgensen', type: 'settlement_closed', badge: 'forest', entity: 'Settlement', detail: 'Closed period Maj 2026, 5 settlements', id: 'l8h4' },
  { time: '09:15', actor: 'Lars Nielsen', type: 'booking_deleted', badge: 'error', entity: 'Booking', detail: 'Cancelled booking for 25. jun', id: 'm9i6' },
  { time: 'Yesterday', actor: 'Sara Andersen', type: 'payment_reopened', badge: 'pending', entity: 'Payment', detail: 'Reopened 89,00 kr settlement with Anders', id: 'n0j8' },
  { time: 'Yesterday', actor: 'Christian Jørgensen', type: 'fuel_updated', badge: 'pending', entity: 'Fuel', detail: 'Corrected liters 28,4 → 27,8 L at OK Holte', id: 'o1k9' },
];

const ACTION_LABELS = {
  trip_created: 'Created', trip_updated: 'Updated', trip_deleted: 'Deleted',
  fuel_created: 'Created', fuel_updated: 'Updated', fuel_deleted: 'Deleted',
  booking_created: 'Created', booking_updated: 'Updated', booking_deleted: 'Cancelled',
  payment_requested: 'Requested', payment_marked_paid: 'Paid', payment_reopened: 'Reopened',
  settlement_closed: 'Closed', settings_saved: 'Saved', vehicle_lookup: 'Lookup',
};

function StatTile({ label, value, icon, color, bg }) {
  return React.createElement('div', {
    style: { background: '#fff', borderRadius: 12, padding: '16px 18px', boxShadow: '0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)', display: 'flex', alignItems: 'flex-start', gap: 14, minWidth: 0 }
  },
    React.createElement('div', { style: { width: 36, height: 36, borderRadius: 10, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
      React.createElement(LucideIcon, { name: icon, size: 18, color })
    ),
    React.createElement('div', { style: { minWidth: 0 } },
      React.createElement('div', { style: { fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 500, color: '#6B8F7A', textTransform: 'uppercase', letterSpacing: '0.05em' } }, label),
      React.createElement('div', { style: { fontFamily: "'Nunito', sans-serif", fontWeight: 900, fontSize: 28, color: '#1A2E1F', lineHeight: 1.1, marginTop: 2 } }, value)
    )
  );
}

function HealthMini({ label, status, detail, color }) {
  return React.createElement('div', {
    style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(26,46,31,.06)', flex: 1, minWidth: 0 }
  },
    React.createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 } }),
    React.createElement('span', { style: { fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600, color: '#1A2E1F' } }, label),
    React.createElement('span', { style: { fontFamily: "'Inter', sans-serif", fontSize: 12, color: '#6B8F7A' } }, status),
    React.createElement('span', { style: { marginLeft: 'auto', fontFamily: "'Courier New', monospace", fontSize: 11, color: '#6B8F7A', flexShrink: 0 } }, detail)
  );
}

function ActivityRow({ row }) {
  const AvatarC = Avatar || (({ name }) => React.createElement('div', { style: { width: 24, height: 24, borderRadius: '50%', background: '#2D6A4F', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 9, fontWeight: 700, fontFamily: "'Nunito',sans-serif", flexShrink: 0 } }, name.split(' ').map(n => n[0]).join('')));
  const BadgeC = Badge || (({ variant, children }) => React.createElement('span', { style: { fontSize: 11, padding: '2px 8px', borderRadius: 99, background: '#D8F3DC', color: '#2D6A4F', fontWeight: 500 } }, children));
  return React.createElement('tr', { style: { borderBottom: '1px solid #F0F4F2' } },
    React.createElement('td', { style: { padding: '8px 12px', fontFamily: "'Courier New', monospace", fontSize: 11, color: '#6B8F7A', whiteSpace: 'nowrap' } }, row.time),
    React.createElement('td', { style: { padding: '8px 8px', whiteSpace: 'nowrap' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement(AvatarC, { name: row.actor, size: 'xs' }),
        React.createElement('span', { style: { fontSize: 13, fontWeight: 500, color: '#1A2E1F', fontFamily: "'Inter',sans-serif" } }, row.actor.split(' ')[0])
      )
    ),
    React.createElement('td', { style: { padding: '8px 8px' } },
      React.createElement(BadgeC, { variant: row.badge, size: 'sm' }, ACTION_LABELS[row.type] || row.type)
    ),
    React.createElement('td', { style: { padding: '8px 8px', fontSize: 12, color: '#3D5C48', fontFamily: "'Inter',sans-serif", fontWeight: 500 } }, row.entity),
    React.createElement('td', { style: { padding: '8px 12px', fontSize: 12, color: '#6B8F7A', fontFamily: "'Inter',sans-serif", maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.detail)
  );
}

function AdminDashboardContent() {
  return React.createElement(AdminLayout, { activePage: 'dashboard', pageTitle: 'Dashboard', pageSubtitle: 'Familien Jørgensen · Last updated 2 minutes ago', notificationCount: 2 },
    // Stat tiles
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 } },
      STAT_TILES.map((t, i) => React.createElement(StatTile, { key: i, ...t }))
    ),
    // Health strip
    React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 24 } },
      HEALTH_ITEMS.map((h, i) => React.createElement(HealthMini, { key: i, ...h }))
    ),
    // Section header
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 } },
      React.createElement('h2', { style: { fontFamily: "'Nunito', sans-serif", fontWeight: 700, fontSize: 17, color: '#1A2E1F', margin: 0 } }, 'Recent activity'),
      React.createElement('span', { style: { fontSize: 12, color: '#2D6A4F', fontWeight: 500, cursor: 'pointer', fontFamily: "'Inter',sans-serif" } }, 'View all →')
    ),
    // Activity table
    React.createElement('div', { style: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)', overflow: 'hidden' } },
      React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
        React.createElement('thead', null,
          React.createElement('tr', { style: { background: '#FAFCFB', borderBottom: '1px solid #E2EDE8' } },
            ['Time', 'Actor', 'Action', 'Entity', 'Detail'].map(h =>
              React.createElement('th', { key: h, style: { padding: '10px 12px', fontSize: 11, fontWeight: 600, color: '#6B8F7A', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'left', fontFamily: "'Inter',sans-serif" } }, h)
            )
          )
        ),
        React.createElement('tbody', null,
          ACTIVITY.map((row, i) => React.createElement(ActivityRow, { key: i, row }))
        )
      )
    )
  );
}

window.AdminDashboardContent = AdminDashboardContent;
