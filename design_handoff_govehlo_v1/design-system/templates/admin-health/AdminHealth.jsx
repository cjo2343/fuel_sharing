const { Button } = window.GoVehloDesignSystem_c5fd4e || {};

const HEALTH_CARDS = [
  { title: 'Supabase Connection', status: 'ok', statusLabel: 'Connected', value: '42 ms', detail: 'Last probe 2 min ago', icon: 'database' },
  { title: 'Render Service', status: 'ok', statusLabel: 'Running', value: '14d 6h', detail: 'Uptime · v452 · No cold-start issues', icon: 'server' },
  { title: 'Database Tables', status: 'ok', statusLabel: 'All matched', value: '5 / 47 / 12 / 3 / 8', detail: 'Members · Trips · Fuel · Periods · Requests', icon: 'table-2' },
  { title: 'Read Mode', status: 'ok', statusLabel: 'Active', value: 'Normalized', detail: 'Tables primary, JSON fallback/backup', icon: 'check-circle' },
  { title: 'Open Period', status: 'ok', statusLabel: '1 open', value: 'Juni 2026', detail: 'ID a3f7\u2026c2d1 · Status: open', icon: 'calendar' },
  { title: 'Settlement Requests', status: 'warning', statusLabel: '2 stale', value: '6 current', detail: '6 current requests, 2 stale active rows', icon: 'arrow-up-down', action: 'clean' },
  { title: 'Soft-Deleted Rows', status: 'info', statusLabel: 'Audit kept', value: '3 trips, 1 fuel', detail: 'Soft-deleted rows kept for history', icon: 'trash-2', action: 'purge' },
  { title: 'JSON Backup', status: 'ok', statusLabel: 'Fresh', value: '14:32 today', detail: 'Last snapshot · State matches app (5/47/12)', icon: 'hard-drive' },
  { title: 'Vehicle Provider', status: 'ok', statusLabel: 'Available', value: 'Nummerplade Tjek', detail: 'Last lookup 09:15 today · No errors', icon: 'car' },
];

const STATUS_COLORS = { ok: '#52B788', warning: '#F4A261', error: '#D95050', info: '#6B8F7A' };
const STATUS_BG = { ok: '#D1F5E3', warning: '#FDE8D8', error: '#FDEDED', info: '#EAEFEC' };

function HealthCard({ card }) {
  const color = STATUS_COLORS[card.status];
  const bg = STATUS_BG[card.status];
  const BtnC = Button || (({ children, ...p }) => React.createElement('button', { style: { fontSize: 12, padding: '5px 12px', borderRadius: 8, border: '1px solid #E2EDE8', background: '#fff', cursor: 'pointer', fontFamily: "'Inter',sans-serif", fontWeight: 500, color: '#1A2E1F' }, ...p }, children));

  return React.createElement('div', {
    style: {
      background: '#fff', borderRadius: 12, padding: '18px 20px',
      boxShadow: '0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)',
      borderLeft: '4px solid ' + color,
      display: 'flex', flexDirection: 'column', gap: 8, minHeight: 130,
    }
  },
    // Header
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      React.createElement('div', { style: { width: 32, height: 32, borderRadius: 8, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
        React.createElement(LucideIcon, { name: card.icon, size: 16, color })
      ),
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement('div', { style: { fontFamily: "'Nunito',sans-serif", fontWeight: 700, fontSize: 14, color: '#1A2E1F', lineHeight: 1.2 } }, card.title),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 } },
          React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 } }),
          React.createElement('span', { style: { fontFamily: "'Inter',sans-serif", fontSize: 11, fontWeight: 500, color } }, card.statusLabel)
        )
      )
    ),
    // Value
    React.createElement('div', { style: { fontFamily: "'Nunito',sans-serif", fontWeight: 900, fontSize: 22, color: '#1A2E1F', lineHeight: 1.15 } }, card.value),
    // Detail
    React.createElement('div', { style: { fontFamily: "'Inter',sans-serif", fontSize: 12, color: '#6B8F7A', lineHeight: 1.4, marginTop: 'auto' } }, card.detail),
    // Action button
    card.action && React.createElement('div', { style: { marginTop: 4 } },
      card.action === 'clean'
        ? React.createElement(BtnC, { variant: 'danger', size: 'sm', onClick: () => {} }, 'Clean stale requests')
        : React.createElement(BtnC, { variant: 'outline', size: 'sm', onClick: () => {} }, 'Purge test rows')
    )
  );
}

function AdminHealthContent() {
  const now = new Date().toLocaleString('da-DK', { dateStyle: 'medium', timeStyle: 'short' });
  return React.createElement(AdminLayout, { activePage: 'health', pageTitle: 'System Health', pageSubtitle: 'All systems operational \u00b7 Last checked ' + now, notificationCount: 2 },
    // Summary strip
    React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' } },
      [
        { label: 'Services', count: '3/3', color: '#52B788', text: 'healthy' },
        { label: 'Warnings', count: '2', color: '#F4A261', text: 'active' },
        { label: 'Errors', count: '0', color: '#52B788', text: 'none' },
        { label: 'Uptime', count: '99.8%', color: '#52B788', text: '30 days' },
      ].map((s, i) =>
        React.createElement('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(26,46,31,.06)', flex: '1 1 160px', minWidth: 140 } },
          React.createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 } }),
          React.createElement('div', null,
            React.createElement('div', { style: { fontFamily: "'Nunito',sans-serif", fontWeight: 800, fontSize: 18, color: '#1A2E1F', lineHeight: 1.1 } }, s.count),
            React.createElement('div', { style: { fontFamily: "'Inter',sans-serif", fontSize: 11, color: '#6B8F7A' } }, s.label + ' \u00b7 ' + s.text)
          )
        )
      )
    ),
    // Cards grid
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 } },
      HEALTH_CARDS.map((card, i) => React.createElement(HealthCard, { key: i, card }))
    )
  );
}

window.AdminHealthContent = AdminHealthContent;
