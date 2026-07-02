(function() {
var _ds = window.GoVehloDesignSystem_c5fd4e || {};
var Button = _ds.Button;

var inputStyle = { width: '100%', height: 40, border: '1px solid #E2EDE8', borderRadius: 10, padding: '0 14px', fontSize: 14, fontFamily: "'Inter',sans-serif", background: '#fff', outline: 'none', color: '#1A2E1F', boxSizing: 'border-box' };
var selectStyle = Object.assign({}, inputStyle, { paddingRight: 32, appearance: 'none', cursor: 'pointer', backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236B8F7A' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E\")", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' });
var labelStyle = { fontSize: 11, fontWeight: 600, color: '#6B8F7A', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 6, fontFamily: "'Inter',sans-serif" };
var hintStyle = { fontSize: 12, color: '#6B8F7A', fontFamily: "'Inter',sans-serif", marginTop: 4, lineHeight: 1.4 };

function SettingsCard(props) {
  return React.createElement('div', { style: { background: '#fff', borderRadius: 12, padding: '20px 24px', boxShadow: '0 1px 3px rgba(26,46,31,.08), 0 4px 12px rgba(26,46,31,.04)', marginBottom: 16 } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 } },
      React.createElement('div', { style: { width: 32, height: 32, borderRadius: 8, background: props.iconBg || '#D8F3DC', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
        React.createElement(LucideIcon, { name: props.icon, size: 16, color: props.iconColor || '#2D6A4F' })
      ),
      React.createElement('div', null,
        React.createElement('div', { style: { fontFamily: "'Nunito',sans-serif", fontWeight: 700, fontSize: 16, color: '#1A2E1F' } }, props.title),
        props.subtitle && React.createElement('div', { style: { fontFamily: "'Inter',sans-serif", fontSize: 12, color: '#6B8F7A', marginTop: 1 } }, props.subtitle)
      )
    ),
    props.children
  );
}

function FieldRow(props) {
  return React.createElement('div', { style: { marginBottom: props.last ? 0 : 16 } },
    React.createElement('label', { style: labelStyle }, props.label),
    props.children,
    props.hint && React.createElement('div', { style: hintStyle }, props.hint)
  );
}

function ToggleRow(props) {
  var on = props.value;
  return React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: props.last ? 'none' : '1px solid #F0F4F2' } },
    React.createElement('div', null,
      React.createElement('div', { style: { fontFamily: "'Inter',sans-serif", fontSize: 14, fontWeight: 500, color: '#1A2E1F' } }, props.label),
      props.hint && React.createElement('div', { style: { fontSize: 12, color: '#6B8F7A', marginTop: 2, fontFamily: "'Inter',sans-serif" } }, props.hint)
    ),
    React.createElement('div', {
      style: { width: 44, height: 24, borderRadius: 12, background: on ? '#2D6A4F' : '#D8F3DC', position: 'relative', cursor: 'pointer', flexShrink: 0, transition: 'background 140ms ease', border: '1.5px solid ' + (on ? '#2D6A4F' : '#C4D9CD') },
      onClick: props.onToggle,
    },
      React.createElement('div', { style: { position: 'absolute', top: 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.2)', transition: 'left 140ms ease', left: on ? 22 : 2 } })
    )
  );
}

function AdminSettingsContent() {
  var remRef = React.useState(true);
  var reminders = remRef[0], setReminders = remRef[1];
  var lockRef = React.useState(true);
  var lockPeriod = lockRef[0], setLockPeriod = lockRef[1];

  return React.createElement(AdminLayout, { activePage: 'settings', pageTitle: 'Settings', pageSubtitle: 'Familien J\u00f8rgensen \u00b7 Workspace configuration', notificationCount: 2 },
    // Vehicle
    React.createElement(SettingsCard, { icon: 'car', title: 'Vehicle', subtitle: 'VW Golf \u00b7 AB 12 345' },
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 } },
        React.createElement(FieldRow, { label: 'Fuel type' },
          React.createElement('select', { style: selectStyle, defaultValue: 'diesel' },
            React.createElement('option', { value: 'diesel' }, 'Diesel'),
            React.createElement('option', { value: 'petrol' }, 'Petrol 95'),
            React.createElement('option', { value: 'petrol98' }, 'Petrol 98'),
            React.createElement('option', { value: 'ev' }, 'Electric')
          )
        ),
        React.createElement(FieldRow, { label: 'Consumption (L/100 km)' },
          React.createElement('input', { style: inputStyle, type: 'number', defaultValue: '5.3', step: '0.1' })
        ),
        React.createElement(FieldRow, { label: 'Tank capacity (L)' },
          React.createElement('input', { style: inputStyle, type: 'number', defaultValue: '50' })
        ),
        React.createElement(FieldRow, { label: 'Fallback fuel price (kr/L)', hint: 'Used when Circle K API is unavailable' },
          React.createElement('input', { style: inputStyle, type: 'number', defaultValue: '14.50', step: '0.10' })
        )
      )
    ),
    // Fuel price warnings
    React.createElement(SettingsCard, { icon: 'alert-triangle', iconBg: '#FDE8D8', iconColor: '#F4A261', title: 'Fuel price warnings', subtitle: 'Block saves with unrealistic DKK/L' },
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 } },
        React.createElement(FieldRow, { label: 'Low DKK/L warning', hint: 'Receipts below this are flagged' },
          React.createElement('input', { style: inputStyle, type: 'number', defaultValue: '8.00', step: '0.50' })
        ),
        React.createElement(FieldRow, { label: 'High DKK/L warning', hint: 'Receipts above this are flagged' },
          React.createElement('input', { style: inputStyle, type: 'number', defaultValue: '25.00', step: '0.50' })
        )
      ),
      React.createElement('div', { style: { marginTop: 14 } },
        React.createElement(FieldRow, { label: 'Fuel sanity threshold', last: true, hint: 'Warn if logged fuel is below this % of expected' },
          React.createElement('input', { style: Object.assign({}, inputStyle, { width: 120 }), type: 'number', defaultValue: '70', suffix: '%' })
        )
      )
    ),
    // Settlement rules
    React.createElement(SettingsCard, { icon: 'shield', title: 'Settlement rules' },
      React.createElement(ToggleRow, { label: 'Lock period after payment', hint: 'Prevent trip/fuel edits once a payment is requested or paid', value: lockPeriod, onToggle: function() { setLockPeriod(!lockPeriod); } }),
      React.createElement(ToggleRow, { label: 'Require all requests before close', hint: 'Every calculated payment must be requested before closing a period', value: true, last: true })
    ),
    // Reminders
    React.createElement(SettingsCard, { icon: 'bell', title: 'Payment reminders', subtitle: reminders ? 'Automatic reminders enabled' : 'Reminders disabled' },
      React.createElement(ToggleRow, { label: 'Enable automatic reminders', hint: 'Send push notifications for unpaid requested payments', value: reminders, onToggle: function() { setReminders(!reminders); } }),
      reminders && React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginTop: 14 } },
        React.createElement(FieldRow, { label: 'First reminder after' },
          React.createElement('select', { style: selectStyle, defaultValue: '3' },
            React.createElement('option', { value: '1' }, '1 day'),
            React.createElement('option', { value: '2' }, '2 days'),
            React.createElement('option', { value: '3' }, '3 days'),
            React.createElement('option', { value: '7' }, '7 days')
          )
        ),
        React.createElement(FieldRow, { label: 'Repeat every' },
          React.createElement('select', { style: selectStyle, defaultValue: '7' },
            React.createElement('option', { value: '3' }, '3 days'),
            React.createElement('option', { value: '7' }, '7 days'),
            React.createElement('option', { value: '14' }, '14 days')
          )
        ),
        React.createElement(FieldRow, { label: 'Max reminders' },
          React.createElement('select', { style: selectStyle, defaultValue: '3' },
            React.createElement('option', { value: '1' }, '1'),
            React.createElement('option', { value: '2' }, '2'),
            React.createElement('option', { value: '3' }, '3'),
            React.createElement('option', { value: '5' }, '5')
          )
        )
      )
    ),
    // Save button
    React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 } },
      React.createElement('button', { style: { height: 40, padding: '0 20px', borderRadius: 10, border: '1px solid #E2EDE8', background: '#fff', fontFamily: "'Inter',sans-serif", fontWeight: 500, fontSize: 14, color: '#6B8F7A', cursor: 'pointer' } }, 'Reset'),
      React.createElement('button', { style: { height: 40, padding: '0 24px', borderRadius: 10, border: 'none', background: '#2D6A4F', fontFamily: "'Nunito',sans-serif", fontWeight: 700, fontSize: 14, color: '#fff', cursor: 'pointer', boxShadow: '0 2px 8px rgba(45,106,79,.25)' } }, 'Save changes')
    )
  );
}

window.AdminSettingsContent = AdminSettingsContent;
})();
