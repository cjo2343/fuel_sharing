import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "../load-rehearsal/lib/common.mjs";
import { loadStagingConfig } from "./local-config.mjs";
import {
  buildStagingInstall, STAGING_INSTALLED_SQL, STAGING_POOLER_HOST,
  STAGING_PROJECT_REF, STAGING_STATUS_SQL, STAGING_URL,
} from "./staging-target.mjs";

function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["apply"] });
  if (args._.length || Object.keys(args).some((key) => !["_", "env", "apply"].includes(key)) ||
      (args.apply !== undefined && args.apply !== true)) {
    throw new Error("Usage: node tools/native-e2e/install-schema.mjs --env <private file> [--apply]");
  }
  const config = loadStagingConfig(args.env, ["STAGING_DB_PASSWORD"]);
  const schema = readFileSync(new URL("../../supabase-schema.sql", import.meta.url), "utf8");
  console.log(JSON.stringify({
    target: STAGING_URL, mode: args.apply ? "install-empty-project" : "read-only",
    schemaSha256: createHash("sha256").update(schema).digest("hex"),
  }));

  function query(sql) {
    // Fixed host/user/database: no DBURL or libpq option from the credentials file
    // can redirect this installer. Password is not a command-line argument.
    const result = spawnSync("docker", [
      "run", "--rm", "-i", "--env", "PGPASSWORD", "postgres:17-alpine",
      "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate",
      `host=${STAGING_POOLER_HOST} port=5432 dbname=postgres user=postgres.${STAGING_PROJECT_REF} sslmode=verify-full sslrootcert=system connect_timeout=15`,
      "-f", "-",
    ], {
      input: sql, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 600_000,
      env: { ...process.env, PGPASSWORD: config.STAGING_DB_PASSWORD },
    });
    if (result.error || result.status !== 0) {
      // Do not emit raw subprocess errors, which may contain credentials.
      const sqlstate = result.stderr?.match(/ERROR:\s+([0-9A-Z]{5})\b/)?.[1];
      throw new Error(`Staging query did not finish successfully${sqlstate ? ` (SQLSTATE ${sqlstate})` : ""}. Check Docker, the staging database password and TLS connectivity. No automatic retry was attempted. Run without --apply to verify state before retrying an installation.`);
    }
    const lines = result.stdout.trim().split("\n");
    try { return JSON.parse(lines.at(-1)); } catch {
      throw new Error("Staging query returned an unexpected result. Verify state without --apply before continuing.");
    }
  }

  const before = query(STAGING_STATUS_SQL);
  console.log(JSON.stringify({ before }));
  if (!args.apply) {
    if (before.migration_tracker) console.log(JSON.stringify({ installed: query(STAGING_INSTALLED_SQL) }));
    return;
  }
  if (before.public_tables !== 0 || before.auth_users !== 0 || before.migration_tracker) {
    throw new Error("Refusing installation: the staging database is not empty. This tool never resets or upgrades a populated project.");
  }
  const after = query(buildStagingInstall(schema, STAGING_URL));
  console.log(JSON.stringify({ after }));
}

try { main(); } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
