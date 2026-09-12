import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../load-rehearsal/lib/common.mjs";
import { assertOutsideGit, loadStagingConfig, readPrivateFile } from "./local-config.mjs";
import { createStagingApi } from "./staging-api.mjs";
import { STAGING_URL } from "./staging-target.mjs";

export const IDENTITIES = [
  { email: "qa-rikke@native.vehloshare.test", name: "QA Rikke" },
  { email: "qa-andreas@native.vehloshare.test", name: "QA Andreas" },
];
export const WORKSPACES = [
  { slug: "native-qa-main", name: "Native QA - Main" },
  { slug: "native-qa-isolation", name: "Native QA - Isolation" },
];

export function validateFixtureState(state) {
  if (state?.version !== 1 || state.projectUrl !== STAGING_URL ||
      !Number.isFinite(Date.parse(state.createdAt)) || state.users?.length !== 2 ||
      !IDENTITIES.every((user, index) => state.users[index]?.email === user.email &&
        state.users[index]?.name === user.name && typeof state.users[index]?.password === "string" &&
        state.users[index].password.length >= 24)) {
    throw new Error("Invalid private fixture state. Do not overwrite it or rotate passwords to recover a run.");
  }
  return state;
}

export async function seedFixture(api, state, report = () => {}) {
  validateFixtureState(state);
  const listed = await api.listUsers();
  if (!Array.isArray(listed?.users) || listed.users.length >= 100) throw new Error("Unexpected staging user inventory; inspect before seeding.");
  for (const identity of state.users) {
    const existing = listed.users.find((user) => user.email === identity.email);
    if (existing && existing.app_metadata?.fixture !== "vehlo-native-qa-v1") {
      throw new Error("Synthetic email collides with an account not owned by this fixture. No password was changed.");
    }
  }
  for (const identity of state.users) {
    if (!listed.users.some((user) => user.email === identity.email)) await api.createUser(identity);
  }
  report("Synthetic Auth users are ready; signing in through the normal password flow.");
  const sessions = [];
  for (const user of state.users) {
    const session = await api.signIn(user);
    if (!session?.access_token || session.user?.email !== user.email) throw new Error("Test sign-in returned an unexpected identity.");
    sessions.push(session.access_token);
  }

  const ownerToken = sessions[0];
  const memberToken = sessions[1];
  const result = { projectUrl: STAGING_URL, workspaces: [] };
  for (const workspace of WORKSPACES) {
    const mine = await api.rpc(ownerToken, "list_my_ledgers");
    if (!Array.isArray(mine)) throw new Error("Unexpected workspace inventory.");
    const existing = mine.find((row) => row.ledger_id === workspace.slug);
    if (!existing) {
      await api.rpc(ownerToken, "create_private_ledger_workspace", { workspace_name: workspace.name, workspace_slug: workspace.slug });
    }
    const memberships = await api.rpc(ownerToken, "list_my_ledgers");
    const owner = memberships.find((row) => row.ledger_id === workspace.slug);
    if (!owner || owner.role !== "admin") throw new Error("Fixture owner is not the workspace admin.");
    const ledgerId = owner.ledger_id;
    const members = await api.rows(ownerToken, "ledger_members", { select: "id,name,email", ledger_id: `eq.${ledgerId}`, is_active: "eq.true" });
    if (members.find((row) => row.id === owner.member_id)?.name !== state.users[0].name) {
      await api.rpc(ownerToken, "set_member_name", { target_ledger_id: ledgerId, target_member_id: owner.member_id, new_name: state.users[0].name });
    }
    if (workspace.slug === WORKSPACES[0].slug) {
      const joined = await api.rpc(memberToken, "list_my_ledgers");
      if (!joined.some((row) => row.ledger_id === ledgerId)) {
        const code = await api.rpc(ownerToken, "get_workspace_join_code", { target_ledger_id: ledgerId });
        if (typeof code !== "string") throw new Error("Unexpected workspace invitation result.");
        await api.rpc(memberToken, "redeem_ledger_invite", { invite_code: code, display_name: state.users[1].name });
      }
    }
    // A resume must never reset a tank baseline after a tester has used the car.
    const [ledger] = await api.rows(ownerToken, "ledgers", { select: "id,tank_baseline_odometer", id: `eq.${ledgerId}` });
    if (!ledger) throw new Error("Fixture workspace is not readable by its owner.");
    if (ledger.tank_baseline_odometer == null) {
      for (const table of ["trips", "fuel_payments", "car_bookings"]) {
        const rows = await api.rows(ownerToken, table, { select: "id", ledger_id: `eq.${ledgerId}`, limit: "1" });
        if (rows.length) throw new Error("Unconfigured fixture workspace already contains activity; refusing to reset its vehicle.");
      }
      await api.rpc(ownerToken, "update_ledger_vehicle", {
        target_ledger_id: ledgerId, estimated_consumption_value: 5, fuel_tank_capacity_value: 50,
        fuel_type_value: "benzin", event_type_value: "vehicle_updated",
      });
      await api.rpc(ownerToken, "set_tank_baseline", { target_ledger_id: ledgerId, odometer_value: 1000, fraction_value: 0.5 });
    }
    const periods = await api.rows(ownerToken, "settlement_periods", { select: "id", ledger_id: `eq.${ledgerId}`, status: "eq.open" });
    if (periods.length !== 1) throw new Error("Fixture workspace must have exactly one open settlement period.");
    result.workspaces.push({ ledgerId, ownerMemberId: owner.member_id, periodId: periods[0].id });
  }

  const primaryId = WORKSPACES[0].slug;
  const legacyId = "native-qa-initial-ended-booking";
  let bookings = await api.rows(ownerToken, "car_bookings", { select: "id,deleted_at", ledger_id: `eq.${primaryId}`, legacy_id: `eq.${legacyId}` });
  if (!bookings.length) {
    const epoch = Date.parse(state.createdAt);
    await api.rpc(ownerToken, "upsert_car_booking", {
      target_ledger_id: primaryId, legacy_booking_id: legacyId,
      booking_member_id: result.workspaces[0].ownerMemberId,
      start_at_value: new Date(epoch - 2 * 3600_000).toISOString(),
      end_at_value: new Date(epoch - 3600_000).toISOString(),
      purpose_value: "Native QA: complete this trip", event_title: "QA booking created",
    });
    bookings = await api.rows(ownerToken, "car_bookings", { select: "id,deleted_at", ledger_id: `eq.${primaryId}`, legacy_id: `eq.${legacyId}` });
  }
  if (bookings.length !== 1) throw new Error("Fixture booking is missing or duplicated.");
  result.bookingId = bookings[0].id;

  // Real authenticated reads: shared data is visible, the other workspace is not.
  const shared = await api.rows(memberToken, "car_bookings", { select: "id", ledger_id: `eq.${primaryId}` });
  if (!bookings[0].deleted_at && !shared.some((row) => row.id === result.bookingId)) throw new Error("Second user cannot read the shared booking.");
  const isolated = await api.rows(memberToken, "ledgers", { select: "id", id: `eq.${WORKSPACES[1].slug}` });
  if (isolated.length) throw new Error("Workspace isolation failed: non-member can read the private workspace.");
  result.sharedReadPassed = true;
  result.isolationReadPassed = true;
  report("Normal sign-in, workspace creation, invite redemption, shared reads and non-member isolation passed.");
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["apply"] });
  if (args._.length || Object.keys(args).some((key) => !["_", "env", "state-dir", "apply"].includes(key)) ||
      (args.apply !== undefined && args.apply !== true) || typeof args["state-dir"] !== "string") {
    throw new Error("Usage: node tools/native-e2e/seed-fixture.mjs --env <private file> --state-dir <private directory outside Git> [--apply]");
  }
  const config = loadStagingConfig(args.env, ["STAGING_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY"]);
  if (!args.apply) {
    console.log(JSON.stringify({ mode: "dry-run", projectUrl: STAGING_URL, users: IDENTITIES.map((u) => u.name), workspaces: WORKSPACES, bookings: 1 }));
    return;
  }
  mkdirSync(args["state-dir"], { recursive: true, mode: 0o700 });
  const dirInfo = lstatSync(args["state-dir"]);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || (dirInfo.mode & 0o077) !== 0 ||
      (process.getuid && dirInfo.uid !== process.getuid())) throw new Error("Fixture directory must be owner-only (chmod 700), not a symlink.");
  const directory = realpathSync(args["state-dir"]);
  const filename = path.join(directory, "accounts.json");
  assertOutsideGit(filename);
  const lock = path.join(directory, "seed.lock");
  const fd = openSync(lock, "wx", 0o600);
  try {
    if (!existsSync(filename)) {
      writeFileSync(filename, JSON.stringify({ version: 1, projectUrl: STAGING_URL, createdAt: new Date().toISOString(),
        users: IDENTITIES.map((user) => ({ ...user, password: `QA!${randomBytes(24).toString("base64url")}a1` })),
      }, null, 2), { flag: "wx", mode: 0o600 });
    }
    let parsed;
    try { parsed = JSON.parse(readPrivateFile(filename)); } catch {
      throw new Error("Cannot read valid private fixture state. No credentials were printed or replaced.");
    }
    const state = validateFixtureState(parsed);
    const result = await seedFixture(createStagingApi(config), state, console.log);
    console.log(JSON.stringify(result));
    console.log(`Test-account passwords remain only in ${filename}. No access or refresh tokens were saved.`);
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
