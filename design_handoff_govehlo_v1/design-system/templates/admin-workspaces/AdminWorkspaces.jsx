const { Avatar, Badge } = window.GoVehloDesignSystem_c5fd4e || {};

// ── Palette ─────────────────────────────────────────────────────
var W = { deep:'#1A2E1F', forest:'#2D6A4F', leaf:'#52B788', mist:'#D8F3DC', muted:'#6B8F7A', border:'#E2EDE8', bg:'#F7F9F8', surface:'#fff', borderStrong:'#C4D9CD', err:'#D95050', errLt:'#FDEDED', errDk:'#8B2E2E' };

// ── Non-amber warning: burnt coral ──────────────────────────────
// Amber (#F4A261) is money-only. Health warnings use this instead.
var HEALTH = {
  ok:      { color:'#52B788', bg:'#D1F5E3', label:'Healthy' },
  warning: { color:'#C4673D', bg:'#FAEDE5', label:'Attention' },
  error:   { color:'#D95050', bg:'#FDEDED', label:'Error' },
};
var HEALTH_ORDER = { error:0, warning:1, ok:2 };

// ── Mock workspace data ─────────────────────────────────────────
var WS_DATA = [
  { id:'ws-fam-j', name:'Familien Jørgensen', initial:'FJ', color:'#2D6A4F', owner:'christian@chrjohn.dk', members:5, roles:'1 owner, 4 members', lastActive:'2 min ago', health:'ok', period:'Juni 2026', periodOverdue:false, staleRequests:0, errors7d:0 },
  { id:'ws-kontor', name:'Kontor Bilpool', initial:'KB', color:'#52B788', owner:'lars@bilpool.dk', members:8, roles:'1 owner, 2 admins, 5 members', lastActive:'1 hour ago', health:'warning', period:'Juni 2026', periodOverdue:false, staleRequests:2, errors7d:2 },
  { id:'ws-nabo', name:'Nabo-deling', initial:'ND', color:'#F4A261', owner:'mette@work.dk', members:3, roles:'1 owner, 2 members', lastActive:'3 hours ago', health:'error', period:null, periodOverdue:false, staleRequests:1, errors7d:3 },
  { id:'ws-hansen', name:'Hansen & Co Bilklub', initial:'HC', color:'#3D8B6A', owner:'peter@hansen.dk', members:4, roles:'1 owner, 1 admin, 2 members', lastActive:'Yesterday', health:'ok', period:'Juni 2026', periodOverdue:false, staleRequests:0, errors7d:0 },
  { id:'ws-kore', name:'Køreklub Nordsjælland', initial:'KN', color:'#2D6A4F', owner:'jonas@kore.dk', members:12, roles:'1 owner, 3 admins, 8 members', lastActive:'4 hours ago', health:'warning', period:'Maj 2026', periodOverdue:true, staleRequests:0, errors7d:1 },
  { id:'ws-pendler', name:'Pendler-gruppen', initial:'PG', color:'#52B788', owner:'anna@pendler.dk', members:6, roles:'1 owner, 1 admin, 4 members', lastActive:'30 min ago', health:'ok', period:'Juni 2026', periodOverdue:false, staleRequests:0, errors7d:0 },
  { id:'ws-sommer', name:'Sommerhus Tisvilde', initial:'ST', color:'#6B8F7A', owner:'erik@email.dk', members:4, roles:'1 owner, 3 members', lastActive:'2 days ago', health:'ok', period:null, periodOverdue:false, staleRequests:0, errors7d:0 },
];

var TOTALS = { workspaces:WS_DATA.length, members:0, attention:0, errors7d:0 };
WS_DATA.forEach(function(ws) { TOTALS.members += ws.members; TOTALS.errors7d += ws.errors7d; if (ws.health !== 'ok') TOTALS.attention++; });

// ── Styles ──────────────────────────────────────────────────────
var wsInputStyle = { height:34, border:'1px solid '+W.border, borderRadius:8, padding:'0 10px', fontSize:13, fontFamily:"'Inter',sans-serif", background:'#fff', color:W.deep, outline:'none' };

// ── Stat tile ───────────────────────────────────────────────────
function WsStat({ label, value, icon, color, bg }) {
  return React.createElement('div', { style:{ background:'#fff', borderRadius:12, padding:'16px 18px', boxShadow:'0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)', display:'flex', alignItems:'flex-start', gap:14, flex:'1 1 0', minWidth:140 }},
    React.createElement('div', { style:{ width:36, height:36, borderRadius:10, background:bg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }},
      React.createElement(LucideIcon, { name:icon, size:18, color:color })
    ),
    React.createElement('div', null,
      React.createElement('div', { style:{ fontFamily:"'Inter',sans-serif", fontSize:10, fontWeight:600, color:W.muted, textTransform:'uppercase', letterSpacing:'0.05em' }}, label),
      React.createElement('div', { style:{ fontFamily:"'Courier New',monospace", fontWeight:900, fontSize:28, color:W.deep, lineHeight:1.1, marginTop:2 }}, value)
    )
  );
}

