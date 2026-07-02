(function() {
var Avatar = (window.GoVehloDesignSystem_c5fd4e || {}).Avatar;

var adminLayoutStyles = {
  root: { display: 'flex', height: '100vh', overflow: 'hidden', fontFamily: "'Inter', system-ui, sans-serif" },
  sidebar: { width: 240, flexShrink: 0, background: '#1A2E1F', display: 'flex', flexDirection: 'column', color: '#fff' },
  sidebarHeader: { padding: '20px 20px 24px', display: 'flex', alignItems: 'center', gap: 10 },
  sidebarLogo: { width: 32, height: 32, borderRadius: 8, background: '#2D6A4F', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  sidebarTitle: { fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18, color: '#fff', letterSpacing: '-0.01em' },
  sidebarSubtitle: { fontFamily: "'Inter', sans-serif", fontSize: 10, color: 'rgba(255,255,255,0.45)', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 },
  nav: { flex: 1, padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 2 },
  navItem: (active) => ({
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
    borderRadius: 10, cursor: 'pointer', border: 'none', width: '100%', textAlign: 'left',
    background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
    color: active ? '#fff' : 'rgba(255,255,255,0.55)',
    fontFamily: "'Inter', sans-serif", fontWeight: active ? 600 : 400, fontSize: 14,
    transition: 'background 140ms ease, color 140ms ease',
  }),
  sidebarFooter: { padding: '16px 20px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 10 },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  topBar: { height: 56, flexShrink: 0, background: '#fff', borderBottom: '1px solid #E2EDE8', display: 'flex', alignItems: 'center', padding: '0 24px', gap: 16 },
  searchWrap: { flex: 1, maxWidth: 420, position: 'relative' },
  searchInput: { width: '100%', height: 36, border: '1px solid #E2EDE8', borderRadius: 8, padding: '0 12px 0 36px', fontSize: 13, fontFamily: "'Inter', sans-serif", background: '#F7F9F8', outline: 'none', color: '#1A2E1F' },
  searchIcon: { position: 'absolute', left: 10, top: 8, color: '#6B8F7A', pointerEvents: 'none' },
  bellWrap: { position: 'relative', cursor: 'pointer', padding: 6 },
  bellDot: (count) => ({ display: count > 0 ? 'flex' : 'none', position: 'absolute', top: 2, right: 2, width: 16, height: 16, borderRadius: '50%', background: '#D95050', color: '#fff', fontSize: 9, fontWeight: 700, alignItems: 'center', justifyContent: 'center', fontFamily: "'Inter', sans-serif" }),
  content: { flex: 1, overflow: 'auto', background: '#F7F9F8', padding: 24 },
  pageTitle: { fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 22, color: '#1A2E1F', margin: 0, lineHeight: 1.25 },
  pageSub: { fontFamily: "'Inter', sans-serif", fontSize: 13, color: '#6B8F7A', margin: '2px 0 0' },
};

var NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
  { id: 'audit', label: 'Audit Log', icon: 'scroll-text' },
  { id: 'health', label: 'System Health', icon: 'activity' },
];

function LucideIcon({ name, size = 18, color = 'currentColor' }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current && window.lucide) {
      ref.current.innerHTML = '';
      const el = document.createElement('i');
      el.setAttribute('data-lucide', name);
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      ref.current.appendChild(el);
      window.lucide.createIcons({ nodes: [el] });
    }
  }, [name, size]);
  return React.createElement('span', { ref, style: { display: 'inline-flex', alignItems: 'center', color, width: size, height: size } });
}

function AdminLayout({ activePage = 'dashboard', pageTitle, pageSubtitle, notificationCount = 0, children }) {
  const s = adminLayoutStyles;
  return React.createElement('div', { style: s.root },
    // Sidebar
    React.createElement('aside', { style: s.sidebar },
      React.createElement('div', { style: s.sidebarHeader },
        React.createElement('div', { style: s.sidebarLogo },
          React.createElement('svg', { width: 18, height: 18, viewBox: '0 0 512 512', fill: 'none' },
            React.createElement('path', { d: 'M 0 140 C 140 80 380 420 512 385', stroke: '#D8F3DC', strokeWidth: 44, fill: 'none', strokeLinecap: 'round' }),
            React.createElement('circle', { cx: 259, cy: 253, r: 22, fill: '#F4A261' })
          )
        ),
        React.createElement('div', null,
          React.createElement('div', { style: s.sidebarTitle }, 'GoVehlo'),
          React.createElement('div', { style: s.sidebarSubtitle }, 'Admin')
        )
      ),
      React.createElement('nav', { style: s.nav },
        NAV_ITEMS.map(item =>
          React.createElement('button', {
            key: item.id,
            style: s.navItem(activePage === item.id),
            onClick: () => {},
          },
            React.createElement(LucideIcon, { name: item.icon, size: 18 }),
            item.label
          )
        )
      ),
      React.createElement('div', { style: s.sidebarFooter },
        Avatar ? React.createElement(Avatar, { name: 'Christian Jørgensen', size: 'sm' }) : React.createElement('div', { style: { width: 32, height: 32, borderRadius: '50%', background: '#2D6A4F' } }),
        React.createElement('div', null,
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: '#fff' } }, 'Christian J.'),
          React.createElement('div', { style: { fontSize: 10, color: 'rgba(255,255,255,0.5)' } }, 'App owner')
        )
      )
    ),
    // Main
    React.createElement('div', { style: s.main },
      React.createElement('header', { style: s.topBar },
        React.createElement('div', { style: s.searchWrap },
          React.createElement('span', { style: s.searchIcon },
            React.createElement(LucideIcon, { name: 'search', size: 16, color: '#6B8F7A' })
          ),
          React.createElement('input', { style: s.searchInput, placeholder: 'Search events, members, actions\u2026', readOnly: true })
        ),
        React.createElement('div', { style: s.bellWrap },
          React.createElement(LucideIcon, { name: 'bell', size: 20, color: '#6B8F7A' }),
          React.createElement('span', { style: s.bellDot(notificationCount) }, notificationCount > 0 ? notificationCount : '')
        ),
        React.createElement('div', { style: { width: 1, height: 28, background: '#E2EDE8' } }),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          Avatar ? React.createElement(Avatar, { name: 'Christian Jørgensen', size: 'sm' }) : null,
          React.createElement('span', { style: { fontSize: 13, fontWeight: 500, color: '#1A2E1F' } }, 'Christian J.')
        )
      ),
      React.createElement('main', { style: s.content },
        (pageTitle || pageSubtitle) && React.createElement('div', { style: { marginBottom: 20 } },
          pageTitle && React.createElement('h1', { style: s.pageTitle }, pageTitle),
          pageSubtitle && React.createElement('p', { style: s.pageSub }, pageSubtitle)
        ),
        children
      )
    )
  );
}

window.AdminLayout = AdminLayout;
window.LucideIcon = LucideIcon;
})();
