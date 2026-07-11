const { Avatar, Badge } = window.GoVehloDesignSystem_c5fd4e || {};

// ── Palette (error-red tone, no amber) ──────────────────────────
var E = { err:'#D95050', errLt:'#FDEDED', errDk:'#8B2E2E', deep:'#1A2E1F', forest:'#2D6A4F', leaf:'#52B788', mist:'#D8F3DC', muted:'#6B8F7A', border:'#E2EDE8', bg:'#F7F9F8', surface:'#fff', borderStrong:'#C4D9CD' };

// ── Mock error data (shape mirrors the live /api/owner/errors rows) ──
var ERRORS = [
  { id:'err-7a2f', time:'2026-06-27 09:42:18', ws:'Familien Jørgensen', email:'christian@chrjohn.dk', action:'trip.create', route:'POST /api/trips', code:'VALIDATION_ERROR', http:422, summary:'Start odometer (45.890 km) overlaps previous trip end (45.904 km)', source:'activity-log', sentryId:null,
    meta:{ startOdo:'45890', endOdo:'null', wsId:'ws_██████', userId:'usr_██████' } },

  { id:'err-3d8e', time:'2026-06-27 08:15:33', ws:'Kontor Bilpool', email:'lars@bilpool.dk', action:'fuel.create', route:'POST /api/fuel', code:'DB_CONSTRAINT', http:500, summary:'duplicate key violates unique constraint "fuel_receipt_unique"', source:'sentry', sentryId:'GOVEHLO-4A2',
    meta:{ fuelId:'f_██████', station:'Circle K Lyngby', liters:'45.2', wsId:'ws_██████' } },

  { id:'err-c91a', time:'2026-06-27 07:30:05', ws:'Familien Jørgensen', email:'sara@email.dk', action:'settlement.calculate', route:'POST /api/settlements/calc', code:'TIMEOUT', http:504, summary:'Settlement calculation timed out after 30 000 ms (period Juni 2026, 47 trips)', source:'sentry', sentryId:'GOVEHLO-4A3',
    meta:{ periodId:'per_██████', periodName:'Juni 2026', tripCount:'47', memberCount:'5' } },

  { id:'err-e4b7', time:'2026-06-27 06:55:41', ws:'Nabo-deling', email:'mette@work.dk', action:'auth.refresh', route:'POST /api/auth/refresh', code:'AUTH_EXPIRED', http:401, summary:'Refresh token expired — user session ended after 30-day inactivity', source:'activity-log', sentryId:null,
    meta:{ userId:'usr_██████', lastActive:'2026-05-28', tokenAge:'30d' } },

  { id:'err-f52c', time:'2026-06-26 22:10:09', ws:'Kontor Bilpool', email:'anders@mail.dk', action:'vehicle.lookup', route:'GET /api/vehicle/lookup', code:'EXTERNAL_API_ERROR', http:502, summary:'Nummerplade Tjek returned 502 — upstream provider unavailable', source:'sentry', sentryId:'GOVEHLO-4A4',
    meta:{ plate:'AB 12 345', provider:'nummerpladetjek.dk', responseMs:'8012' } },

  { id:'err-a08d', time:'2026-06-26 19:44:27', ws:'Familien Jørgensen', email:'christian@chrjohn.dk', action:'booking.create', route:'POST /api/bookings', code:'CONFLICT', http:409, summary:'Car already booked by Sara Andersen for 27. jun 09:00–17:00', source:'activity-log', sentryId:null,
    meta:{ date:'2026-06-27', from:'10:00', to:'15:00', conflictBooking:'bk_██████' } },

  { id:'err-b63f', time:'2026-06-26 17:22:13', ws:'Kontor Bilpool', email:'lars@bilpool.dk', action:'trip.update', route:'PATCH /api/trips/t_a3f7', code:'RLS_VIOLATION', http:403, summary:'Row-level security policy violation — user not member of target workspace', source:'activity-log', sentryId:null,
    meta:{ tripId:'t_██████', wsId:'ws_██████', policyName:'trips_workspace_member' } },

  { id:'err-d91e', time:'2026-06-26 15:08:52', ws:'Familien Jørgensen', email:'sara@email.dk', action:'settlement.recalc', route:'POST /api/settlements/recalc', code:'RATE_LIMITED', http:429, summary:'Rate limit exceeded — max 3 recalculations per hour per workspace', source:'activity-log', sentryId:null,
    meta:{ wsId:'ws_██████', limit:'3/hour', current:'4', retryAfter:'1847s' } },

  { id:'err-e2c4', time:'2026-06-26 13:35:06', ws:'Nabo-deling', email:'mette@work.dk', action:'webhook.mobilepay', route:'POST /api/webhooks/mobilepay', code:'WEBHOOK_VERIFY_FAILED', http:400, summary:'MobilePay webhook signature verification failed — possible replay attack', source:'sentry', sentryId:'GOVEHLO-4A5',
    meta:{ webhookId:'wh_██████', provider:'MobilePay', signaturePrefix:'91b2…' } },

  { id:'err-f7a1', time:'2026-06-26 11:20:33', ws:'Familien Jørgensen', email:'anders@mail.dk', action:'fuel.upload', route:'POST /api/fuel/receipt', code:'PAYLOAD_TOO_LARGE', http:413, summary:'Receipt image exceeds 5 MB limit (uploaded: 8,4 MB)', source:'activity-log', sentryId:null,
    meta:{ fileSize:'8847360', limit:'5242880', mimeType:'image/jpeg' } },

  { id:'err-a3b5', time:'2026-06-26 09:05:18', ws:'Kontor Bilpool', email:'lars@bilpool.dk', action:'settlement.calculate', route:'POST /api/settlements/calc', code:'DIVISION_BY_ZERO', http:500, summary:'Division by zero in cost split — period has 0 km total but active fuel entries', source:'sentry', sentryId:'GOVEHLO-4A6',
    meta:{ periodId:'per_██████', totalKm:'0', fuelEntries:'3', fuelTotal:'892.50 kr' } },

  { id:'err-c8d2', time:'2026-06-25 23:40:51', ws:'Familien Jørgensen', email:'christian@chrjohn.dk', action:'trip.update', route:'PATCH /api/trips/t_d1a3', code:'CONFLICT', http:409, summary:'Concurrent edit conflict — trip was modified by Sara 2 s ago', source:'activity-log', sentryId:null,
    meta:{ tripId:'t_██████', currentVersion:'3', attemptedVersion:'2', lastEditor:'sara@email.dk' } },

  { id:'err-d5e9', time:'2026-06-25 20:15:07', ws:'Kontor Bilpool', email:'anders@mail.dk', action:'invite.send', route:'POST /api/invites', code:'EMAIL_DELIVERY_FAILED', http:500, summary:'Workspace invite email delivery failed — Resend API returned 500', source:'activity-log', sentryId:null,
    meta:{ inviteeEmail:'new@██████.dk', provider:'Resend', errorBody:'internal server error' } },

  { id:'err-e1f3', time:'2026-06-25 16:48:29', ws:'Familien Jørgensen', email:'sara@email.dk', action:'fuel.create', route:'POST /api/fuel', code:'DB_CONNECTION', http:503, summary:'Supabase connection pool exhausted — all 20 connections in use', source:'sentry', sentryId:'GOVEHLO-4A7',
    meta:{ poolSize:'20', activeConnections:'20', waitQueue:'7' } },

  { id:'err-f4a8', time:'2026-06-25 14:22:55', ws:'Nabo-deling', email:'mette@work.dk', action:'trip.create', route:'POST /api/trips', code:'VALIDATION_ERROR', http:422, summary:'End odometer (12.340 km) is lower than start odometer (12.355 km)', source:'activity-log', sentryId:null,
    meta:{ startOdo:'12355', endOdo:'12340', wsId:'ws_██████' } },
];

