import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const schema = readFileSync("supabase-schema.sql", "utf8");
const migration = readFileSync("supabase/migrations/037_invite_email_preflight.sql", "utf8");
const index = readFileSync("index.html", "utf8");

assert.match(app, /async function verifyLoginInviteEmailBeforeOtp\(/, "login should preflight restricted invite email before OTP");
assert.match(app, /check_ledger_invite_email/, "app should call the invite email preflight RPC");
assert.match(app, /INVITE_EMAIL_PREFLIGHT_STARTED/, "Data I/O should show invite preflight start code");
assert.match(app, /INVITE_EMAIL_MISMATCH|INVITE_EMAIL_BLOCKED/, "Data I/O should expose restricted-invite mismatch codes");
assert.ok(app.indexOf("verifyLoginInviteEmailBeforeOtp(inviteCode, email)") < app.indexOf("signInWithOtp"), "invite email preflight must run before Supabase sends an email login code");
assert.match(index, /Restricted invites check this email before a login code is sent/, "login UI should explain restricted invite email checks");
assert.match(migration, /create or replace function public\.check_ledger_invite_email/, "migration should add preflight RPC");
assert.match(migration, /grant execute on function public\.check_ledger_invite_email\(text, text\) to anon/, "preflight RPC must be callable before sign-in");
assert.match(migration, /INVITE_EMAIL_MISMATCH/, "preflight RPC should return mismatch code");
assert.match(schema, /check_ledger_invite_email/, "consolidated schema should include preflight RPC");
assert.match(schema, /037_invite_email_preflight/, "consolidated schema should expect migration 037");

console.log("ok - invite email preflight blocks restricted invite mismatch before OTP");
