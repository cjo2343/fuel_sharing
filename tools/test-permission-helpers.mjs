import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadContext() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(readFileSync("permission-helpers.js", "utf8"), context, { filename: "permission-helpers.js" });
  return context.window.permissionHelpers;
}

function member(name, role = "member") {
  return { name, role, is_active: true };
}

function testEntryOwnerAndAdminPermissions() {
  const helpers = loadContext();
  const christian = member("Christian");
  const marie = member("Marie");
  const admin = member("Admin", "admin");

  assert.equal(helpers.canManageTripEntryForProfile({ driver: "Christian" }, christian), true);
  assert.equal(helpers.canManageTripEntryForProfile({ driver: "Christian" }, marie), false);
  assert.equal(helpers.canManageTripEntryForProfile({ driver: "Christian" }, admin), true);

  assert.equal(helpers.canManageFuelEntryForProfile({ payer: "Marie" }, marie), true);
  assert.equal(helpers.canManageFuelEntryForProfile({ payer: "Marie" }, christian), false);
  assert.equal(helpers.canManageFuelEntryForProfile({ payer: "Marie" }, admin), true);

  assert.equal(helpers.canManageBookingEntryForProfile({ member: "Christian" }, christian), true);
  assert.equal(helpers.canManageBookingEntryForProfile({ member: "Christian" }, marie), false);
  assert.equal(helpers.canManageBookingEntryForProfile({ member: "Christian" }, admin), true);
}

function testSettlementPaymentPermissions() {
  const helpers = loadContext();
  const settlement = { from: "Marie", to: "Christian", amount: 100 };
  const christian = member("Christian");
  const marie = member("Marie");
  const jonas = member("Jonas");
  const admin = member("Admin", "admin");

  assert.equal(helpers.canManageSettlementRequestForProfile(settlement, christian), true, "recipient can request payment");
  assert.equal(helpers.canManageSettlementRequestForProfile(settlement, marie), false, "debtor cannot request their own payment");
  assert.equal(helpers.canManageSettlementRequestForProfile(settlement, admin), true, "admin can request/reopen payment");

  assert.equal(helpers.canMarkSettlementPaidForProfile(settlement, marie), true, "debtor can mark paid");
  assert.equal(helpers.canMarkSettlementPaidForProfile(settlement, christian), false, "recipient cannot mark current payment paid without admin role");
  assert.equal(helpers.canMarkSettlementPaidForProfile(settlement, jonas), false, "unrelated member cannot mark paid");
  assert.equal(helpers.canMarkSettlementPaidForProfile(settlement, admin), true, "admin can mark paid");
}

function testUnknownAndBootstrapPermissionsAreSafe() {
  const helpers = loadContext();
  assert.equal(helpers.canManageTripEntryForProfile({ driver: "Christian" }, null), false);
  assert.equal(helpers.canManageFuelEntryForProfile(null, member("Christian")), false);
  assert.equal(helpers.canMarkSettlementPaidForProfile({ from: "Christian", to: "Marie" }, null), false);
  assert.equal(helpers.canManageTripEntryForProfile({ driver: "Christian" }, null, { noMemberEmailsConfigured: true }), true);
}

function testLastAdminAndSelfProtectionSummary() {
  const helpers = loadContext();
  const christianAdmin = member("Christian", "admin");
  const marieMember = member("Marie");

  const self = helpers.summarizeMemberAdminProtection(christianAdmin, [christianAdmin, marieMember], christianAdmin);
  assert.equal(self.isSelf, true);
  assert.equal(self.canDeactivate, false);
  assert.equal(self.canDemote, false);

  const lastAdmin = helpers.summarizeMemberAdminProtection(christianAdmin, [christianAdmin, marieMember], marieMember);
  assert.equal(lastAdmin.isLastActiveAdmin, true);
  assert.equal(lastAdmin.canDeactivate, false);
  assert.equal(lastAdmin.canDemote, false);

  const secondAdmin = member("Jonas", "admin");
  const protectedSecond = helpers.summarizeMemberAdminProtection(christianAdmin, [christianAdmin, secondAdmin, marieMember], marieMember);
  assert.equal(protectedSecond.isLastActiveAdmin, false);
  assert.equal(protectedSecond.canDeactivate, true);
  assert.equal(protectedSecond.canDemote, true);
}

const tests = [
  testEntryOwnerAndAdminPermissions,
  testSettlementPaymentPermissions,
  testUnknownAndBootstrapPermissionsAreSafe,
  testLastAdminAndSelfProtectionSummary
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}