// ── Health badge ────────────────────────────────────────────────
function HealthBadge({ health }) {
  var h = HEALTH[health] || HEALTH.ok;
  return React.createElement('span', { style:{
    display:'inline-flex', alignItems:'center', gap:5, fontSize:11, fontWeight:600,
    padding:'3px 10px', borderRadius:99, fontFamily:"'Inter',sans-serif",
    background:h.bg, color:h.color,
  }},
    React.createElement('span', { style:{ width:6, height:6, borderRadius:'50%', background:h.color, flexShrink:0 }}),
    h.label
  );
}

// ── Signal chip ─────────────────────────────────────────────────
function SignalChip({ label, type }) {
  var colors = {
    period:  { color:W.forest, bg:W.mist },
    overdue: { color:'#C4673D', bg:'#FAEDE5' },
    stale:   { color:'#C4673D', bg:'#FAEDE5' },
    error:   { color:W.err, bg:W.errLt },
  };
  var c = colors[type] || colors.period;
  return React.createElement('span', { style:{
    display:'inline-flex', alignItems:'center', gap:4, fontSize:10, fontWeight:500,
    padding:'2px 8px', borderRadius:6, fontFamily:"'Inter',sans-serif",
    background:c.bg, color:c.color, whiteSpace:'nowrap',
  }}, label);
}

// ── Workspace row ───────────────────────────────────────────────
function WorkspaceRow({ ws }) {
  var _h = React.useState(false), hovered = _h[0], setHovered = _h[1];

  var signals = [];
  if (ws.period) {
    signals.push({ type: ws.periodOverdue ? 'overdue' : 'period', label: (ws.periodOverdue ? '⚠ ' : '') + 'Open: ' + ws.period });
  }
  if (ws.staleRequests > 0) {
    signals.push({ type:'stale', label: ws.staleRequests + ' stale request' + (ws.staleRequests > 1 ? 's' : '') });
  }
  if (ws.errors7d > 0) {
    signals.push({ type:'error', label: ws.errors7d + ' error' + (ws.errors7d > 1 ? 's' : '') + ' (7d)' });
  }

  return React.createElement('div', {
    onClick: function(){},
    onMouseEnter: function(){ setHovered(true); },
    onMouseLeave: function(){ setHovered(false); },
    style:{
      display:'flex', alignItems:'center', gap:16, padding:'14px 18px',
      background: hovered ? '#FAFCFB' : '#fff',
      borderBottom:'1px solid #F0F4F2', cursor:'pointer',
      transition:'background 100ms ease, box-shadow 100ms ease',
      boxShadow: hovered ? '0 1px 4px rgba(26,46,31,.06)' : 'none',
    },
  },
    // Avatar
    React.createElement('div', { style:{
      width:40, height:40, borderRadius:10, background:ws.color, flexShrink:0,
      display:'flex', alignItems:'center', justifyContent:'center',
      color: ws.color === '#F4A261' ? W.deep : '#D8F3DC',
      fontSize:14, fontWeight:700, fontFamily:"'Nunito',sans-serif",
    }}, ws.initial),

    // Name + owner
    React.createElement('div', { style:{ minWidth:180, flex:'0 0 auto' }},
      React.createElement('div', { style:{ fontFamily:"'Nunito',sans-serif", fontWeight:700, fontSize:14, color:W.deep, lineHeight:1.2 }}, ws.name),
      React.createElement('div', { style:{ fontFamily:"'Inter',sans-serif", fontSize:11, color:W.muted, marginTop:2 }}, ws.owner)
    ),

    // Members + roles
    React.createElement('div', { style:{ flex:'0 0 auto', minWidth:120 }},
      React.createElement('div', { style:{ fontFamily:"'Courier New',monospace", fontSize:13, fontWeight:700, color:W.deep }}, ws.members),
      React.createElement('div', { style:{ fontFamily:"'Inter',sans-serif", fontSize:10, color:W.muted, marginTop:1 }}, ws.roles)
    ),

    // Last activity
    React.createElement('div', { style:{ flex:'0 0 auto', minWidth:90, fontFamily:"'Inter',sans-serif", fontSize:12, color:W.muted }}, ws.lastActive),

    // Health badge
    React.createElement('div', { style:{ flex:'0 0 auto', minWidth:90 }},
      React.createElement(HealthBadge, { health:ws.health })
    ),

    // Signal chips
    React.createElement('div', { style:{ flex:1, display:'flex', gap:6, flexWrap:'wrap', justifyContent:'flex-end' }},
      signals.length > 0
        ? signals.map(function(s, i) { return React.createElement(SignalChip, { key:i, type:s.type, label:s.label }); })
        : React.createElement('span', { style:{ fontSize:11, color:'#C4D9CD', fontFamily:"'Inter',sans-serif" }}, 'No issues')
    ),

    // Chevron
    React.createElement('div', { style:{ flexShrink:0, color: hovered ? W.forest : W.muted, transition:'color 100ms ease' }},
      React.createElement(LucideIcon, { name:'chevron-right', size:18 })
    )
  );
}

