import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const adminToolsSource = readFileSync(new URL("../admin-tools.js", import.meta.url), "utf8");

assert.match(
  adminToolsSource,
  /const databaseDiagnosticsTimeoutMs = 12000;/,
  "database diagnostics should have a visible timeout instead of spinning forever"
);

assert.match(
  adminToolsSource,
  /window\.setTimeout\([\s\S]*Database diagnostics timed out after[\s\S]*loading: false[\s\S]*render\(\)/,
  "database diagnostics timeout should render a clear failed state"
);

assert.match(
  adminToolsSource,
  /finally \{[\s\S]*window\.clearTimeout\(diagnosticsTimeoutId\)/,
  "database diagnostics should clear its timeout after completion"
);


const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

assert.match(
  indexSource,
  /data-tool-card supabase-load-monitor-card/,
  "supabase load monitor should span the full admin tools grid instead of being squeezed into one narrow card"
);

assert.match(
  stylesSource,
  /\.supabase-load-monitor-card \{[\s\S]*grid-column: 1 \/ -1;/,
  "supabase load monitor card should have full-width layout space"
);

assert.match(
  stylesSource,
  /\.admin-operation-row \{[\s\S]*grid-template-columns: minmax\(18rem, 1fr\)/,
  "data I/O operation rows should reserve readable space for source and endpoint text"
);

assert.match(
  stylesSource,
  /@media \(max-width: 860px\) \{[\s\S]*\.admin-operation-row \{[\s\S]*grid-template-columns: 1fr;/,
  "data I/O operation rows should stack before narrow columns cause vertical letter wrapping"
);

assert.match(
  appSource,
  /Latest data I\/O operations/,
  "admin diagnostics should keep the latest data I/O operation section visible"
);