// ── Filter styles (reuse audit patterns) ────────────────────────
var errInputStyle = { height:34, border:'1px solid '+E.border, borderRadius:8, padding:'0 10px', fontSize:13, fontFamily:"'Inter',sans-serif", background:'#fff', color:E.deep, outline:'none' };
var errSelectStyle = Object.assign({}, errInputStyle, { paddingRight:28, appearance:'none', backgroundImage:"url(\"data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236B8F7A' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E\")", backgroundRepeat:'no-repeat', backgroundPosition:'right 10px center', cursor:'pointer' });
var errMonoStyle = { fontFamily:"'Courier New',monospace", fontSize:11 };

// ── Time-range filter (live: 24h / 7d / 30d / all, default 7d) ──
// Live filters relative to Date.now(); this mock anchors on the newest
// mock entry so the prototype always has rows to show.
var RANGE_MS = { '24h':864e5, '7d':7*864e5, '30d':30*864e5, 'all':Infinity };
var NEWEST_MS = ERRORS.reduce(function(mx, e) { return Math.max(mx, Date.parse(e.time.replace(' ', 'T'))); }, 0);

// ── Source badge ────────────────────────────────────────────────
function SourceBadge({ source }) {
  var isS = source === 'sentry';
  return React.createElement('span', { style: {
    display:'inline-flex', alignItems:'center', gap:4, fontSize:10, fontWeight:600,
    padding:'2px 8px', borderRadius:99, fontFamily:"'Inter',sans-serif", letterSpacing:'0.02em',
    background: isS ? '#F3EEFA' : '#EAEFEC',
    color: isS ? '#6B3FA0' : E.muted,
  }}, isS ? 'Sentry' : 'Activity log');
}

