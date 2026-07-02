(function() {
var Avatar = (window.GoVehloDesignSystem_c5fd4e || {}).Avatar;

var adminLayoutStyles = {
  root: { display: 'flex', height: '100vh', overflow: 'hidden', fontFamily: "'Inter', system-ui, sans-serif" },
  sidebar: { width: 240, flexShrink: 0, background: '#1A2E1F', display: 'flex', flexDirection: 'column', color: '#fff' },
  sidebarHeader: { padding: '20px 20px 16px', display: 'flex', alignItems: 'center', gap: 10 },
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
  wsSwitcher: { position: 'relative', padding: '0 12px', marginBottom: 12 },
  wsTrigger: function(open) { return {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
    padding: '10px 12px', background: open ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
    border: 'none', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
    transition: 'background 140ms ease',
  }; },
  wsAvatar: function(color) { return {
    width: 28, height: 28, borderRadius: 8, background: color,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: color === '#F4A261' ? '#1A2E1F' : '#D8F3DC',
    fontSize: 11, fontWeight: 700, fontFamily: "'Nunito',sans-serif", flexShrink: 0,
  }; },
  wsDropdown: { marginTop: 6, background: '#243A2A', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 10, padding: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.3)', animation: 'wsDropIn 160ms ease-out' },
  wsItem: function(active, hov) { return {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
    padding: '8px 10px', border: 'none', textAlign: 'left',
    background: active ? 'rgba(255,255,255,0.08)' : hov ? 'rgba(255,255,255,0.05)' : 'transparent',
    borderRadius: 8, cursor: 'pointer', marginTop: 2, transition: 'background 120ms ease',
  }; },
  wsItemAvatar: function(color) { return {
    width: 24, height: 24, borderRadius: 6, background: color,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: color === '#F4A261' ? '#1A2E1F' : '#D8F3DC',
    fontSize: 9, fontWeight: 700, fontFamily: "'Nunito',sans-serif", flexShrink: 0,
  }; },
};

var NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
  { id: 'audit', label: 'Audit Log', icon: 'scroll-text' },
  { id: 'health', label: 'System Health', icon: 'activity' },
];

var WORKSPACES = [
  { id: 'fam-j', name: 'Familien Jørgensen', members: 5, color: '#2D6A4F', initial: 'FJ', role: 'Owner' },
  { id: 'kontor', name: 'Kontor Bilpool', members: 8, color: '#52B788', initial: 'KB', role: 'Admin' },
  { id: 'nabo', name: 'Nabo-deling', members: 3, color: '#F4A261', initial: 'ND', role: 'Member' },
];

// Inject workspace dropdown animation
var _wsStyle = document.createElement('style');
_wsStyle.textContent = '@keyframes wsDropIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}';
document.head.appendChild(_wsStyle);

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

function WorkspaceSwitcher() {
  var _o = React.useState(false), open = _o[0], setOpen = _o[1];
  var _a = React.useState('fam-j'), activeId = _a[0], setActiveId = _a[1];
  var _h = React.useState(null), hovered = _h[0], setHovered = _h[1];
  var ref = React.useRef(null);
  var s = adminLayoutStyles;
  var active = WORKSPACES.find(function(w) { return w.id === activeId; }) || WORKSPACES[0];

  React.useEffect(function() {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handler);
    return function() { document.removeEventListener('mousedown', handler); };
  }, []);

  return React.createElement('div', { ref: ref, style: s.wsSwitcher },
    // Trigger
    React.createElement('button', {
      onClick: function() { setOpen(!open); },
      onMouseEnter: function(e) { if (!open) e.currentTarget.style.background = 'rgba(255,255,255,0.10)'; },
      onMouseLeave: function(e) { e.currentTarget.style.background = open ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)'; },
      style: s.wsTrigger(open),
    },
      React.createElement('div', { style: s.wsAvatar(active.color) }, active.initial),
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: "'Inter',sans-serif" } }, active.name),
        React.createElement('div', { style: { fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 1, fontFamily: "'Inter',sans-serif" } }, active.members + ' members')
      ),
      React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', style: { flexShrink: 0, color: open ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.4)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms ease' } },
        React.createElement('path', { d: 'M3.5 5.25L7 8.75L10.5 5.25', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })
      )
    ),
    // Dropdown
    open && React.createElement('div', { style: s.wsDropdown },
      WORKSPACES.map(function(ws, i) {
        var isActive = ws.id === activeId;
        var isHov = hovered === ws.id;
        return React.createElement('button', {
          key: ws.id,
          onClick: function() { setActiveId(ws.id); setOpen(false); },
          onMouseEnter: function() { setHovered(ws.id); },
          onMouseLeave: function() { setHovered(null); },
          style: Object.assign({}, s.wsItem(isActive, isHov), i === 0 ? { marginTop: 0 } : {}),
        },
          React.createElement('div', { style: s.wsItemAvatar(ws.color) }, ws.initial),
          React.createElement('div', { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: { fontSize: 12, fontWeight: isActive ? 600 : 500, color: isActive ? '#fff' : 'rgba(255,255,255,0.8)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: "'Inter',sans-serif" } }, ws.name),
            React.createElement('div', { style: { fontSize: 10, color: isActive ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.35)', fontFamily: "'Inter',sans-serif" } }, ws.members + ' members \u00b7 ' + ws.role)
          ),
          isActive && React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', style: { flexShrink: 0, color: '#52B788' } },
            React.createElement('path', { d: 'M3 7L6 10L11 4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })
          )
        );
      }),
      React.createElement('div', { style: { height: 1, background: 'rgba(255,255,255,0.08)', margin: '6px 4px' } }),
      React.createElement('button', {
        style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', borderRadius: 8, cursor: 'pointer', background: 'transparent', textAlign: 'left', transition: 'background 120ms ease' },
        onMouseEnter: function(e) { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; },
        onMouseLeave: function(e) { e.currentTarget.style.background = 'transparent'; },
      },
        React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', style: { flexShrink: 0, color: 'rgba(255,255,255,0.4)' } },
          React.createElement('path', { d: 'M8 3.5V12.5M3.5 8H12.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })
        ),
        React.createElement('span', { style: { fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.5)', fontFamily: "'Inter',sans-serif" } }, 'Create new group')
      )
    )
  );
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
      React.createElement(WorkspaceSwitcher, null),
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
window.WorkspaceSwitcher = WorkspaceSwitcher;
})();
