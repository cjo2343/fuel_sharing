import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadStagingConfig } from "./native-e2e/local-config.mjs";
import { assertStagingUrl, buildStagingInstall, STAGING_URL } from "./native-e2e/staging-target.mjs";

assert.equal(assertStagingUrl(STAGING_URL), STAGING_URL);
assert.equal(assertStagingUrl(`${STAGING_URL}/`), STAGING_URL);
for (const value of [
  "https://kdudfqzglhydmzntqosb.supabase.co",
  "https://another-project.supabase.co",
  "http://lbtvjkeyofhbuvgwywdo.supabase.co",
  `${STAGING_URL}.example.com`,
  `${STAGING_URL}/rest/v1`,
  `${STAGING_URL}?target=production`,
  `${STAGING_URL}#test`,
  "https://user:password@lbtvjkeyofhbuvgwywdo.supabase.co",
  "not-a-url",
]) assert.throws(() => assertStagingUrl(value), undefined, value);

const source = "create table public.synthetic_test(id integer);";
const generated = buildStagingInstall(source, STAGING_URL);
assert.ok(generated.indexOf("begin;") < generated.indexOf(source));
assert.ok(generated.indexOf("from auth.users") < generated.indexOf(source));
assert.ok(generated.indexOf("Refusing schema install") < generated.indexOf(source));
assert.ok(generated.indexOf("pg_try_advisory_xact_lock") < generated.indexOf(source));
assert.ok(generated.lastIndexOf("commit;") > generated.indexOf(source));
assert.doesNotMatch(generated, /drop schema|truncate|disable row level security/i);

const tmp = mkdtempSync(path.join(tmpdir(), "vehlo-staging-config-"));
try {
  const filename = path.join(tmp, "staging.env");
  const contents = `SUPABASE_URL=${STAGING_URL}\nSTAGING_DB_PASSWORD=synthetic-test-value\n`;
  writeFileSync(filename, contents, { mode: 0o600 });
  assert.equal(loadStagingConfig(filename, ["STAGING_DB_PASSWORD"]).STAGING_DB_PASSWORD, "synthetic-test-value");
  assert.throws(() => loadStagingConfig(filename, ["STAGING_SECRET_KEY"]), /Missing or invalid STAGING_SECRET_KEY/);
  chmodSync(filename, 0o644);
  assert.throws(() => loadStagingConfig(filename), /owner-only/);
  chmodSync(filename, 0o600);
  const link = path.join(tmp, "link.env");
  symlinkSync(filename, link);
  assert.throws(() => loadStagingConfig(link), /not a symlink/);
  mkdirSync(path.join(tmp, ".git"));
  assert.throws(() => loadStagingConfig(filename), /outside Git/);
  rmSync(path.join(tmp, ".git"), { recursive: true });
  // Worktrees have a .git file rather than a directory.
  writeFileSync(path.join(tmp, ".git"), "gitdir: /synthetic/worktree");
  assert.throws(() => loadStagingConfig(filename), /outside Git/);
  rmSync(path.join(tmp, ".git"));
  writeFileSync(filename, contents.replace(STAGING_URL, "https://kdudfqzglhydmzntqosb.supabase.co"));
  assert.throws(() => loadStagingConfig(filename), /Refusing/);
  assert.throws(() => loadStagingConfig(path.join(tmp, "missing")), /Cannot read/);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("Staging target, private credentials and transactional install guards passed.");