// ── Skeleton loading ────────────────────────────────────────────
function WsSkeletonRows() {
  var shimmer = { background:'linear-gradient(90deg, '+W.border+' 25%, #F0F4F2 50%, '+W.border+' 75%)', backgroundSize:'200% 100%', animation:'wsShimmer 1.5s infinite', borderRadius:4 };
  var rows = [];
  for (var i = 0; i < 5; i++) {
    rows.push(React.createElement('div', { key:i, style:{ display:'flex', alignItems:'center', gap:16, padding:'16px 18px', borderBottom:'1px solid #F0F4F2' }},
      React.createElement('div', { style:Object.assign({}, shimmer, { width:40, height:40, borderRadius:10 }) }),
      React.createElement('div', { style:{ display:'flex', flexDirection:'column', gap:6, minWidth:180 }},
        React.createElement('div', { style:Object.assign({}, shimmer, { width:140, height:14 }) }),
        React.createElement('div', { style:Object.assign({}, shimmer, { width:100, height:10 }) })
      ),
      React.createElement('div', { style:Object.assign({}, shimmer, { width:50, height:14 }) }),
      React.createElement('div', { style:Object.assign({}, shimmer, { width:80, height:12 }) }),
      React.createElement('div', { style:Object.assign({}, shimmer, { width:70, height:24, borderRadius:99 }) }),
      React.createElement('div', { style:{ flex:1 }}),
      React.createElement('div', { style:Object.assign({}, shimmer, { width:80, height:20, borderRadius:6 }) })
    ));
  }
  return React.createElement(React.Fragment, null, rows);
}

