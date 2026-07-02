// GoVehlo Admin — Unified Prototype Wrapper
// Holds navigation state and renders the selected admin page.
// Each page JSX (AdminDashboardContent, AdminAuditContent, AdminHealthContent)
// is loaded via <script> in the DC helmet before this file.

function GoVehloAdmin() {
  var ref = React.useState('dashboard');
  var page = ref[0], setPage = ref[1];

  React.useEffect(function() {
    window.__adminNav = function(id) { setPage(id); };
    return function() { delete window.__adminNav; };
  }, []);

  if (page === 'audit') return React.createElement(window.AdminAuditContent);
  if (page === 'health') return React.createElement(window.AdminHealthContent);
  if (page === 'members') return React.createElement(window.AdminMembersContent);
  if (page === 'settings') return React.createElement(window.AdminSettingsContent);
  return React.createElement(window.AdminDashboardContent);
}

window.GoVehloAdmin = GoVehloAdmin;
