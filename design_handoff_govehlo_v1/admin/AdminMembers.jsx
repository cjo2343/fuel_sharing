(function() {
var _ds = window.GoVehloDesignSystem_c5fd4e || {};
var Avatar = _ds.Avatar, Badge = _ds.Badge, Button = _ds.Button;

var MEMBERS = [
  { name: 'Christian Jørgensen', email: 'christian@chrjohn.dk', role: 'admin', active: true, joined: 'Jan 2024', phone: '+45 12 34 56 78' },
  { name: 'Lars Nielsen', email: 'lars@example.com', role: 'member', active: true, joined: 'Jan 2024', phone: '+45 23 45 67 89' },
  { name: 'Sara Thomsen', email: 'sara@example.com', role: 'member', active: true, joined: 'Feb 2024', phone: '+45 34 56 78 90' },
  { name: 'Mikkel Andersen', email: 'mikkel@example.com', role: 'member', active: true, joined: 'Mar 2024', phone: '+45 45 67 89 01' },
  { name: 'Emma Sørensen', email: 'emma@example.com', role: 'member', active: true, joined: 'Apr 2024', phone: '' },
];

var cellBase = { padding: '10px 12px', fontFamily: "'Inter',sans-serif", fontSize: 13, color: '#1A2E1F', verticalAlign: 'middle' };
var mutedCell = Object.assign({}, cellBase, { color: '#6B8F7A', fontSize: 12 });

function MemberRow(props) {
  var m = props.member;
  var AvatarC = Avatar || function(p) {
    return React.createElement('div', { style: { width: 28, height: 28, borderRadius: '50%', background: '#2D6A4F', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 9, fontWeight: 700, fontFamily: "'Nunito',sans-serif", flexShrink: 0 } }, p.name.split(' ').map(function(n){return n[0]}).join(''));
  };
  var BadgeC = Badge || function(p) {
    var bg = p.variant === 'forest' ? '#2D6A4F' : p.variant === 'success' ? '#D1F5E3' : '#EAEFEC';
    var fg = p.variant === 'forest' ? '#fff' : p.variant === 'success' ? '#1A7A47' : '#6B8F7A';
    return React.createElement('span', { style: { fontSize: 11, padding: '3px 10px', borderRadius: 99, background: bg, color: fg, fontWeight: 600, fontFamily: "'Inter',sans-serif" } }, p.children);
  };
  var isProtected = m.role === 'admin' && MEMBERS.filter(function(x){return x.role==='admin'}).length === 1;

  return React.createElement('tr', { style: { borderBottom: '1px solid #F0F4F2' } },
    React.createElement('td', { style: Object.assign({}, cellBase, { whiteSpace: 'nowrap' }) },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        React.createElement(AvatarC, { name: m.name, size: 'xs' }),
        React.createElement('div', null,
          React.createElement('div', { style: { fontWeight: 600, fontSize: 13, color: '#1A2E1F' } }, m.name),
          React.createElement('div', { style: { fontSize: 11, color: '#6B8F7A', marginTop: 1 } }, m.email)
        )
      )
    ),
    React.createElement('td', { style: cellBase },
      React.createElement(BadgeC, { variant: m.role === 'admin' ? 'forest' : 'default' }, m.role === 'admin' ? 'Admin' : 'Member')
    ),
    React.createElement('td', { style: cellBase },
      React.createElement(BadgeC, { variant: 'success', dot: true }, 'Active')
    ),
    React.createElement('td', { style: mutedCell }, m.phone || '\u2014'),
    React.createElement('td', { style: mutedCell }, m.joined),
    React.createElement('td', { style: Object.assign({}, cellBase, { textAlign: 'right' }) },
      !isProtected && React.createElement('button', {
        style: { fontSize: 12, padding: '5px 12px', borderRadius: 8, border: '1px solid #E2EDE8', background: '#fff', cursor: 'pointer', fontFamily: "'Inter',sans-serif", fontWeight: 500, color: '#1A2E1F', marginRight: 6 },
        onClick: props.onToggle,
      }, m.role === 'admin' ? 'Demote' : 'Promote'),
      isProtected && React.createElement('span', { style: { fontSize: 11, color: '#6B8F7A', fontStyle: 'italic' } }, 'Protected')
    )
  );
}

function AdminMembersContent() {
  var ref = React.useState(MEMBERS);
  var members = ref[0], setMembers = ref[1];
  var showRef = React.useState(false);
  var showInvite = showRef[0], setShowInvite = showRef[1];
  var admins = members.filter(function(m){return m.role==='admin'}).length;

  function toggleRole(i) {
    setMembers(function(prev) {
      var next = prev.map(function(m,j) {
        if (j !== i) return m;
        return Object.assign({}, m, { role: m.role === 'admin' ? 'member' : 'admin' });
      });
      return next;
    });
  }

  return React.createElement(AdminLayout, { activePage: 'members', pageTitle: 'Members', pageSubtitle: members.length + ' active members \u00b7 ' + admins + ' admin', notificationCount: 2 },
    // Summary strip
    React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 20 } },
      [
        { label: 'Total members', count: String(members.length), color: '#52B788' },
        { label: 'Admins', count: String(admins), color: '#2D6A4F' },
        { label: 'Missing email', count: '0', color: '#52B788' },
        { label: 'Missing MobilePay', count: '1', color: '#F4A261' },
      ].map(function(s, i) {
        return React.createElement('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(26,46,31,.06)', flex: '1 1 160px', minWidth: 140 } },
          React.createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 } }),
          React.createElement('div', null,
            React.createElement('div', { style: { fontFamily: "'Nunito',sans-serif", fontWeight: 800, fontSize: 18, color: '#1A2E1F', lineHeight: 1.1 } }, s.count),
            React.createElement('div', { style: { fontFamily: "'Inter',sans-serif", fontSize: 11, color: '#6B8F7A' } }, s.label)
          )
        );
      })
    ),
    // Invite button
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 } },
      React.createElement('h2', { style: { fontFamily: "'Nunito',sans-serif", fontWeight: 700, fontSize: 17, color: '#1A2E1F', margin: 0 } }, 'All members'),
      React.createElement('button', {
        style: { padding: '8px 16px', borderRadius: 10, border: 'none', background: '#2D6A4F', color: '#fff', fontFamily: "'Nunito',sans-serif", fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 },
        onClick: function() { setShowInvite(!showInvite); },
      },
        React.createElement(LucideIcon, { name: 'user-plus', size: 14, color: '#fff' }),
        'Invite member'
      )
    ),
    // Invite panel
    showInvite && React.createElement('div', { style: { background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, boxShadow: '0 1px 3px rgba(26,46,31,.08)', border: '1px solid #E2EDE8', display: 'flex', gap: 10, alignItems: 'flex-end' } },
      React.createElement('div', { style: { flex: 1 } },
        React.createElement('label', { style: { fontSize: 11, fontWeight: 600, color: '#6B8F7A', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 4, fontFamily: "'Inter',sans-serif" } }, 'Email address'),
        React.createElement('input', { style: { width: '100%', height: 36, border: '1px solid #E2EDE8', borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: "'Inter',sans-serif", background: '#F7F9F8', outline: 'none', color: '#1A2E1F', boxSizing: 'border-box' }, placeholder: 'name@example.com' })
      ),
      React.createElement('button', { style: { height: 36, padding: '0 16px', borderRadius: 8, border: 'none', background: '#2D6A4F', color: '#fff', fontFamily: "'Inter',sans-serif", fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' } }, 'Send invite')
    ),
    // Table
    React.createElement('div', { style: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)', overflow: 'hidden' } },
      React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
        React.createElement('thead', null,
          React.createElement('tr', { style: { background: '#FAFCFB', borderBottom: '1px solid #E2EDE8' } },
            ['Member', 'Role', 'Status', 'MobilePay', 'Joined', ''].map(function(h) {
              return React.createElement('th', { key: h, style: { padding: '9px 12px', fontSize: 10, fontWeight: 600, color: '#6B8F7A', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: h === '' ? 'right' : 'left', fontFamily: "'Inter',sans-serif" } }, h);
            })
          )
        ),
        React.createElement('tbody', null,
          members.map(function(m, i) {
            return React.createElement(MemberRow, { key: i, member: m, onToggle: function() { toggleRole(i); } });
          })
        )
      )
    )
  );
}

window.AdminMembersContent = AdminMembersContent;
})();
