(function () {
  function profileName(profile) {
    return typeof profile?.name === "string" ? profile.name.trim() : "";
  }

  function profileRole(profile) {
    return profile?.role === "admin" ? "admin" : "member";
  }

  function hasAdminPermission(profile, options = {}) {
    return Boolean(options.noMemberEmailsConfigured || profileRole(profile) === "admin");
  }

  function canManageOwnedEntry(entry, ownerField, profile, options = {}) {
    if (!entry || !ownerField) return false;
    if (hasAdminPermission(profile, options)) return true;
    const name = profileName(profile);
    return Boolean(name && entry[ownerField] === name);
  }

  function canManageTripEntryForProfile(trip, profile, options = {}) {
    return canManageOwnedEntry(trip, "driver", profile, options);
  }

  function canManageFuelEntryForProfile(fuel, profile, options = {}) {
    return canManageOwnedEntry(fuel, "payer", profile, options);
  }

  function canManageBookingEntryForProfile(booking, profile, options = {}) {
    return canManageOwnedEntry(booking, "member", profile, options);
  }

  function canManageSettlementRequestForProfile(settlement, profile, options = {}) {
    if (!settlement) return false;
    if (hasAdminPermission(profile, options)) return true;
    const name = profileName(profile);
    return Boolean(name && settlement.to === name);
  }

  function canMarkSettlementPaidForProfile(settlement, profile, options = {}) {
    if (!settlement) return false;
    if (hasAdminPermission(profile, options)) return true;
    const name = profileName(profile);
    return Boolean(name && settlement.from === name);
  }

  function summarizeMemberAdminProtection(member, members, currentProfile) {
    const rows = Array.isArray(members) ? members : [];
    const activeAdmins = rows.filter((item) => item?.is_active !== false && item?.role === "admin");
    const isSelf = Boolean(profileName(currentProfile) && member?.name === profileName(currentProfile));
    const isActiveAdmin = member?.is_active !== false && member?.role === "admin";
    const isLastActiveAdmin = isActiveAdmin && activeAdmins.length <= 1;
    return {
      isSelf,
      isActiveAdmin,
      isLastActiveAdmin,
      canDeactivate: !isSelf && !isLastActiveAdmin,
      canDemote: !isSelf && !isLastActiveAdmin,
      message: isSelf
        ? "You cannot deactivate or demote yourself. Add another admin first."
        : isLastActiveAdmin
          ? "At least one active admin is required. Add or promote another admin first."
          : ""
    };
  }

  window.permissionHelpers = Object.freeze({
    hasAdminPermission,
    canManageTripEntryForProfile,
    canManageFuelEntryForProfile,
    canManageBookingEntryForProfile,
    canManageSettlementRequestForProfile,
    canMarkSettlementPaidForProfile,
    summarizeMemberAdminProtection
  });
})();