// ── HTTP status pill ────────────────────────────────────────────
function HttpPill({ http }) {
  var is5 = http >= 500;
  return React.createElement('span', { style: Object.assign({}, errMonoStyle, {
    display:'inline-block', padding:'1px 6px', borderRadius:4, fontWeight:600, fontSize:10,
    background: is5 ? E.errLt : '#FFF5F0',
    color: is5 ? E.errDk : E.err,
  })}, http);
}

// ── Expanded detail pane (live shows redacted metadata only) ────
function ExpandedDetail({ entry }) {
  var sectionLabel = { fontFamily:"'Inter',sans-serif", fontSize:10, fontWeight:600, color:E.muted, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 };
  var metaStr = (entry.meta && Object.keys(entry.meta).length) ? JSON.stringify(entry.meta, null, 2) : 'No metadata.';

  return React.createElement('tr', null,
    React.createElement('td', { colSpan:8, style:{ padding:0, background:'#FAFAFA' }},
      React.createElement('div', { style:{ padding:'16px 20px 20px', borderTop:'1px solid #F0F0F0' }},
        React.createElement('div', { style:sectionLabel }, 'Metadata (redacted)'),
        React.createElement('pre', { style:{ background:'#fff', border:'1px solid '+E.border, borderRadius:8, padding:'10px 12px', margin:0, fontFamily:"'Courier New',monospace", fontSize:11, color:E.deep, lineHeight:1.6, overflow:'auto', whiteSpace:'pre-wrap' }},
          metaStr
        )
      )
    )
  );
}

