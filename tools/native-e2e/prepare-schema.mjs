import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "../load-rehearsal/lib/common.mjs";
import { buildStagingInstall } from "./staging-target.mjs";

const args = parseArgs(process.argv.slice(2));
if (typeof args.output !== "string" || typeof args["project-url"] !== "string") {
  throw new Error("Usage: node tools/native-e2e/prepare-schema.mjs --project-url <approved staging URL> --output <new SQL file>");
}
const source = readFileSync(new URL("../../supabase-schema.sql", import.meta.url), "utf8");
const sql = buildStagingInstall(source, args["project-url"]);
writeFileSync(args.output, sql, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ file: args.output, schemaSha256: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(sql) }));
