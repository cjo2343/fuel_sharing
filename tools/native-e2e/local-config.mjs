import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseEnvFile } from "../load-rehearsal/lib/common.mjs";
import { assertStagingUrl } from "./staging-target.mjs";

export function assertOutsideGit(filename) {
  for (let dir = path.dirname(filename); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) throw new Error("Keep staging credentials outside Git checkouts, including ignored files.");
    if (dir === path.dirname(dir)) break;
  }
}

export function readPrivateFile(filename) {
  if (typeof filename !== "string") throw new Error("Supply --env with an owner-only file outside every Git checkout.");
  let info;
  let resolved;
  try {
    info = lstatSync(filename);
    resolved = realpathSync(filename);
  } catch {
    throw new Error("Cannot read staging credentials file.");
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new Error("Staging credentials must be a regular owner-only file (chmod 600), not a symlink.");
  }
  assertOutsideGit(resolved);
  return readFileSync(resolved, "utf8");
}

export function loadStagingConfig(filename, required = []) {
  const config = parseEnvFile(readPrivateFile(filename));
  assertStagingUrl(config.SUPABASE_URL);
  for (const key of required) {
    if (!config[key] || /[\r\n\0]/.test(config[key])) throw new Error(`Missing or invalid ${key} in staging credentials file.`);
  }
  return config;
}
