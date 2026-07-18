// End-to-end smoke for the hardened restore drill (GV-325).
//
//   node tools/test-restore-drill-smoke.mjs
//
// Needs Docker (it drives the real tools/restore-drill.mjs against a disposable
// Postgres). It is NOT part of `npm run validate`; it runs as its own
// Docker-backed CI job (GV-329).
//
// Docker-unavailable behaviour (GV-329): locally it skips cleanly with exit 0
// (the pure paths are still covered by the drill logic + load-rehearsal unit
// suites). In CI (process.env.CI / GITHUB_ACTIONS), where Docker is guaranteed,
// a missing Docker is a real problem — the smoke must FAIL (exit 1) rather than
// silently skip, so a broken runner can't let this surface regress green.
//
// Two synthetic plain-SQL dumps, both derived from the repo's own
// supabase-schema.sql (a complete, valid database — so the drill's core-table /
// RPC / tracker assertions genuinely hold and PASS means what it says):
//   PASS  — schema + a fake public table with a well-formed COPY block; the
//           drill must exit 0 with "RESTORE DRILL PASSED" and verify the row
//           count exactly.
//   FAIL  — the same, but the COPY block has a non-integer in an integer column;
//           the drill must classify a fatal copy-data error (and a row-count
//           mismatch) and exit 1 with "RESTORE DRILL FAILED".
//
// This proves the hardening does not regress the happy path and that a corrupt
// public COPY — the exact gap GV-325 closes — is now caught instead of tolerated.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Docker gate. In CI (where Docker is guaranteed) a missing Docker is a real
// failure — exit 1 so the surface can't silently regress green. Locally it stays
// a graceful skip; the pure paths are covered by the logic + load-rehearsal
// unit suites.
if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
  const inCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
  if (inCI) {
    console.error("❌ Docker not available in CI — the restore-drill smoke cannot run and must not be skipped. Failing.");
    process.exit(1);
  }
  console.log("⏭  Docker not available — skipping restore-drill smoke (logic tests still cover the pure paths).");
  process.exit(0);
}

const schema = readFileSync(path.join(REPO, "supabase-schema.sql"), "utf8");

const SMOKE_TABLE = `
-- GV-325 smoke: a fake public table + COPY block so row-count verification has
-- something to check against the restored database.
create table if not exists public.drill_smoke_rows (id integer primary key, label text);
`;

function copyBlock(rows) {
  return ["COPY public.drill_smoke_rows (id, label) FROM stdin;", ...rows, "\\."].join("\n") + "\n";
}

const passDump = schema + SMOKE_TABLE + copyBlock(["1\talpha", "2\tbeta", "3\tgamma"]);
// A non-integer id corrupts the COPY: the whole block aborts (0 rows) and psql
// emits "invalid input syntax for type integer" — a fatal copy-data error.
const failDump = schema + SMOKE_TABLE + copyBlock(["1\talpha", "notanumber\tbeta", "3\tgamma"]);

const dir = mkdtempSync(path.join(tmpdir(), "drill-smoke-"));
let ok = true;

function runDrill(label, dumpContent, { expectPass }) {
  const dumpPath = path.join(dir, `${label}.sql`);
  writeFileSync(dumpPath, dumpContent);
  console.log(`\n▶️  Smoke: ${label} dump (expect ${expectPass ? "PASS" : "FAIL"})…`);
  const res = spawnSync("node", [path.join(REPO, "tools", "restore-drill.mjs"), dumpPath], {
    encoding: "utf8",
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const passedMarker = /RESTORE DRILL PASSED/.test(out);
  const failedMarker = /RESTORE DRILL FAILED/.test(out);

  if (expectPass) {
    if (res.status === 0 && passedMarker) {
      console.log(`   ✅ ${label}: exited 0 and reported PASSED as expected.`);
    } else {
      ok = false;
      console.error(`   ❌ ${label}: expected PASS but exit=${res.status}, passedMarker=${passedMarker}.`);
      console.error(indent(out));
    }
  } else {
    // Must fail specifically on the corrupt COPY, not something incidental.
    const caughtCopy = /fatal restore error|row-count mismatch|copy-data|invalid input syntax/i.test(out);
    if (res.status === 1 && failedMarker && caughtCopy) {
      console.log(`   ✅ ${label}: exited 1 and reported FAILED on the corrupt COPY as expected.`);
    } else {
      ok = false;
      console.error(`   ❌ ${label}: expected FAIL-on-COPY but exit=${res.status}, failedMarker=${failedMarker}, caughtCopy=${caughtCopy}.`);
      console.error(indent(out));
    }
  }
}

function indent(text) {
  return text.split("\n").map((l) => `      | ${l}`).join("\n");
}

try {
  runDrill("pass", passDump, { expectPass: true });
  runDrill("fail", failDump, { expectPass: false });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (ok) {
  console.log("\n✅ restore-drill smoke passed (PASS + FAIL variants)");
} else {
  console.error("\n❌ restore-drill smoke FAILED");
  process.exit(1);
}