// ── Error row ───────────────────────────────────────────────────
function ErrorRow({ row, expanded, onToggle }) {
  var ts = row.time.slice(11, 19);
  var date = row.time.slice(8, 10) + '/' + row.time.slice(5, 7); // dd/mm, as live
  var is5 = row.http >= 500;

  return React.createElement(React.Fragment, null,
    React.createElement('tr', {
      onClick: function(){ onToggle(row.id); },
      style:{ borderBottom:'1px solid #F0F4F2', cursor:'pointer', transition:'background 100ms ease', background: expanded ? '#FAFAFA' : 'transparent' },
      onMouseEnter: function(ev){ if(!expanded) ev.currentTarget.style.background='#FDFAFA'; },
      onMouseLeave: function(ev){ if(!expanded) ev.currentTarget.style.background='transparent'; },
    },
      // Expand chevron + time
      React.createElement('td', { style:{ padding:'8px 6px 8px 12px', whiteSpace:'nowrap', verticalAlign:'middle' }},
        React.createElement('div', { style:{ display:'flex', alignItems:'center', gap:6 }},
          React.createElement('svg', { width:12, height:12, viewBox:'0 0 12 12', style:{ flexShrink:0, color:E.muted, transform: expanded ? 'rotate(90deg)' : 'none', transition:'transform 140ms ease' }},
            React.createElement('path', { d:'M4 2l4 4-4 4', stroke:'currentColor', strokeWidth:1.5, strokeLinecap:'round', fill:'none' })
          ),
          React.createElement('div', null,
            React.createElement('div', { style: Object.assign({}, errMonoStyle, { color:E.deep, lineHeight:1.2 }), title:row.time }, ts),
            React.createElement('div', { style:{ fontFamily:"'Inter',sans-serif", fontSize:10, color:E.muted }}, date)
          )
        )
      ),
      // Workspace + actor
      React.createElement('td', { style:{ padding:'8px', verticalAlign:'middle' }},
        React.createElement('div', { style:{ fontSize:12, fontWeight:600, color:E.deep, fontFamily:"'Inter',sans-serif", lineHeight:1.2 }}, row.ws),
        React.createElement('div', { style:{ display:'flex', alignItems:'center', gap:4, marginTop:2 }},
          React.createElement('span', { style:{ fontSize:11, color:E.muted, fontFamily:"'Inter',sans-serif" }}, row.email)
        )
      ),
      // Action / route
      React.createElement('td', { style:{ padding:'8px', verticalAlign:'middle' }},
        React.createElement('div', { style:{ fontSize:12, fontWeight:500, color:E.deep, fontFamily:"'Inter',sans-serif" }}, row.action),
        React.createElement('div', { style: Object.assign({}, errMonoStyle, { color:E.muted, marginTop:1 }) }, row.route)
      ),
      // Result code + HTTP
      React.createElement('td', { style:{ padding:'8px', verticalAlign:'middle', whiteSpace:'nowrap' }},
        React.createElement('div', { style: Object.assign({}, errMonoStyle, { color: is5 ? E.errDk : E.err, fontWeight:600, fontSize:10 }) }, row.code),
        React.createElement('div', { style:{ marginTop:3 }}, React.createElement(HttpPill, { http:row.http }))
      ),
      // Summary
      React.createElement('td', { style:{ padding:'8px', fontSize:12, color:'#4A4A4A', fontFamily:"'Inter',sans-serif", maxWidth:280, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', verticalAlign:'middle' }}, row.summary),
      // Source
      React.createElement('td', { style:{ padding:'8px', verticalAlign:'middle' }},
        React.createElement(SourceBadge, { source:row.source })
      ),
      // Sentry link ("↗" text link, as live)
      React.createElement('td', { style:{ padding:'8px 12px 8px 8px', verticalAlign:'middle', textAlign:'center' }},
        row.sentryId ? React.createElement('a', {
          href:'https://sentry.io/issues/' + row.sentryId,
          target:'_blank', rel:'noopener',
          onClick: function(ev){ ev.stopPropagation(); },
          title:'Open in Sentry',
          style:{ display:'inline-flex', alignItems:'center', justifyContent:'center', width:26, height:26, borderRadius:6, background:'#F3EEFA', color:'#6B3FA0', textDecoration:'none', transition:'background 100ms ease' },
          onMouseEnter: function(ev){ ev.currentTarget.style.background='#E8DAFA'; },
          onMouseLeave: function(ev){ ev.currentTarget.style.background='#F3EEFA'; },
        }, '↗') : React.createElement('span', { style:{ color:'#ddd', fontSize:11 }}, '—')
      )
    ),
    expanded && React.createElement(ExpandedDetail, { entry:row })
  );
}

// ── Skeleton loading ────────────────────────────────────────────
function SkeletonRows() {
  var shimmer = { background:'linear-gradient(90deg, '+E.border+' 25%, #F0F4F2 50%, '+E.border+' 75%)', backgroundSize:'200% 100%', animation:'errShimmer 1.5s infinite', borderRadius:4, height:12 };
  var rows = [];
  for (var i = 0; i < 8; i++) {
    rows.push(React.createElement('tr', { key:i, style:{ borderBottom:'1px solid #F0F4F2' }},
      React.createElement('td', { style:{ padding:'12px' }}, React.createElement('div', { style:Object.assign({}, shimmer, { width:70 }) })),
      React.createElement('td', { style:{ padding:'12px' }}, React.createElement('div', { style:Object.assign({}, shimmer, { width:130 }) })),
      React.createElement('td', { style:{ padding:'12px' }}, React.createElement('div', { style:Object.assign({}, shimmer, { width:100 }) })),
      React.createElement('td', { style:{ padding:'12px' }}, React.createElement('div', { style:Object.assign({}, shimmer, { width:80 }) })),
      React.createElement('td', { style:{ padding:'12px' }}, React.createElement('div', { style:Object.assign({}, shimmer, { width:200 }) })),
      React.createElement('td', { style:{ padding:'12px' }}, React.createElement('div', { style:Object.assign({}, shimmer, { width:60 }) })),
      React.createElement('td', { style:{ padding:'12px' }}, React.createElement('div', { style:Object.assign({}, shimmer, { width:26, height:26, borderRadius:6 }) }))
    ));
  }
  return React.createElement(React.Fragment, null, rows);
}

// ── Friendly empty ──────────────────────────────────────────────
function FriendlyEmpty() {
  return React.createElement('div', { style:{ textAlign:'center', padding:'60px 24px' }},
    React.createElement('div', { style:{ width:48, height:48, borderRadius:'50%', background:'#D1F5E3', display:'inline-flex', alignItems:'center', justifyContent:'center', marginBottom:14 }},
      React.createElement(LucideIcon, { name:'check-circle', size:22, color:'#1A7A47' })
    ),
    React.createElement('div', { style:{ fontFamily:"'Nunito',sans-serif", fontWeight:700, fontSize:16, color:E.deep, marginBottom:4 }}, 'No errors found'),
    React.createElement('div', { style:{ fontFamily:"'Inter',sans-serif", fontSize:13, color:E.muted, maxWidth:300, margin:'0 auto' }}, 'All clear for this range. Nothing broke — that\'s the goal.')
  );
}

// ── Inline ErrorBanner (matches DS pattern) ─────────────────────
function InlineErrorBanner({ message, onRetry }) {
  return React.createElement('div', { style:{ display:'flex', alignItems:'flex-start', gap:10, padding:'12px 14px', background:E.errLt, borderRadius:12, borderLeft:'3px solid '+E.err, marginBottom:16 }},
    React.createElement('span', { style:{ width:20, height:20, borderRadius:'50%', background:E.err, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:800, flexShrink:0, marginTop:1 }}, '!'),
    React.createElement('div', { style:{ flex:1 }},
      React.createElement('p', { style:{ fontFamily:"'Inter',sans-serif", fontSize:13, fontWeight:500, color:E.errDk, margin:0, lineHeight:1.45 }}, message),
      onRetry && React.createElement('button', {
        onClick: onRetry,
        style:{ marginTop:6, fontFamily:"'Inter',sans-serif", fontSize:12, fontWeight:600, color:E.err, background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline' },
      }, 'Retry')
    )
  );
}

// ── Main component ──────────────────────────────────────────────
function AdminErrorsContent(props) {
  var viewState = (props && props.viewState) || 'Normal';
  var _ws = React.useState('all'), wsFilter = _ws[0], setWsFilter = _ws[1];
  var _em = React.useState('all'), emailFilter = _em[0], setEmailFilter = _em[1];
  var _rg = React.useState('7d'), rangeFilter = _rg[0], setRangeFilter = _rg[1];
  var _src = React.useState('all'), srcFilter = _src[0], setSrcFilter = _src[1];
  var _exp = React.useState(null), expandedId = _exp[0], setExpandedId = _exp[1];

  var rangeMs = RANGE_MS[rangeFilter] || Infinity;
  var cutoff = NEWEST_MS - rangeMs;

  var filtered = ERRORS.filter(function(e) {
    if (wsFilter !== 'all' && e.ws !== wsFilter) return false;
    if (emailFilter !== 'all' && e.email !== emailFilter) return false;
    if (srcFilter !== 'all' && e.source !== srcFilter) return false;
    if (rangeMs !== Infinity) {
      var t = Date.parse(e.time.replace(' ', 'T'));
      if (isNaN(t) || t < cutoff) return false;
    }
    return true;
  });

  var isLoading = viewState === 'Loading';
  var isEmpty = viewState === 'Empty' || (!isLoading && filtered.length === 0);
  var isError = viewState === 'Error';

  var uniqueWs = [];
  var uniqueEm = [];
  var seen = {};
  ERRORS.forEach(function(e) {
    if (!seen['ws:'+e.ws]) { uniqueWs.push(e.ws); seen['ws:'+e.ws] = true; }
    if (!seen['em:'+e.email]) { uniqueEm.push(e.email); seen['em:'+e.email] = true; }
  });

  var errorCount = isLoading ? '…' : (isEmpty ? 0 : filtered.length);
  var subtitle = errorCount + ' error' + (errorCount === 1 ? '' : 's') + ' · user-reported across workspaces';

  var headers = ['Time', 'Context', 'Action', 'Result', 'Summary', 'Source', ''];

  return React.createElement(AdminLayout, { activePage:'errors', pageTitle:'Errors', pageSubtitle: subtitle, notificationCount:2 },

    // Error banner (failure state)
    isError && React.createElement(InlineErrorBanner, {
      message: 'Couldn\'t load the error log. The errors endpoint returned an error.',
      onRetry: function(){ },
    }),

    // Shimmer keyframe
    React.createElement('style', null, '@keyframes errShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}'),

    // Filter bar (workspace · user · time range · source, as live)
    React.createElement('div', { style:{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'center' }},
      React.createElement('select', { style:errSelectStyle, value:wsFilter, onChange:function(ev){setWsFilter(ev.target.value);} },
        React.createElement('option', { value:'all' }, 'All workspaces'),
        uniqueWs.map(function(w){ return React.createElement('option', { key:w, value:w }, w); })
      ),
      React.createElement('select', { style:errSelectStyle, value:emailFilter, onChange:function(ev){setEmailFilter(ev.target.value);} },
        React.createElement('option', { value:'all' }, 'All users'),
        uniqueEm.map(function(em){ return React.createElement('option', { key:em, value:em }, em); })
      ),
      React.createElement('select', { style:errSelectStyle, value:rangeFilter, onChange:function(ev){setRangeFilter(ev.target.value);} },
        React.createElement('option', { value:'24h' }, 'Last 24 hours'),
        React.createElement('option', { value:'7d' }, 'Last 7 days'),
        React.createElement('option', { value:'30d' }, 'Last 30 days'),
        React.createElement('option', { value:'all' }, 'All time')
      ),
      React.createElement('select', { style:errSelectStyle, value:srcFilter, onChange:function(ev){setSrcFilter(ev.target.value);} },
        React.createElement('option', { value:'all' }, 'All sources'),
        React.createElement('option', { value:'activity-log' }, 'Activity log'),
        React.createElement('option', { value:'sentry' }, 'Sentry')
      )
    ),

    // Table
    !isError && React.createElement('div', { style:{ background:'#fff', borderRadius:12, boxShadow:'0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)', overflow:'hidden' }},
      React.createElement('table', { style:{ width:'100%', borderCollapse:'collapse' }},
        React.createElement('thead', null,
          React.createElement('tr', { style:{ background:'#FDFAFA', borderBottom:'1px solid '+E.border }},
            headers.map(function(h, i) {
              return React.createElement('th', { key:i, style:{ padding:'9px 10px', fontSize:10, fontWeight:600, color:E.muted, textTransform:'uppercase', letterSpacing:'0.06em', textAlign:'left', fontFamily:"'Inter',sans-serif", whiteSpace:'nowrap' }}, h);
            })
          )
        ),
        React.createElement('tbody', null,
          isLoading ? React.createElement(SkeletonRows) :
          isEmpty ? React.createElement('tr', null, React.createElement('td', { colSpan:8 }, React.createElement(FriendlyEmpty))) :
          filtered.map(function(row) {
            return React.createElement(ErrorRow, { key:row.id, row:row, expanded:expandedId === row.id, onToggle:function(id){ setExpandedId(expandedId === id ? null : id); } });
          })
        )
      )
    ),

    // Footer count (live has no pagination — loaded errors only)
    !isError && !isEmpty && !isLoading && React.createElement('div', { style:{ marginTop:14, padding:'0 4px', fontSize:12, color:E.muted, fontFamily:"'Inter',sans-serif" }},
      'Showing ' + filtered.length + ' of ' + ERRORS.length + ' loaded errors'
    )
  );
}

window.AdminErrorsContent = AdminErrorsContent;
