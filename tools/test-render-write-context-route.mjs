import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");

assert.ok(app.includes('const renderWriteContextUrl = "/api/context/write";'), "app must declare the Render write-context route");
assert.ok(app.includes("const writeContextActionTimeoutMs = 6000;"), "Render write context must time out before the outer normalized context guard");
assert.ok(app.includes("async function getRenderWriteContext"), "app must prefer a Render write-context helper");
assert.ok(app.includes('recordSupabaseLoadEvent("render-write-context"'), "Render write context success must be visible in load diagnostics");
assert.ok(app.includes("const renderContext = await getRenderWriteContext({ ledgerId, source });\n  if (renderContext) return renderContext;"), "normalized write context must try Render first and keep fallback");
assert.ok(app.includes('route: "direct-table", table: "ledger_members"'), "browser direct ledger_members fallback must remain during rollout");

assert.ok(server.includes('if self.path == "/api/context/write":'), "server must route /api/context/write");
assert.ok(server.includes("def get_write_context_backend(self):"), "server must implement the write-context endpoint");
assert.ok(server.includes("def get_write_context_as_user"), "server must fetch write context as the signed-in user");
assert.ok(server.includes("ensure_open_settlement_period_as_user"), "server write context must include an open settlement period id");
assert.ok(server.includes('"memberIdsByName"'), "write-context response must include memberIdsByName for client payload mapping");
assert.ok(server.includes('"currentMemberId"'), "write-context response must include currentMemberId for audit/created_by fields");

console.log("Render write context route guard check passed.");