// ── Error banner (reuse DS pattern) ─────────────────────────────
function WsErrorBanner({ message, onRetry }) {
  return React.createElement('div', { style:{ display:'flex', alignItems:'flex-start', gap:10, padding:'12px 14px', background:W.errLt, borderRadius:12, borderLeft:'3px solid '+W.err, marginBottom:16 }},
    React.createElement('span', { style:{ width:20, height:20, borderRadius:'50%', background:W.err, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:800, flexShrink:0, marginTop:1 }}, '!'),
    React.createElement('div', { style:{ flex:1 }},
      React.createElement('p', { style:{ fontFamily:"'Inter',sans-serif", fontSize:13, fontWeight:500, color:W.errDk, margin:0, lineHeight:1.45 }}, message),
      onRetry && React.createElement('button', {
        onClick:onRetry,
        style:{ marginTop:6, fontFamily:"'Inter',sans-serif", fontSize:12, fontWeight:600, color:W.err, background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline' },
      }, 'Retry')
    )
  );
}

// ── Main component ──────────────────────────────────────────────
function AdminWorkspacesContent(props) {
  var viewState = (props && props.viewState) || 'Normal';
  var _s = React.useState(''), search = _s[0], setSearch = _s[1];

  var isLoading = viewState === 'Loading';
  var isError = viewState === 'Error';

  // Sort: problems first, then alphabetical
  var sorted = WS_DATA.slice().sort(function(a, b) {
    var ha = HEALTH_ORDER[a.health] || 9, hb = HEALTH_ORDER[b.health] || 9;
    if (ha !== hb) return ha - hb;
    return a.name.localeCompare(b.name);
  });

  // Filter by search
  var filtered = sorted.filter(function(ws) {
    if (!search) return true;
    var q = search.toLowerCase();
    return ws.name.toLowerCase().indexOf(q) !== -1 || ws.owner.toLowerCase().indexOf(q) !== -1;
  });

  return React.createElement(AdminLayout, { activePage:'workspaces', pageTitle:'Workspaces', pageSubtitle: TOTALS.workspaces + ' groups · ' + TOTALS.members + ' total members', notificationCount:2 },

    // Error banner
    isError && React.createElement(WsErrorBanner, {
      message:'Couldn\'t load workspaces. The owner API returned 500 — check Render logs.',
      onRetry:function(){},
    }),

    // Shimmer keyframe
    React.createElement('style', null, '@keyframes wsShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}'),

    // Summary stats
    React.createElement('div', { style:{ display:'flex', gap:14, marginBottom:20 }},
      React.createElement(WsStat, { label:'Workspaces', value:String(TOTALS.workspaces), icon:'layout-grid', color:W.forest, bg:W.mist }),
      React.createElement(WsStat, { label:'Members', value:String(TOTALS.members), icon:'users', color:W.forest, bg:W.mist }),
      React.createElement(WsStat, { label:'Need attention', value:String(TOTALS.attention), icon:'alert-triangle', color: TOTALS.attention > 0 ? '#C4673D' : W.leaf, bg: TOTALS.attention > 0 ? '#FAEDE5' : '#D1F5E3' }),
      React.createElement(WsStat, { label:'Errors (7d)', value:String(TOTALS.errors7d), icon:'zap', color: TOTALS.errors7d > 0 ? W.err : W.leaf, bg: TOTALS.errors7d > 0 ? W.errLt : '#D1F5E3' })
    ),

    // Search bar
    React.createElement('div', { style:{ marginBottom:16 }},
      React.createElement('div', { style:{ position:'relative', maxWidth:320 }},
        React.createElement('span', { style:{ position:'absolute', left:10, top:8, pointerEvents:'none' }},
          React.createElement(LucideIcon, { name:'search', size:16, color:W.muted })
        ),
        React.createElement('input', {
          style:Object.assign({}, wsInputStyle, { width:'100%', paddingLeft:34 }),
          placeholder:'Search workspaces\u2026',
          value:search,
          onChange:function(ev){ setSearch(ev.target.value); },
        })
      )
    ),

    // Column headers
    !isError && React.createElement('div', { style:{ background:'#fff', borderRadius:12, boxShadow:'0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)', overflow:'hidden' }},
      React.createElement('div', { style:{ display:'flex', alignItems:'center', gap:16, padding:'10px 18px', background:'#FAFCFB', borderBottom:'1px solid '+W.border }},
        React.createElement('div', { style:{ width:40 }}),
        React.createElement('div', { style:{ minWidth:180, flex:'0 0 auto', fontSize:10, fontWeight:600, color:W.muted, textTransform:'uppercase', letterSpacing:'0.06em', fontFamily:"'Inter',sans-serif" }}, 'Workspace'),
        React.createElement('div', { style:{ flex:'0 0 auto', minWidth:120, fontSize:10, fontWeight:600, color:W.muted, textTransform:'uppercase', letterSpacing:'0.06em', fontFamily:"'Inter',sans-serif" }}, 'Members'),
        React.createElement('div', { style:{ flex:'0 0 auto', minWidth:90, fontSize:10, fontWeight:600, color:W.muted, textTransform:'uppercase', letterSpacing:'0.06em', fontFamily:"'Inter',sans-serif" }}, 'Last active'),
        React.createElement('div', { style:{ flex:'0 0 auto', minWidth:90, fontSize:10, fontWeight:600, color:W.muted, textTransform:'uppercase', letterSpacing:'0.06em', fontFamily:"'Inter',sans-serif" }}, 'Health'),
        React.createElement('div', { style:{ flex:1, fontSize:10, fontWeight:600, color:W.muted, textTransform:'uppercase', letterSpacing:'0.06em', fontFamily:"'Inter',sans-serif", textAlign:'right' }}, 'Signals'),
        React.createElement('div', { style:{ width:18 }})
      ),

      // Rows
      isLoading
        ? React.createElement(WsSkeletonRows)
        : filtered.length === 0
          ? React.createElement('div', { style:{ textAlign:'center', padding:'48px 24px' }},
              React.createElement('div', { style:{ fontFamily:"'Nunito',sans-serif", fontWeight:700, fontSize:15, color:W.deep, marginBottom:4 }}, 'No workspaces match'),
              React.createElement('div', { style:{ fontFamily:"'Inter',sans-serif", fontSize:13, color:W.muted }}, 'Try a different search term.')
            )
          : filtered.map(function(ws) { return React.createElement(WorkspaceRow, { key:ws.id, ws:ws }); })
    ),

    // Footer count
    !isError && !isLoading && filtered.length > 0 && React.createElement('div', { style:{ marginTop:12, padding:'0 4px', fontSize:12, color:W.muted, fontFamily:"'Inter',sans-serif" }},
      'Showing ' + filtered.length + ' of ' + WS_DATA.length + ' workspaces · Sorted by health'
    )
  );
}

window.AdminWorkspacesContent = AdminWorkspacesContent;
