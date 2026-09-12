import assert from "node:assert/strict";
import { createStagingApi } from "./native-e2e/staging-api.mjs";
import { IDENTITIES, seedFixture, validateFixtureState, WORKSPACES } from "./native-e2e/seed-fixture.mjs";
import { STAGING_URL } from "./native-e2e/staging-target.mjs";

const config = { SUPABASE_URL: STAGING_URL, STAGING_SECRET_KEY: "sb_secret_fake-test-only", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fake-test-only" };
const state = { version: 1, projectUrl: STAGING_URL, createdAt: "2026-09-12T10:00:00.000Z",
  users: IDENTITIES.map((u) => ({ ...u, password: "synthetic-long-test-password-only" })) };
assert.equal(validateFixtureState(state), state);
assert.throws(() => validateFixtureState({ ...state, projectUrl: "https://kdudfqzglhydmzntqosb.supabase.co" }), /Invalid private fixture/);
assert.throws(() => validateFixtureState({ ...state, users: [] }), /Invalid private fixture/);

const calls = [];
const api = createStagingApi(config, async (url, options) => {
  calls.push({ url, ...options });
  return new Response("{}", { status: 200 });
});
await api.createUser(state.users[0]);
await api.signIn(state.users[0]);
await api.rpc("fake-user-jwt", "list_my_ledgers");
await api.rows("fake-user-jwt", "ledgers", { select: "id" });
assert.equal(calls[0].headers.apikey, config.STAGING_SECRET_KEY);
assert.equal(calls[0].headers.Authorization, undefined, "Secret API keys are not bearer JWTs");
assert.equal(JSON.parse(calls[0].body).email_confirm, true, "Synthetic users must not receive confirmation emails");
assert.equal(JSON.parse(calls[0].body).app_metadata.fixture, "vehlo-native-qa-v1");
for (const call of calls) {
  assert.ok(call.url.startsWith(`${STAGING_URL}/`));
  assert.equal(call.redirect, "error", "Never forward credentials through a redirect");
}
for (const call of calls.slice(1)) assert.equal(call.headers.apikey, config.SUPABASE_PUBLISHABLE_KEY);
assert.equal(calls[2].headers.Authorization, "Bearer fake-user-jwt");
assert.throws(() => api.rpc("token", "../../elsewhere"), /Invalid staging RPC/);
assert.throws(() => api.rows("token", "auth.users", {}), /Unsupported/);
assert.throws(() => createStagingApi({ ...config, SUPABASE_URL: "https://example.com" }), /Refusing/);
const failing = createStagingApi(config, async () => new Response(JSON.stringify({ message: config.STAGING_SECRET_KEY, code: "42501" }), { status: 403 }));
await assert.rejects(failing.rpc("private-token", "list_my_ledgers"), (error) =>
  error.status === 403 && error.code === "42501" && !error.message.includes(config.STAGING_SECRET_KEY));
const networkFailing = createStagingApi(config, async () => { throw new Error(config.STAGING_SECRET_KEY); });
await assert.rejects(networkFailing.listUsers(), (error) => !error.message.includes(config.STAGING_SECRET_KEY));

function fixtureApi() {
  const users = [];
  const workspaces = [];
  const writes = [];
  const owner = state.users[0].email;
  const member = state.users[1].email;
  const fake = {
    users, writes, workspaces,
    listUsers: async () => ({ users }),
    createUser: async (user) => { users.push({ email: user.email, app_metadata: { fixture: "vehlo-native-qa-v1" } }); writes.push("user"); },
    signIn: async (user) => ({ access_token: user.email, user: { email: user.email } }),
    rpc: async (token, name, args = {}) => {
      if (name === "list_my_ledgers") return workspaces.filter((w) => token === owner || w.joined).map((w) => ({ ledger_id: w.slug, member_id: token === owner ? w.ownerId : "member-id", role: token === owner ? "admin" : "member" }));
      writes.push(name);
      if (name === "create_private_ledger_workspace") { workspaces.push({ slug: args.workspace_slug, ownerId: `${args.workspace_slug}-owner`, ownerName: "unrenamed", baseline: null, bookings: [] }); return []; }
      if (name === "redeem_ledger_invite") { workspaces[0].joined = true; return []; }
      const ws = workspaces.find((w) => w.slug === args.target_ledger_id);
      if (name === "set_member_name") { ws.ownerName = args.new_name; return []; }
      if (name === "get_workspace_join_code") { writes.pop(); return "synthetic-code"; }
      if (name === "update_ledger_vehicle") return null;
      if (name === "set_tank_baseline") { ws.baseline = args.odometer_value; return {}; }
      if (name === "upsert_car_booking") { ws.bookings.push({ id: "booking-id", deleted_at: null }); return {}; }
      throw new Error(`Unexpected fake RPC: ${name}`);
    },
    rows: async (token, table, params) => {
      const slug = (params.ledger_id ?? params.id).replace(/^eq\./, "");
      const ws = workspaces.find((w) => w.slug === slug);
      if (token === member && !ws.joined) return [];
      if (table === "ledger_members") return [{ id: ws.ownerId, name: ws.ownerName }];
      if (table === "ledgers") return [{ id: ws.slug, tank_baseline_odometer: ws.baseline }];
      if (table === "settlement_periods") return [{ id: `${ws.slug}-period` }];
      if (table === "car_bookings") return ws.bookings;
      if (["trips", "fuel_payments"].includes(table)) return [];
      throw new Error(`Unexpected fake table: ${table}`);
    },
  };
  return fake;
}

const fake = fixtureApi();
const first = await seedFixture(fake, state);
assert.equal(fake.users.length, 2);
assert.equal(fake.workspaces.length, 2);
assert.equal(first.bookingId, "booking-id");
assert.equal(first.isolationReadPassed, true);
assert.equal(first.sharedReadPassed, true);
const writesBefore = fake.writes.length;
assert.deepEqual(await seedFixture(fake, state), first);
assert.equal(fake.writes.length, writesBefore, "Resume must not rewrite vehicle data, users, memberships or bookings");

const collision = fixtureApi();
collision.users.push({ email: state.users[0].email, app_metadata: {} });
await assert.rejects(seedFixture(collision, state), /collides/);
assert.deepEqual(collision.writes, [], "Detect unowned account collision before any writes");

const interrupted = fixtureApi();
const actualRpc = interrupted.rpc;
let failAfterWrite = true;
interrupted.rpc = async (...args) => {
  const answer = await actualRpc(...args);
  if (args[1] === "upsert_car_booking" && failAfterWrite) { failAfterWrite = false; throw new Error("Simulated lost response"); }
  return answer;
};
await assert.rejects(seedFixture(interrupted, state), /lost response/);
await seedFixture(interrupted, state);
assert.equal(interrupted.writes.filter((name) => name === "upsert_car_booking").length, 1, "Reconcile an uncertain booking save instead of duplicating it");

const leaky = fixtureApi();
const actualRows = leaky.rows;
leaky.rows = async (...args) => args[0] === state.users[1].email && args[1] === "ledgers" && args[2].id === `eq.${WORKSPACES[1].slug}`
  ? [{ id: WORKSPACES[1].slug }] : actualRows(...args);
await assert.rejects(seedFixture(leaky, state), /isolation failed/);
console.log("Staging API credential boundaries, fixture resume, collision and isolation tests passed.");
