const storageKey = "car-share-ledger-v1";
const stationSearchRadiusMeters = 2500;
const userKey = "car-share-current-user";
const loginCooldownKey = "car-share-login-cooldown-until";
const pendingLoginEmailKey = "car-share-pending-login-email";
const rememberedLoginEmailKey = "car-share-remembered-login-email";
const loginRequestedFromUrl = new URLSearchParams(window.location.search).has("login");
const apiStateUrl = "/api/state";
const pushConfigUrl = "/api/push-config";
const fuelPriceUrl = "/api/fuel-price";
const pushSubscriptionsUrl = "/api/push-subscriptions";
const sendPushUrl = "/api/send-push";
const mobilePayReturnKey = "fuel-ledger-mobilepay-return";
const generatedTestPrefix = "auto-test-";
const generatedTestMarker = "[AUTO TEST]";
const supabaseConfig = window.CAR_SHARE_SUPABASE || {};
const hasSupabaseConfig =
  supabaseConfig.enabled &&
  supabaseConfig.url &&
  supabaseConfig.anonKey &&
  !supabaseConfig.url.includes("YOUR_PROJECT_REF") &&
  !supabaseConfig.anonKey.includes("YOUR_SUPABASE");
const supabaseClient =
  hasSupabaseConfig && window.supabase
    ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey)
    : null;

function localDateString(date = new Date()) {
  const local = new Date(date);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 10);
}

function normalizePhone(value) {
  return String(value || "").trim().replace(/[^+\d]/g, "");
}

function formatPhoneDisplay(value) {
  const phone = normalizePhone(value);
  if (!phone) return "";
  if (phone.startsWith("+45") && phone.length === 11) {
    return `+45 ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7, 9)} ${phone.slice(9, 11)}`;
  }
  return phone;
}

function buildMobilePayNote(settlement) {
  return `Fuel Ledger: ${settlement.from} pays ${settlement.to}`;
}

function formatPaymentAmountOnly(value) {
  return new Intl.NumberFormat("da-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(roundMoney(value));
}

function getMobilePayReturnPrompt(key) {
  try {
    const prompt = JSON.parse(localStorage.getItem(mobilePayReturnKey) || "null");
    if (!prompt || prompt.key !== key) return null;
    if (Date.now() - Number(prompt.openedAt || 0) > 30 * 60 * 1000) {
      localStorage.removeItem(mobilePayReturnKey);
      return null;
    }
    return prompt;
  } catch {
    localStorage.removeItem(mobilePayReturnKey);
    return null;
  }
}

function rememberMobilePayReturnPrompt(settlement) {
  if (!settlement) return;
  try {
    localStorage.setItem(
      mobilePayReturnKey,
      JSON.stringify({
        key: settlementKey(settlement),
        amount: formatPaymentAmountOnly(settlement.amount),
        to: settlement.to,
        openedAt: Date.now()
      })
    );
  } catch {
    // Ignore storage errors. The payment still happens in MobilePay.
  }
}

function clearMobilePayReturnPrompt(key) {
  const prompt = getMobilePayReturnPrompt(key);
  if (prompt) localStorage.removeItem(mobilePayReturnKey);
}

function openMobilePayApp(settlement) {
  rememberMobilePayReturnPrompt(settlement);
  window.location.href = "mobilepay://";
}

const defaults = {
  currency: "DKK",
  members: ["Christian", "Emilie", "Jonas", "Marie"],
  memberProfiles: {
    Christian: { email: "", role: "admin", mobilepayPhone: "" },
    Emilie: { email: "", role: "member", mobilepayPhone: "" },
    Jonas: { email: "", role: "member", mobilepayPhone: "" },
    Marie: { email: "", role: "member", mobilepayPhone: "" }
  },
  trips: [],
  fuel: [],
  paymentStatuses: {},
  currentPeriodId: "",
  closedPeriods: [],
  lastOdometer: "",
  fuelType: "diesel",
  fuelConsumption: 5.3,
  fuelFallbackPrice: 14.5,
  fuelWarningThreshold: 70,
  carSettingsVersion: 2
};

let state = loadState();
let currentUser = localStorage.getItem(userKey) || "";
let remoteSaveTimer;
let currentSession = null;
let loginCooldownTimer;
let editingTripId = null;
let editingFuelId = null;
let supabaseStateChannel = null;
let ignoreRealtimeUntil = 0;
let deferredInstallPrompt = null;
let pushSupported = false;
let pushEnabled = false;
let latestFuelPrice = null;
let fuelPriceTimer = null;
let lastCloudSaveAt = "";
let lastJsonMirrorSaveAt = "";
let lastSyncError = "";
const jsonMirrorBackupIntervalMs = 30 * 60 * 1000;
let normalizedTableStatus = {
  checked: false,
  ok: false,
  message: "Normalized tables have not been checked yet.",
  details: []
};
let databaseDiagnosticsStatus = {
  checked: false,
  loading: false,
  error: "",
  rows: []
};
let memberManagementStatus = {
  loaded: false,
  loading: false,
  error: "",
  rows: []
};
let normalizedReadModeActive = false;
const pendingSettlementRequestKeys = new Set();
const viewStorageKey = "fuel-ledger-active-view";
let activeView = localStorage.getItem(viewStorageKey) || "log";

const els = {
  totalKm: document.querySelector("#totalKm"),
  fuelRate: document.querySelector("#fuelRate"),
  totalCost: document.querySelector("#totalCost"),
  totalPaid: document.querySelector("#totalPaid"),
  sectionTabs: Array.from(document.querySelectorAll("[data-view-tab]")),
  viewSections: Array.from(document.querySelectorAll("[data-view]")),
  authPanel: document.querySelector("#authPanel"),
  loginForm: document.querySelector("#loginForm"),
  otpForm: document.querySelector("#otpForm"),
  loginEmail: document.querySelector("#loginEmail"),
  loginCode: document.querySelector("#loginCode"),
  authMessage: document.querySelector("#authMessage"),
  signOut: document.querySelector("#signOut"),
  currentUser: document.querySelector("#currentUser"),
  syncStatus: document.querySelector("#syncStatus"),
  syncDetail: document.querySelector("#syncDetail"),
  tripDriver: document.querySelector("#tripDriver"),
  fuelPayer: document.querySelector("#fuelPayer"),
  tripDate: document.querySelector("#tripDate"),
  tripParticipants: document.querySelector("#tripParticipants"),
  fuelDate: document.querySelector("#fuelDate"),
  startKm: document.querySelector("#startKm"),
  endKm: document.querySelector("#endKm"),
  tripNote: document.querySelector("#tripNote"),
  fuelAmount: document.querySelector("#fuelAmount"),
  fuelLiters: document.querySelector("#fuelLiters"),
  fuelOdometer: document.querySelector("#fuelOdometer"),
  fuelStation: document.querySelector("#fuelStation"),
  useFuelLocation: document.querySelector("#useFuelLocation"),
  nearbyFuelStations: document.querySelector("#nearbyFuelStations"),
  stationResults: document.querySelector("#stationResults"),
  fuelLocationStatus: document.querySelector("#fuelLocationStatus"),
  fuelLatitude: document.querySelector("#fuelLatitude"),
  fuelLongitude: document.querySelector("#fuelLongitude"),
  fuelStationLatitude: document.querySelector("#fuelStationLatitude"),
  fuelStationLongitude: document.querySelector("#fuelStationLongitude"),
  fuelStationBrand: document.querySelector("#fuelStationBrand"),
  fuelFullTank: document.querySelector("#fuelFullTank"),
  periodEntryLock: document.querySelector("#periodEntryLock"),
  tripLogPanel: document.querySelector("#tripLogPanel"),
  fuelLogPanel: document.querySelector("#fuelLogPanel"),
  currency: document.querySelector("#currency"),
  fuelType: document.querySelector("#fuelType"),
  fuelConsumption: document.querySelector("#fuelConsumption"),
  fuelFallbackPrice: document.querySelector("#fuelFallbackPrice"),
  fuelWarningThreshold: document.querySelector("#fuelWarningThreshold"),
  members: document.querySelector("#members"),
  tripForm: document.querySelector("#tripForm"),
  tripSubmit: document.querySelector("#tripSubmit"),
  cancelTripEdit: document.querySelector("#cancelTripEdit"),
  fuelForm: document.querySelector("#fuelForm"),
  fuelSubmit: document.querySelector("#fuelSubmit"),
  cancelFuelEdit: document.querySelector("#cancelFuelEdit"),
  tripEstimatorForm: document.querySelector("#tripEstimatorForm"),
  tripEstimateDistance: document.querySelector("#tripEstimateDistance"),
  tripEstimatorParticipants: document.querySelector("#tripEstimatorParticipants"),
  tripEstimateResult: document.querySelector("#tripEstimateResult"),
  fuelIntelligence: document.querySelector("#fuelIntelligence"),
  smartPredictions: document.querySelector("#smartPredictions"),
  monthlyMemberSummaries: document.querySelector("#monthlyMemberSummaries"),
  settingsForm: document.querySelector("#settingsForm"),
  settingsPanel: document.querySelector(".settings-panel"),
  settlementWarning: document.querySelector("#settlementWarning"),
  paymentOverview: document.querySelector("#paymentOverview"),
  memberActionPanel: document.querySelector("#memberActionPanel"),
  periodBreakdown: document.querySelector("#periodBreakdown"),
  settlements: document.querySelector("#settlements"),
  peopleBalances: document.querySelector("#peopleBalances"),
  tripList: document.querySelector("#tripList"),
  fuelList: document.querySelector("#fuelList"),
  closePeriod: document.querySelector("#closePeriod"),
  periodList: document.querySelector("#periodList"),
  resetPeriod: document.querySelector("#resetPeriod"),
  resetData: document.querySelector("#resetData"),
  dataToolsPanel: document.querySelector(".data-tools-panel"),
  dataToolsMessage: document.querySelector("#dataToolsMessage"),
  systemHealthPanel: document.querySelector(".system-health-panel"),
  systemHealthSummary: document.querySelector("#systemHealthSummary"),
  systemHealthList: document.querySelector("#systemHealthList"),
  databaseDiagnosticsPanel: document.querySelector(".database-diagnostics-panel"),
  databaseDiagnosticsList: document.querySelector("#databaseDiagnosticsList"),
  refreshDatabaseDiagnostics: document.querySelector("#refreshDatabaseDiagnostics"),
  memberManagementPanel: document.querySelector(".member-management-panel"),
  memberManagementForm: document.querySelector("#memberManagementForm"),
  memberManagementList: document.querySelector("#memberManagementList"),
  memberManagementMessage: document.querySelector("#memberManagementMessage"),
  refreshMembers: document.querySelector("#refreshMembers"),
  newMemberName: document.querySelector("#newMemberName"),
  newMemberEmail: document.querySelector("#newMemberEmail"),
  newMemberMobilePayPhone: document.querySelector("#newMemberMobilePayPhone"),
  newMemberRole: document.querySelector("#newMemberRole"),
  saveJsonBackupNow: document.querySelector("#saveJsonBackupNow"),
  cleanStaleRequests: document.querySelector("#cleanStaleRequests"),
  productionActivityReset: document.querySelector("#productionActivityReset"),
  exportLedger: document.querySelector("#exportLedger"),
  importLedger: document.querySelector("#importLedger"),
  importLedgerFile: document.querySelector("#importLedgerFile"),
  downloadCsv: document.querySelector("#downloadCsv"),
  downloadPeriodReport: document.querySelector("#downloadPeriodReport"),
  removeTestUsers: document.querySelector("#removeTestUsers"),
  addTestTrip: document.querySelector("#addTestTrip"),
  addTestFuel: document.querySelector("#addTestFuel"),
  removeTestData: document.querySelector("#removeTestData"),
  runStressTest: document.querySelector("#runStressTest"),
  runRapidSaveTest: document.querySelector("#runRapidSaveTest"),
  pwaPanel: document.querySelector("#pwaPanel"),
  pwaMessage: document.querySelector("#pwaMessage"),
  installApp: document.querySelector("#installApp"),
  enablePush: document.querySelector("#enablePush"),
  emptyTemplate: document.querySelector("#emptyTemplate")
};

state.lastOdometer = getLatestOdometer();
setDefaultDates();
render();
initializeSync();
initializePwa();
refreshFuelPriceEstimate();

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendLoginLink();
});

els.otpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await verifyLoginCode();
});

els.signOut.addEventListener("click", async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentSession = null;
  updateAuthUi();
});

if (els.installApp) {
  els.installApp.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    updatePwaUi();
  });
}

if (els.enablePush) {
  els.enablePush.addEventListener("click", async () => {
    await enablePushNotifications();
  });
}

els.currentUser.addEventListener("change", () => {
  currentUser = els.currentUser.value;
  localStorage.setItem(userKey, currentUser);
  renderPeopleSelectors();
});

els.tripDriver.addEventListener("change", () => {
  const driverCheckbox = els.tripParticipants.querySelector(
    `[data-participant="${cssEscape(els.tripDriver.value)}"]`
  );
  if (driverCheckbox) driverCheckbox.checked = true;
});

els.tripForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canUseAppAsMember()) {
    alert("Your email is not assigned to a member yet. Ask an admin to add it.");
    return;
  }
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  const start = Number(els.startKm.value);
  const end = Number(els.endKm.value);
  const participants = getSelectedParticipants();

  if (end <= start) {
    alert("End odometer must be higher than start odometer.");
    return;
  }

  if (participants.length === 0) {
    alert("Choose at least one person to split the trip with.");
    return;
  }

  const tripPayload = {
    id: editingTripId || crypto.randomUUID(),
    driver: els.tripDriver.value,
    participants,
    date: els.tripDate.value,
    startKm: round(start),
    endKm: round(end),
    note: els.tripNote.value.trim()
  };

  const normalizedTripSaved = await saveTripToNormalizedTablesFirst(tripPayload);
  if (!normalizedTripSaved) return;

  if (editingTripId) {
    const index = state.trips.findIndex((trip) => trip.id === editingTripId);
    if (index >= 0) state.trips[index] = tripPayload;
    else state.trips.push(tripPayload);
    editingTripId = null;
  } else {
    state.trips.push(tripPayload);
  }
  state.lastOdometer = getLatestOdometer();

  saveState();
  els.tripForm.reset();
  setDefaultDates();
  updateEditUi();
  render();
});

if (els.useFuelLocation) {
  els.useFuelLocation.addEventListener("click", captureFuelLocation);
}

if (els.stationResults) {
  els.stationResults.addEventListener("click", (event) => {
    const button = event.target.closest("[data-station-index]");
    if (!button) return;
    const stations = JSON.parse(els.stationResults.dataset.stations || "[]");
    const station = stations[Number(button.dataset.stationIndex)];
    if (station) selectFuelStation(station);
  });
}

if (els.tripEstimateDistance) {
  els.tripEstimateDistance.addEventListener("input", renderTripEstimate);
}

if (els.tripEstimatorParticipants) {
  els.tripEstimatorParticipants.addEventListener("change", renderTripEstimate);
}

els.fuelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canUseAppAsMember()) {
    alert("Your email is not assigned to a member yet. Ask an admin to add it.");
    return;
  }
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  const amount = Number(els.fuelAmount.value);
  const liters = Number(els.fuelLiters?.value || 0);
  const odometer = Number(els.fuelOdometer?.value || 0);
  const station = els.fuelStation?.value.trim() || "";
  const latitude = Number(els.fuelLatitude?.value || 0);
  const longitude = Number(els.fuelLongitude?.value || 0);
  const stationLatitude = Number(els.fuelStationLatitude?.value || 0);
  const stationLongitude = Number(els.fuelStationLongitude?.value || 0);
  const stationBrand = els.fuelStationBrand?.value.trim() || "";
  const fullTank = Boolean(els.fuelFullTank?.checked);

  if (amount <= 0) {
    alert("Fuel amount must be higher than zero.");
    return;
  }

  const normalizedLiters = liters > 0 ? round(liters) : "";
  const fuelPayload = {
    id: editingFuelId || crypto.randomUUID(),
    payer: els.fuelPayer.value,
    date: els.fuelDate.value,
    amount: roundMoney(amount),
    liters: normalizedLiters,
    pricePerLiter: normalizedLiters ? roundMoney(amount / normalizedLiters) : "",
    odometer: odometer > 0 ? round(odometer) : "",
    station,
    location: latitude && longitude ? { latitude, longitude } : null,
    stationInfo: stationLatitude && stationLongitude
      ? { name: station, brand: stationBrand, latitude: stationLatitude, longitude: stationLongitude }
      : null,
    fullTank
  };

  const normalizedFuelSaved = await saveFuelToNormalizedTablesFirst(fuelPayload);
  if (!normalizedFuelSaved) return;

  if (editingFuelId) {
    const index = state.fuel.findIndex((fuel) => fuel.id === editingFuelId);
    if (index >= 0) state.fuel[index] = fuelPayload;
    else state.fuel.push(fuelPayload);
    editingFuelId = null;
  } else {
    state.fuel.push(fuelPayload);
  }

  saveState();
  els.fuelForm.reset();
  clearFuelLocation();
  setDefaultDates();
  updateEditUi();
  render();
});

function captureFuelLocation() {
  if (!navigator.geolocation) {
    if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "GPS is not available in this browser.";
    return;
  }

  if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "Getting location...";
  if (els.useFuelLocation) els.useFuelLocation.disabled = true;
  if (els.stationResults) {
    els.stationResults.classList.add("hidden");
    els.stationResults.replaceChildren();
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const latitude = Number(position.coords.latitude.toFixed(6));
      const longitude = Number(position.coords.longitude.toFixed(6));
      if (els.fuelLatitude) els.fuelLatitude.value = String(latitude);
      if (els.fuelLongitude) els.fuelLongitude.value = String(longitude);
      if (els.nearbyFuelStations) {
        els.nearbyFuelStations.href = `https://www.google.com/maps/search/tankstationer/@${latitude},${longitude},14z`;
        els.nearbyFuelStations.classList.remove("hidden");
      }

      try {
        if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "Looking for nearby stations...";
        const stations = await fetchNearbyFuelStations(latitude, longitude);
        renderFuelStationResults(stations, latitude, longitude);
        if (els.fuelLocationStatus) {
          els.fuelLocationStatus.textContent = stations.length
            ? "Pick the correct station below, or type it manually."
            : "No nearby stations found. You can still type the station manually.";
        }
      } catch {
        if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "Could not load nearby stations. You can still type the station manually.";
      } finally {
        if (els.useFuelLocation) els.useFuelLocation.disabled = false;
      }
    },
    () => {
      if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "Could not get location. You can still type the station manually.";
      if (els.useFuelLocation) els.useFuelLocation.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
  );
}

async function fetchNearbyFuelStations(latitude, longitude) {
  const query = `
    [out:json][timeout:8];
    (
      node["amenity"="fuel"](around:${stationSearchRadiusMeters},${latitude},${longitude});
      way["amenity"="fuel"](around:${stationSearchRadiusMeters},${latitude},${longitude});
      relation["amenity"="fuel"](around:${stationSearchRadiusMeters},${latitude},${longitude});
    );
    out center tags 20;
  `;
  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ data: query })
  });

  if (!response.ok) throw new Error("Station lookup failed");
  const data = await response.json();
  return (data.elements || [])
    .map((item) => {
      const lat = item.lat ?? item.center?.lat;
      const lon = item.lon ?? item.center?.lon;
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
      const tags = item.tags || {};
      const brand = tags.brand || tags.operator || "";
      const name = tags.name || brand || "Fuel station";
      return {
        id: `${item.type}-${item.id}`,
        name,
        brand,
        latitude: Number(lat),
        longitude: Number(lon),
        distanceMeters: distanceInMeters(latitude, longitude, Number(lat), Number(lon))
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 8);
}

function renderFuelStationResults(stations) {
  if (!els.stationResults) return;

  if (!stations.length) {
    els.stationResults.classList.add("hidden");
    els.stationResults.replaceChildren();
    els.stationResults.dataset.stations = "[]";
    return;
  }

  els.stationResults.dataset.stations = JSON.stringify(stations);
  els.stationResults.classList.remove("hidden");
  els.stationResults.innerHTML = `
    <div class="station-results-header">Nearby fuel stations</div>
    ${stations
      .map((station, index) => `
        <button class="station-option" type="button" data-station-index="${index}">
          <span>
            <strong>${escapeHtml(station.name)}</strong>
            ${station.brand && station.brand !== station.name ? `<small>${escapeHtml(station.brand)}</small>` : ""}
          </span>
          <b>${formatStationDistance(station.distanceMeters)}</b>
        </button>
      `)
      .join("")}
  `;
}

function selectFuelStation(station) {
  if (els.fuelStation) els.fuelStation.value = station.name;
  if (els.fuelStationLatitude) els.fuelStationLatitude.value = String(Number(station.latitude).toFixed(6));
  if (els.fuelStationLongitude) els.fuelStationLongitude.value = String(Number(station.longitude).toFixed(6));
  if (els.fuelStationBrand) els.fuelStationBrand.value = station.brand || "";
  if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = `${station.name} selected.`;

  if (els.stationResults) {
    for (const option of els.stationResults.querySelectorAll(".station-option")) {
      option.classList.toggle("is-selected", option.dataset.stationIndex === String(JSON.parse(els.stationResults.dataset.stations || "[]").findIndex((item) => item.id === station.id)));
    }
  }
}

function clearFuelLocation() {
  if (els.fuelLatitude) els.fuelLatitude.value = "";
  if (els.fuelLongitude) els.fuelLongitude.value = "";
  if (els.fuelStationLatitude) els.fuelStationLatitude.value = "";
  if (els.fuelStationLongitude) els.fuelStationLongitude.value = "";
  if (els.fuelStationBrand) els.fuelStationBrand.value = "";
  if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "";
  if (els.stationResults) {
    els.stationResults.dataset.stations = "[]";
    els.stationResults.classList.add("hidden");
    els.stationResults.replaceChildren();
  }
  if (els.nearbyFuelStations) {
    els.nearbyFuelStations.href = "#";
    els.nearbyFuelStations.classList.add("hidden");
  }
  if (els.useFuelLocation) els.useFuelLocation.disabled = false;
}

function distanceInMeters(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatStationDistance(meters) {
  if (!Number.isFinite(meters)) return "";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${new Intl.NumberFormat("en-DK", { maximumFractionDigits: 1 }).format(meters / 1000)} km`;
}


els.sectionTabs.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveView(button.dataset.viewTab || "log");
  });
});

function setActiveView(view) {
  const requestedView = view || "log";
  activeView = requestedView === "admin" && !canManageSettings() ? "log" : requestedView;
  localStorage.setItem(viewStorageKey, activeView);
  render();
}

function renderSectionNavigation() {
  if (activeView === "admin" && !canManageSettings()) activeView = "log";
  els.sectionTabs.forEach((button) => {
    const view = button.dataset.viewTab;
    const isAdminTab = view === "admin";
    button.classList.toggle("hidden", isAdminTab && !canManageSettings());
    button.classList.toggle("active", view === activeView);
    button.setAttribute("aria-current", view === activeView ? "page" : "false");
  });
  els.viewSections.forEach((section) => {
    const view = section.dataset.view;
    section.classList.toggle("view-hidden", view !== activeView);
  });
}

els.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!canManageSettings()) {
    alert("Only an admin can change group settings.");
    return;
  }

  const parsed = parseMemberSettings(els.members.value);
  const members = parsed.map((member) => member.name);

  if (members.length < 2) {
    alert("Add at least two people.");
    return;
  }

  state.currency = els.currency.value.trim() || defaults.currency;
  state.fuelType = els.fuelType?.value || defaults.fuelType;
  state.fuelConsumption = Math.max(0.1, Number(els.fuelConsumption?.value) || defaults.fuelConsumption);
  state.fuelFallbackPrice = Math.max(0.1, Number(els.fuelFallbackPrice?.value) || defaults.fuelFallbackPrice);
  state.fuelWarningThreshold = Math.min(100, Math.max(1, Number(els.fuelWarningThreshold?.value) || defaults.fuelWarningThreshold));
  state.members = [...new Set(members)];
  state.memberProfiles = Object.fromEntries(
    parsed.map((member, index) => [
      member.name,
      {
        email: member.email,
        role: member.role || (index === 0 && noMemberEmailsConfigured() ? "admin" : "member"),
        mobilepayPhone: normalizePhone(member.mobilepayPhone || member.mobilepay_phone || "")
      }
    ])
  );
  state.trips = state.trips.filter((trip) => state.members.includes(trip.driver));
  state.trips = state.trips.map((trip) => ({
    ...trip,
    participants: getTripParticipants(trip).filter((member) => state.members.includes(member))
  }));
  state.fuel = state.fuel.filter((fuel) => state.members.includes(fuel.payer));

  saveState();
  render();
});

els.resetPeriod.addEventListener("click", () => {
  if (!canManageSettings()) {
    alert("Only an admin can reset the current period.");
    return;
  }
  if (state.trips.length === 0 && state.fuel.length === 0) {
    alert("There is no current period data to reset.");
    return;
  }
  if (!confirm("Remove all trips, fuel payments, and request statuses from the current open period? Settings and archived periods stay unchanged.")) return;
  state.trips = [];
  state.fuel = [];
  state.paymentStatuses = {};
  state.lastOdometer = getLatestOdometer();
  saveState();
  setDefaultDates();
  render();
});

els.resetData.addEventListener("click", () => {
  if (!canManageSettings()) {
    alert("Only an admin can reset data.");
    return;
  }
  if (!confirm("Reset all trips, fuel payments, and settings?")) return;
  state = structuredClone(defaults);
  saveState();
  setDefaultDates();
  render();
});


els.exportLedger?.addEventListener("click", () => {
  if (!canManageSettings()) return;
  exportLedgerBackup();
});

els.importLedger?.addEventListener("click", () => {
  if (!canManageSettings()) return;
  els.importLedgerFile?.click();
});

els.importLedgerFile?.addEventListener("change", async () => {
  if (!canManageSettings()) return;
  await importLedgerBackup();
});

els.downloadCsv?.addEventListener("click", () => {
  if (!canManageSettings()) return;
  downloadLedgerCsv();
});

els.downloadPeriodReport?.addEventListener("click", () => {
  if (!canManageSettings()) return;
  downloadCurrentPeriodReport();
});

els.removeTestUsers?.addEventListener("click", () => {
  if (!canManageSettings()) return;
  removeUnusedTestUsers();
});

els.addTestTrip?.addEventListener("click", () => {
  if (!canManageSettings()) return;
  addGeneratedTestTrip();
});

els.addTestFuel?.addEventListener("click", () => {
  if (!canManageSettings()) return;
  addGeneratedTestFuel();
});

els.removeTestData?.addEventListener("click", () => {
  if (!canManageSettings()) return;
  removeGeneratedTestData();
});

els.runStressTest?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  await runGeneratedStressTest();
});

els.runRapidSaveTest?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  await runGeneratedRapidSaveTest();
});

els.memberManagementForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canManageSettings()) return;
  await addManagedMember();
});

els.refreshMembers?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  await refreshMemberManagement();
});

els.memberManagementList?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-member-action]");
  if (!button || !canManageSettings()) return;
  const row = button.closest("[data-member-id]");
  if (!row) return;
  const action = button.dataset.memberAction;
  if (action === "save") await saveManagedMember(row);
  if (action === "deactivate") await setManagedMemberActive(row, false);
  if (action === "reactivate") await setManagedMemberActive(row, true);
});

els.refreshDatabaseDiagnostics?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  await refreshDatabaseDiagnostics();
  await checkNormalizedTablesAgainstCurrentState().catch((error) => {
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not refresh normalized table health: ${error.message || error}`
    };
    render();
  });
});

els.saveJsonBackupNow?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  els.saveJsonBackupNow.disabled = true;
  try {
    await saveJsonMirrorBackup({ force: true });
    await refreshDatabaseDiagnostics();
  } finally {
    els.saveJsonBackupNow.disabled = false;
  }
});

els.cleanStaleRequests?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  els.cleanStaleRequests.disabled = true;
  try {
    const cleaned = await cleanStaleSettlementRequests();
    els.authMessage.textContent = cleaned
      ? `Cleaned ${cleaned} stale settlement request row${cleaned === 1 ? "" : "s"}.`
      : "No stale settlement request rows found.";
  } catch (error) {
    els.authMessage.textContent = `Could not clean stale request rows: ${error.message || error}`;
  } finally {
    els.cleanStaleRequests.disabled = false;
    await refreshDatabaseDiagnostics();
    await checkNormalizedTablesAgainstCurrentState().catch((error) => {
      normalizedTableStatus = {
        checked: true,
        ok: false,
        message: `Could not refresh normalized payment request health after cleanup: ${error.message || error}`
      };
      render();
    });
  }
});

els.productionActivityReset?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  await runProductionActivityReset();
});


function getTestActorName() {
  return currentUser || getMemberNames()[0] || "Christian";
}

function getTestParticipantNames(actor) {
  const members = getMemberNames();
  const ordered = [actor, ...members.filter((name) => name !== actor)];
  return Array.from(new Set(ordered)).slice(0, Math.min(2, Math.max(1, ordered.length)));
}

function addGeneratedTestTrip() {
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  const actor = getTestActorName();
  if (!actor) {
    alert("Add at least one member before creating test trips.");
    return;
  }

  const start = Number(getLatestOdometer() || 100000) + 1;
  const end = start + 12;
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  state.trips.push({
    id: `${generatedTestPrefix}trip-${crypto.randomUUID()}`,
    driver: actor,
    participants: getTestParticipantNames(actor),
    date: localDateString(),
    startKm: round(start),
    endKm: round(end),
    note: `${generatedTestMarker} generated trip ${stamp}`
  });

  state.lastOdometer = getLatestOdometer();
  setDataToolsMessage("Added one generated test trip. Triggered save + normalized sync.");
  saveState();
  setDefaultDates();
  render();
}

function addGeneratedTestFuel() {
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  const actor = getTestActorName();
  if (!actor) {
    alert("Add at least one member before creating test fuel logs.");
    return;
  }

  const amount = 123.45;
  const liters = 8.5;
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  state.fuel.push({
    id: `${generatedTestPrefix}fuel-${crypto.randomUUID()}`,
    payer: actor,
    date: localDateString(),
    amount: roundMoney(amount),
    liters: round(liters),
    pricePerLiter: roundMoney(amount / liters),
    odometer: getLatestOdometer() || "",
    station: `${generatedTestMarker} generated station ${stamp}`,
    location: null,
    stationInfo: null,
    fullTank: false
  });

  setDataToolsMessage("Added one generated test fuel log. Triggered save + normalized sync.");
  saveState();
  setDefaultDates();
  render();
}

function removeGeneratedTestData() {
  const beforeTrips = state.trips.length;
  const beforeFuel = state.fuel.length;

  state.trips = state.trips.filter((trip) => !isGeneratedTestEntry(trip));
  state.fuel = state.fuel.filter((fuel) => !isGeneratedTestEntry(fuel));

  const removedTrips = beforeTrips - state.trips.length;
  const removedFuel = beforeFuel - state.fuel.length;

  Object.keys(state.paymentStatuses || {}).forEach((key) => {
    if (key.includes(generatedTestPrefix) || key.includes(generatedTestMarker)) delete state.paymentStatuses[key];
  });

  state.lastOdometer = getLatestOdometer();
  setDataToolsMessage(`Removed ${removedTrips} generated test trip(s) and ${removedFuel} generated test fuel log(s). Triggered save + normalized sync.`);
  saveState();
  setDefaultDates();
  render();
}

function isGeneratedTestEntry(entry) {
  if (!entry) return false;
  return String(entry.id || "").startsWith(generatedTestPrefix) ||
    String(entry.note || "").includes(generatedTestMarker) ||
    String(entry.station || "").includes(generatedTestMarker);
}

function makeGeneratedTestTrip(index = 0) {
  const members = getMemberNames();
  const actor = members[index % Math.max(1, members.length)] || getTestActorName();
  const others = members.filter((name) => name !== actor);
  const participants = Array.from(new Set([
    actor,
    ...others.slice(index % Math.max(1, others.length), (index % Math.max(1, others.length)) + 2),
    ...others.slice(0, 2)
  ])).slice(0, Math.min(3, Math.max(1, members.length)));
  const start = Number(getLatestOdometer() || 100000) + 1 + (index * 18);
  const distance = 8 + (index % 7) * 11;
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  return {
    id: `${generatedTestPrefix}trip-${crypto.randomUUID()}`,
    driver: actor,
    participants,
    date: localDateString(new Date(Date.now() - (index % 5) * 86400000)),
    startKm: round(start),
    endKm: round(start + distance),
    note: `${generatedTestMarker} stress trip ${index + 1} generated ${stamp}`
  };
}

function makeGeneratedTestFuel(index = 0) {
  const members = getMemberNames();
  const actor = members[index % Math.max(1, members.length)] || getTestActorName();
  const liters = 5 + (index % 9) * 2.25;
  const price = 12.75 + (index % 5) * 0.45;
  const amount = roundMoney(liters * price);
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  return {
    id: `${generatedTestPrefix}fuel-${crypto.randomUUID()}`,
    payer: actor,
    date: localDateString(new Date(Date.now() - (index % 5) * 86400000)),
    amount,
    liters: round(liters),
    pricePerLiter: roundMoney(amount / liters),
    odometer: round(Number(getLatestOdometer() || 100000) + index * 25),
    station: `${generatedTestMarker} stress station ${index + 1} ${stamp}`,
    location: null,
    stationInfo: null,
    fullTank: index % 3 === 0
  };
}

async function flushStressSave(label) {
  localStorage.setItem(storageKey, JSON.stringify(state));
  if (supabaseClient && currentSession) {
    await saveSupabaseState();
    await checkNormalizedTablesAgainstCurrentState();
  } else {
    saveState();
  }
  render();
  setDataToolsMessage(label);
}

async function runGeneratedStressTest() {
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  if (!confirm("Run a generated stress test? This will add 25 test trips and 15 test fuel logs, save them, verify the normalized tables, then leave them visible until you press Remove test data.")) return;
  const members = getMemberNames();
  if (!members.length) {
    alert("Add at least one member before running the stress test.");
    return;
  }

  setDataToolsMessage("Running stress test: generating entries...");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const tripCount = 25;
  const fuelCount = 15;
  for (let i = 0; i < tripCount; i += 1) state.trips.push(makeGeneratedTestTrip(i));
  for (let i = 0; i < fuelCount; i += 1) state.fuel.push(makeGeneratedTestFuel(i));
  state.lastOdometer = getLatestOdometer();

  await flushStressSave(`Stress test added ${tripCount} trips and ${fuelCount} fuel logs. Normalized table check: ${normalizedTableStatus.ok ? "green" : "needs review"}.`);
}

async function runGeneratedRapidSaveTest() {
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  if (!confirm("Run a rapid save test? This will perform 8 small generated changes with separate saves. Generated data can be removed afterwards with Remove test data.")) return;
  const members = getMemberNames();
  if (!members.length) {
    alert("Add at least one member before running the rapid save test.");
    return;
  }

  for (let i = 0; i < 8; i += 1) {
    setDataToolsMessage(`Rapid save test ${i + 1}/8...`);
    if (i % 2 === 0) state.trips.push(makeGeneratedTestTrip(100 + i));
    else state.fuel.push(makeGeneratedTestFuel(100 + i));
    state.lastOdometer = getLatestOdometer();
    await flushStressSave(`Rapid save test ${i + 1}/8 saved.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  setDataToolsMessage(`Rapid save test complete. Normalized table check: ${normalizedTableStatus.ok ? "green" : "needs review"}.`);
  render();
}


if (els.cancelTripEdit) {
  els.cancelTripEdit.addEventListener("click", () => {
    editingTripId = null;
    els.tripForm.reset();
    setDefaultDates();
    updateEditUi();
    render();
  });
}

if (els.cancelFuelEdit) {
  els.cancelFuelEdit.addEventListener("click", () => {
    editingFuelId = null;
    els.fuelForm.reset();
    clearFuelLocation();
    setDefaultDates();
    updateEditUi();
    render();
  });
}

els.closePeriod.addEventListener("click", () => {
  closeCurrentPeriod();
});

document.addEventListener("click", async (event) => {
  const statusButton = event.target.closest("[data-payment-status]");
  if (statusButton) {
    updatePaymentStatus(statusButton);
    return;
  }

  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    copySettlement(copyButton);
    return;
  }

  const mobilePayButton = event.target.closest("[data-open-mobilepay]");
  if (mobilePayButton) {
    const ledger = calculateLedger();
    const settlement = ledger.settlements.find((item) => settlementKey(item) === mobilePayButton.dataset.paymentKey);
    openMobilePayApp(settlement);
    render();
    return;
  }

  const archiveReportButton = event.target.closest("[data-archive-report]");
  if (archiveReportButton) {
    downloadClosedPeriodReport(archiveReportButton.dataset.archiveReport);
    return;
  }

  const reviewPeriodButton = event.target.closest("[data-review-period]");
  if (reviewPeriodButton) {
    showHistoryForPeriodReview();
    return;
  }

  const editButton = event.target.closest("[data-edit]");
  if (editButton) {
    editEntry(editButton.dataset.edit);
    return;
  }

  const button = event.target.closest("[data-delete]");
  if (!button) return;

  const [type, id] = button.dataset.delete.split(":");
  const entry = type === "trips"
    ? state.trips.find((item) => item.id === id)
    : state.fuel.find((item) => item.id === id);
  const canDelete = type === "trips" ? canManageTripEntry(entry) : canManageFuelEntry(entry);
  if (!canDelete) {
    alert(type === "trips" ? "You can only delete your own trip logs." : "You can only delete your own fuel logs.");
    return;
  }

  const normalizedDeleteSaved = await softDeleteNormalizedEntryFirst(type, id);
  if (!normalizedDeleteSaved) return;
  state[type] = state[type].filter((entry) => entry.id !== id);
  if (type === "trips") state.lastOdometer = getLatestOdometer();
  if (editingTripId === id) editingTripId = null;
  if (editingFuelId === id) editingFuelId = null;
  saveState();
  updateEditUi();
  render();
});

function render() {
  document.body.classList.toggle("auth-locked", Boolean(supabaseClient && !currentSession));
  renderSettings();
  renderPeopleSelectors();
  renderTripEstimatorParticipants();
  syncStartOdometerDefault();
  const ledger = calculateLedger();
  renderSettleActionBadge(ledger);
  renderSummary(ledger);
  renderBalances(ledger);
  renderSettlements(ledger);
  renderHistory();
  renderClosedPeriods();
  renderTripEstimate();
  renderFuelIntelligence(ledger);
  renderSmartPredictions(ledger);
  renderMonthlyMemberSummaries(ledger);
  renderSystemHealth(ledger);
  renderDatabaseDiagnosticsPanel(ledger);
  renderMemberManagementPanel();
  els.resetPeriod.disabled = !canManageSettings() || (state.trips.length === 0 && state.fuel.length === 0);
  els.resetPeriod.classList.toggle("hidden", !canManageSettings());
  els.resetData.disabled = !canManageSettings();
  els.resetData.classList.toggle("hidden", !canManageSettings());
  if (els.dataToolsPanel) els.dataToolsPanel.classList.toggle("hidden", !canManageSettings());
  if (els.systemHealthPanel) els.systemHealthPanel.classList.toggle("hidden", !canManageSettings());
  if (els.databaseDiagnosticsPanel) els.databaseDiagnosticsPanel.classList.toggle("hidden", !canManageSettings());
  if (els.memberManagementPanel) els.memberManagementPanel.classList.toggle("hidden", !canManageSettings());
  renderSectionNavigation();
  updateEditUi();
}


async function initializeSync() {
  if (supabaseClient) {
    await initializeSupabase();
    return;
  }

  await loadRemoteState();
}

async function initializeSupabase() {
  setSyncStatus("Login");
  const { data } = await supabaseClient.auth.getSession();
  currentSession = data.session;
  if (currentSession?.user?.email) {
    localStorage.setItem(rememberedLoginEmailKey, currentSession.user.email);
    localStorage.removeItem(pendingLoginEmailKey);
  }
  updateAuthUi();

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentSession = session;
    if (session?.user?.email) {
      localStorage.setItem(rememberedLoginEmailKey, session.user.email);
      localStorage.removeItem(pendingLoginEmailKey);
    }
    updateAuthUi();
    if (session) {
      subscribeToSupabaseState();
      await loadSupabaseState();
    } else {
      unsubscribeFromSupabaseState();
    }
  });

  if (currentSession) {
    subscribeToSupabaseState();
    await loadSupabaseState();
  }
}

function updateAuthUi() {
  document.body.classList.toggle("auth-locked", Boolean(supabaseClient && !currentSession));

  if (!supabaseClient) {
    els.authPanel.classList.add("hidden");
    document.body.classList.remove("auth-locked");
    return;
  }

  const pendingEmail = localStorage.getItem(pendingLoginEmailKey);
  const rememberedEmail = localStorage.getItem(rememberedLoginEmailKey);
  const showOtpForm = Boolean(pendingEmail || loginRequestedFromUrl);

  els.authPanel.classList.remove("hidden");
  els.loginForm.classList.toggle("hidden", Boolean(currentSession));
  els.otpForm.classList.toggle("hidden", Boolean(currentSession) || !showOtpForm);
  els.signOut.classList.toggle("hidden", !currentSession);
  if (pendingEmail && !els.loginEmail.value) els.loginEmail.value = pendingEmail;
  if (!pendingEmail && !currentSession) els.loginEmail.value = "";

  const profile = getCurrentMemberProfile();
  const email = getLoggedInEmail();
  els.authMessage.textContent = currentSession
    ? profile
      ? `Signed in as ${email}. You will stay signed in on this device, so you should not need a code next time.`
      : `Signed in as ${email}, but this email is not assigned to a member yet. Ask an admin to add it.`
    : pendingEmail
      ? `Enter the login code sent to ${pendingEmail}.`
      : loginRequestedFromUrl
        ? "Enter your email and the login code from the email."
        : rememberedEmail
          ? "Welcome back. Enter your email to sign in on this device if your saved session has expired."
          : "Enter your email to sign in or join the shared car. After the first login, this device will stay signed in.";
  if (!currentSession) {
    setSyncStatus("Login");
  } else if (!["saving", "syncing", "local"].includes(els.syncStatus.dataset.status || "")) {
    setSyncStatus(normalizedReadModeActive ? "Tables" : "Cloud");
  }
  updateLoginCooldown();
  updatePwaUi();
}

async function sendLoginLink() {
  if (!supabaseClient) return;

  const email = els.loginEmail.value.trim();
  if (!email) return;

  if (isLoginCoolingDown()) {
    updateLoginCooldown();
    return;
  }

  startLoginCooldown();

  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split("#")[0] }
  });

  if (error?.status === 429 || error?.message?.toLowerCase().includes("rate limit")) {
    els.authMessage.textContent =
      "Supabase is rate limiting login links. Wait about 60 seconds before trying again.";
    updateLoginCooldown();
    return;
  }

  if (error) {
    els.authMessage.textContent = error.message;
    return;
  }

  localStorage.setItem(pendingLoginEmailKey, email);
  els.otpForm.classList.remove("hidden");
  els.loginCode.focus();
  els.authMessage.textContent = "Check your email and enter the login code.";
}

async function verifyLoginCode() {
  if (!supabaseClient) return;

  const email = localStorage.getItem(pendingLoginEmailKey) || els.loginEmail.value.trim();
  const token = els.loginCode.value.trim();

  if (!email || !token) {
    els.authMessage.textContent = "Enter both your email and the login code.";
    return;
  }

  const { data, error } = await supabaseClient.auth.verifyOtp({
    email,
    token,
    type: "email"
  });

  if (error) {
    els.authMessage.textContent = error.message;
    return;
  }

  currentSession = data.session;
  localStorage.setItem(rememberedLoginEmailKey, email);
  localStorage.removeItem(pendingLoginEmailKey);
  els.loginCode.value = "";
  els.authMessage.textContent = "Signed in.";
  updateAuthUi();

  if (currentSession) await loadSupabaseState();
}

function startLoginCooldown() {
  const cooldownUntil = Date.now() + 60_000;
  localStorage.setItem(loginCooldownKey, String(cooldownUntil));
  updateLoginCooldown();
}

function isLoginCoolingDown() {
  return Number(localStorage.getItem(loginCooldownKey) || 0) > Date.now();
}

function updateLoginCooldown() {
  window.clearTimeout(loginCooldownTimer);

  if (currentSession || !supabaseClient) {
    els.loginForm.querySelector("button").disabled = false;
    return;
  }

  const cooldownUntil = Number(localStorage.getItem(loginCooldownKey) || 0);
  const secondsLeft = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  const button = els.loginForm.querySelector("button");

  if (secondsLeft <= 0) {
    button.disabled = false;
    button.textContent = "Send login link";
    return;
  }

  button.disabled = true;
  button.textContent = `Wait ${secondsLeft}s`;
  loginCooldownTimer = window.setTimeout(updateLoginCooldown, 1000);
}

function renderSettings() {
  const canManage = canManageSettings();

  if (els.settingsPanel) {
    els.settingsPanel.classList.toggle("hidden", !canManage);
  }

  els.currency.value = state.currency;
  if (els.fuelType) els.fuelType.value = state.fuelType || defaults.fuelType;
  if (els.fuelConsumption) els.fuelConsumption.value = state.fuelConsumption || defaults.fuelConsumption;
  if (els.fuelFallbackPrice) els.fuelFallbackPrice.value = state.fuelFallbackPrice || defaults.fuelFallbackPrice;
  if (els.fuelWarningThreshold) els.fuelWarningThreshold.value = state.fuelWarningThreshold || defaults.fuelWarningThreshold;
  els.members.value = state.members
    .map((name) => {
      const profile = getMemberProfile(name);
      return [name, profile.email, profile.role === "admin" ? "admin" : ""]
        .filter(Boolean)
        .join(" | ");
    })
    .join("\n");

  els.currency.disabled = !canManage;
  if (els.fuelType) els.fuelType.disabled = !canManage;
  if (els.fuelConsumption) els.fuelConsumption.disabled = !canManage;
  if (els.fuelFallbackPrice) els.fuelFallbackPrice.disabled = !canManage;
  if (els.fuelWarningThreshold) els.fuelWarningThreshold.disabled = !canManage;
  els.members.disabled = !canManage;
  els.settingsForm.querySelector("button").disabled = !canManage;
}

function getPaidSettlementEntryLock() {
  const ledger = calculateLedger();
  const paidSettlements = ledger.settlements.filter(
    (settlement) => normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]) === "paid"
  );
  return {
    paidSettlements,
    count: paidSettlements.length,
    amount: roundMoney(paidSettlements.reduce((total, settlement) => total + Number(settlement.amount || 0), 0))
  };
}

function isCurrentPeriodLockedForNewEntries() {
  return getPaidSettlementEntryLock().count > 0;
}

function getPeriodEntryLockMessage() {
  const lock = getPaidSettlementEntryLock();
  if (!lock.count) return "";
  const paymentWord = lock.count === 1 ? "payment" : "payments";
  return `This settlement period has ${lock.count} ${paymentWord} marked Paid (${formatMoney(lock.amount)}). Close the period before logging new trips/fuel, or reopen the paid payment if the period needs corrections.`;
}

function assertCurrentPeriodAllowsNewEntries() {
  if (!isCurrentPeriodLockedForNewEntries()) return true;
  alert(getPeriodEntryLockMessage());
  renderPeriodEntryLock();
  return false;
}

function renderPeriodEntryLock() {
  if (!els.periodEntryLock) return;
  const message = getPeriodEntryLockMessage();
  els.periodEntryLock.classList.toggle("hidden", !message);
  els.periodEntryLock.innerHTML = message
    ? `<p class="eyebrow">Period locked</p><h2>Close this period before adding more entries</h2><p class="section-note">${escapeHtml(message)}</p><p class="section-note">To correct an entry, reopen the paid settlement first, then use History → Edit on your current-period log.</p>`
    : "";
}

function renderLogEntryPanelsVisibility() {
  const locked = isCurrentPeriodLockedForNewEntries();
  if (els.tripLogPanel) els.tripLogPanel.classList.toggle("hidden", locked);
  if (els.fuelLogPanel) els.fuelLogPanel.classList.toggle("hidden", locked);
}

function renderPeopleSelectors() {
  const names = getMemberNames();
  const profile = getCurrentMemberProfile();
  const loggedIn = Boolean(currentSession);
  const knownLoggedInMember = Boolean(profile);

  if (loggedIn) {
    currentUser = profile?.name || "";
  } else if (!names.includes(currentUser)) {
    currentUser = names[0] || "";
  }
  if (currentUser) localStorage.setItem(userKey, currentUser);

  const options = names
    .map((member) => `<option value="${escapeHtml(member)}">${escapeHtml(member)}</option>`)
    .join("");
  els.tripDriver.innerHTML = options;
  els.fuelPayer.innerHTML = options;
  els.currentUser.innerHTML = options;

  if (currentUser) {
    els.currentUser.value = currentUser;
    els.tripDriver.value = currentUser;
    els.fuelPayer.value = currentUser;
  }

  const authRequired = Boolean(supabaseClient);
  const canUse = !authRequired || (loggedIn && knownLoggedInMember);
  const periodLocked = isCurrentPeriodLockedForNewEntries();
  const canLogEntries = canUse && !periodLocked;
  const lockToLoggedInUser = authRequired || loggedIn;
  els.currentUser.disabled = lockToLoggedInUser;
  els.tripDriver.disabled = lockToLoggedInUser || periodLocked;
  els.fuelPayer.disabled = lockToLoggedInUser || periodLocked;

  setFormDisabled(els.tripForm, !canLogEntries);
  setFormDisabled(els.fuelForm, !canLogEntries);
  renderPeriodEntryLock();
  renderLogEntryPanelsVisibility();

  renderParticipantOptions();
}

function setFormDisabled(form, disabled) {
  for (const control of form.querySelectorAll("input, select, textarea, button")) {
    control.disabled = disabled;
  }
}

function renderParticipantOptions() {
  const disabledAttr = canUseAppAsMember() ? "" : " disabled";
  els.tripParticipants.innerHTML = state.members
    .map(
      (member) => `
        <label class="participant-option">
          <input type="checkbox" value="${escapeHtml(member)}" data-participant="${escapeHtml(member)}" checked${disabledAttr} />
          <span>${escapeHtml(member)}</span>
        </label>
      `
    )
    .join("");
}

function renderTripEstimatorParticipants() {
  if (!els.tripEstimatorParticipants) return;

  const existing = new Set(
    Array.from(els.tripEstimatorParticipants.querySelectorAll("input:checked")).map((input) => input.value)
  );
  const profile = getCurrentMemberProfile();
  const defaultSelection = existing.size ? existing : new Set(profile?.name ? [profile.name] : getMemberNames());

  els.tripEstimatorParticipants.innerHTML = getMemberNames()
    .map((member) => `
      <label class="participant-option">
        <input type="checkbox" value="${escapeHtml(member)}" ${defaultSelection.has(member) ? "checked" : ""} />
        <span>${escapeHtml(member)}</span>
      </label>
    `)
    .join("");
}

function getTripEstimatorParticipants() {
  if (!els.tripEstimatorParticipants) return [];
  return Array.from(els.tripEstimatorParticipants.querySelectorAll("input:checked")).map((input) => input.value);
}

function renderTripEstimate() {
  if (!els.tripEstimateResult || !els.tripEstimateDistance) return;

  if (supabaseClient && !currentSession) {
    els.tripEstimateResult.className = "trip-estimate-result empty-state";
    els.tripEstimateResult.textContent = "Sign in to estimate trip costs.";
    return;
  }

  const distance = Number(els.tripEstimateDistance.value || 0);
  const participants = getTripEstimatorParticipants();

  if (distance <= 0) {
    els.tripEstimateResult.className = "trip-estimate-result empty-state";
    els.tripEstimateResult.textContent = "Enter a distance to estimate the fuel cost.";
    return;
  }

  if (participants.length === 0) {
    els.tripEstimateResult.className = "trip-estimate-result empty-state";
    els.tripEstimateResult.textContent = "Choose at least one person joining the trip.";
    return;
  }

  const estimate = calculateTripCostEstimate(distance, participants.length);
  els.tripEstimateResult.className = "trip-estimate-result";
  els.tripEstimateResult.innerHTML = `
    <div class="trip-estimate-cards">
      <article>
        <span>Estimated fuel cost</span>
        <strong>${formatMoney(estimate.totalCost)}</strong>
      </article>
      <article>
        <span>Per person</span>
        <strong>${formatMoney(estimate.perPerson)}</strong>
      </article>
      <article>
        <span>People</span>
        <strong>${participants.length}</strong>
      </article>
    </div>
    <p>${escapeHtml(estimate.explanation)}</p>
    <small>${escapeHtml(participants.join(", "))}</small>
  `;
}


function buildFuelIntelligence(ledger) {
  const stats = ledger.historicalFuelStats || calculateHistoricalFuelStats({ currentTrips: state.trips, currentFuel: state.fuel });
  const tripCount = state.trips.length + state.closedPeriods.reduce((sum, period) => sum + (Array.isArray(period.trips) ? period.trips.length : 0), 0);
  const fuelLogCount = state.fuel.length + state.closedPeriods.reduce((sum, period) => sum + (Array.isArray(period.fuel) ? period.fuel.length : 0), 0);
  const logsWithLiters = Number(stats.fuelLogsWithLiters || 0);
  const km = Number(stats.totalTripKm || 0);
  const fallbackConsumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const fallbackPrice = Math.max(0.1, Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  const livePrice = latestFuelPrice && Number(latestFuelPrice.price) > 0 ? Number(latestFuelPrice.price) : 0;
  const hasHistoricalCost = stats.costPerKm > 0 && km >= 50;
  const hasHistoricalConsumption = stats.litersPer100Km > 0 && logsWithLiters > 0;
  const consumptionLooksRealistic = !hasHistoricalConsumption || (stats.litersPer100Km >= 3 && stats.litersPer100Km <= 10);
  const canUseHistoricalForPlanning = hasHistoricalCost && consumptionLooksRealistic;
  const confidenceScore = [km >= 500, km >= 1500, logsWithLiters >= 3, logsWithLiters >= 8, Number(stats.periodsWithTripKm || 0) >= 2, consumptionLooksRealistic].filter(Boolean).length;
  const confidence = confidenceScore >= 5 ? "High" : confidenceScore >= 3 ? "Medium" : "Low";
  const confidenceClass = canUseHistoricalForPlanning && confidence === "High" ? "ok" : confidence === "Low" ? "issue" : "warning";
  const estimateSource = canUseHistoricalForPlanning
    ? "Historical fuel cost per km"
    : livePrice
      ? "Car setting + live diesel reference price"
      : "Car setting + fallback fuel price";
  const effectiveConsumption = canUseHistoricalForPlanning && stats.litersPer100Km > 0 ? stats.litersPer100Km : fallbackConsumption;
  const effectivePrice = stats.pricePerLiter > 0 ? stats.pricePerLiter : Number(livePrice || fallbackPrice);
  const planningCostPerKm = canUseHistoricalForPlanning
    ? stats.costPerKm
    : (effectiveConsumption / 100) * effectivePrice;
  const warnings = [];
  if (tripCount === 0) warnings.push("Add trips to learn cost per km.");
  if (fuelLogCount === 0) warnings.push("Add fuel receipts to learn real fuel cost.");
  if (fuelLogCount > 0 && logsWithLiters === 0) warnings.push("Add liters on fuel receipts to learn DKK/L and L/100 km.");
  if (hasHistoricalConsumption && !consumptionLooksRealistic) {
    warnings.push(`Historical consumption looks unusual: ${formatNumber(stats.litersPer100Km)} L/100 km, so Plan trip uses the car setting (${formatNumber(fallbackConsumption)} L/100 km) instead.`);
  }
  return {
    stats,
    tripCount,
    fuelLogCount,
    logsWithLiters,
    confidence,
    confidenceClass,
    estimateSource,
    effectiveConsumption,
    effectivePrice,
    planningCostPerKm,
    canUseHistoricalForPlanning,
    consumptionLooksRealistic,
    warnings
  };
}

function renderFuelIntelligence(ledger) {
  if (!els.fuelIntelligence) return;
  const intel = buildFuelIntelligence(ledger);
  const stats = intel.stats;
  const hasData = intel.tripCount > 0 || intel.fuelLogCount > 0;

  if (!hasData) {
    els.fuelIntelligence.className = "fuel-intelligence empty-state";
    els.fuelIntelligence.textContent = "Add trips and fuel receipts to build fuel intelligence.";
    return;
  }

  els.fuelIntelligence.className = "fuel-intelligence";
  els.fuelIntelligence.innerHTML = `
    <div class="fuel-intelligence-grid">
      <article>
        <span>Confidence</span>
        <strong><span class="status-pill status-${intel.confidenceClass === "ok" ? "ok" : "warning"}">${intel.confidence}</span></strong>
        <small>Based on ${formatNumber(stats.totalTripKm || 0)} km and ${intel.logsWithLiters} fuel log${intel.logsWithLiters === 1 ? "" : "s"} with liters.</small>
      </article>
      <article>
        <span>Planning source</span>
        <strong>${escapeHtml(intel.estimateSource)}</strong>
        <small>${intel.canUseHistoricalForPlanning ? "The trip estimator trusts the historical average." : "The trip estimator is avoiding unusual historical data."}</small>
      </article>
      <article>
        <span>Planning cost</span>
        <strong>${intel.planningCostPerKm > 0 ? `${formatMoneyFor(intel.planningCostPerKm, state.currency)}/km` : "Not enough data"}</strong>
        <small>${intel.canUseHistoricalForPlanning ? `${formatMoneyFor(stats.totalPaid, state.currency)} historical fuel across ${formatNumber(stats.totalTripKm)} km.` : `${formatNumber(intel.effectiveConsumption)} L/100 km × ${formatMoneyFor(intel.effectivePrice, state.currency)}/L.`}</small>
      </article>
      <article>
        <span>Fuel price</span>
        <strong>${stats.pricePerLiter > 0 ? `${formatMoneyFor(stats.pricePerLiter, state.currency)}/L` : `${formatMoneyFor(intel.effectivePrice, state.currency)}/L`}</strong>
        <small>${stats.pricePerLiter > 0 ? "Receipt average." : latestFuelPrice?.price ? "Live reference price." : "Fallback setting."}</small>
      </article>
      <article>
        <span>Consumption</span>
        <strong>${stats.litersPer100Km > 0 ? `${formatNumber(stats.litersPer100Km)} L/100 km` : `${formatNumber(intel.effectiveConsumption)} L/100 km`}</strong>
        <small>${stats.kmPerLiter > 0 ? `${formatNumber(stats.kmPerLiter)} km/L from receipts.` : "Using car setting until enough liters are logged."}</small>
      </article>
      <article>
        <span>Data set</span>
        <strong>${intel.tripCount} trips · ${intel.fuelLogCount} fuel logs</strong>
        <small>${Number(stats.periodsWithTripKm || 0)} period${Number(stats.periodsWithTripKm || 0) === 1 ? "" : "s"} with distance.</small>
      </article>
    </div>
    ${intel.warnings.length ? `<div class="fuel-intelligence-notes"><strong>Data notes</strong><ul>${intel.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
  `;
}

function calculateTripCostEstimate(distanceKm, participantCount) {
  const intel = buildFuelIntelligence(calculateLedger());
  const historical = intel.stats;
  const fallbackConsumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const fallbackPrice = Math.max(0.1, Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  const livePrice = latestFuelPrice && latestFuelPrice.price > 0 ? Number(latestFuelPrice.price) : 0;
  const pricePerLiter = historical.pricePerLiter > 0 ? historical.pricePerLiter : livePrice || fallbackPrice;

  let totalCost = 0;
  let explanation = "";

  if (intel.canUseHistoricalForPlanning) {
    totalCost = distanceKm * historical.costPerKm;
    explanation = `${formatNumber(distanceKm)} km × trusted historical ${formatMoneyFor(historical.costPerKm, state.currency)}/km, based on ${formatNumber(historical.totalTripKm)} logged km.`;
  } else {
    const consumption = fallbackConsumption;
    totalCost = (distanceKm * consumption / 100) * pricePerLiter;
    const priceSource = historical.pricePerLiter > 0 ? "historical receipt average" : livePrice ? "live diesel reference price" : "fallback fuel price";
    const reason = historical.litersPer100Km > 0 && !intel.consumptionLooksRealistic
      ? ` Historical consumption (${formatNumber(historical.litersPer100Km)} L/100 km) looks unusual, so it is ignored for planning.`
      : "";
    explanation = `${formatNumber(distanceKm)} km × ${formatNumber(consumption)} L/100 km (car setting) × ${formatMoneyFor(pricePerLiter, state.currency)}/L (${priceSource}).${reason}`;
  }

  return {
    totalCost: roundMoney(totalCost),
    perPerson: roundMoney(totalCost / participantCount),
    explanation
  };
}

function monthKeyFromDate(value) {
  if (!value) return "Unknown";
  const raw = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}/.test(raw)) return "Unknown";
  return raw.slice(0, 7);
}

function monthLabelFromKey(key) {
  if (!key || key === "Unknown") return "Unknown month";
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return key;
  return new Date(year, month - 1, 1).toLocaleDateString("da-DK", { month: "long", year: "numeric" });
}

function getMonthlySummaryPeriods() {
  return [
    { id: (state.currentPeriodId || "current"), label: "Current period", status: "open", trips: state.trips, fuel: state.fuel },
    ...state.closedPeriods.map((period) => ({
      id: period.id,
      label: period.label || "Closed period",
      status: "closed",
      trips: Array.isArray(period.trips) ? period.trips : [],
      fuel: Array.isArray(period.fuel) ? period.fuel : []
    }))
  ];
}

function ensureMonthlyPersonRow(month, personName) {
  if (!month.people[personName]) {
    month.people[personName] = {
      name: personName,
      drivenTrips: 0,
      joinedTrips: 0,
      distanceShare: 0,
      drivenKm: 0,
      fuelLogs: 0,
      fuelPaid: 0,
      liters: 0,
      fuelShare: 0,
      net: 0
    };
  }
  return month.people[personName];
}

function buildMonthlyMemberSummaries() {
  const months = new Map();

  const ensureMonth = (key) => {
    if (!months.has(key)) {
      months.set(key, {
        key,
        label: monthLabelFromKey(key),
        tripCount: 0,
        fuelLogCount: 0,
        totalTripKm: 0,
        totalParticipantKm: 0,
        totalFuelPaid: 0,
        totalLiters: 0,
        people: {}
      });
    }
    return months.get(key);
  };

  for (const period of getMonthlySummaryPeriods()) {
    for (const trip of Array.isArray(period.trips) ? period.trips : []) {
      const key = monthKeyFromDate(trip.date || trip.trip_date);
      const month = ensureMonth(key);
      const start = Number(trip.startKm ?? trip.start_km ?? 0);
      const end = Number(trip.endKm ?? trip.end_km ?? 0);
      const km = Math.max(0, end - start);
      if (km <= 0) continue;

      const participants = getTripParticipants({ ...trip, driver: trip.driver || trip.driverName || trip.driver_name }).filter(Boolean);
      const uniqueParticipants = Array.from(new Set(participants));
      const share = uniqueParticipants.length ? km / uniqueParticipants.length : km;
      const driver = trip.driver || trip.driverName || trip.driver_name;

      month.tripCount += 1;
      month.totalTripKm += km;
      month.totalParticipantKm += share * Math.max(1, uniqueParticipants.length || 1);

      if (driver) {
        const row = ensureMonthlyPersonRow(month, driver);
        row.drivenTrips += 1;
        row.drivenKm += km;
      }

      uniqueParticipants.forEach((name) => {
        const row = ensureMonthlyPersonRow(month, name);
        row.joinedTrips += 1;
        row.distanceShare += share;
      });
    }

    for (const fuel of Array.isArray(period.fuel) ? period.fuel : []) {
      const key = monthKeyFromDate(fuel.date || fuel.payment_date);
      const month = ensureMonth(key);
      const payer = fuel.payer || fuel.payerName || fuel.payer_name;
      const amount = Number(fuel.amount || 0);
      const liters = Number(fuel.liters || 0);
      if (!payer || amount <= 0) continue;

      month.fuelLogCount += 1;
      month.totalFuelPaid += amount;
      month.totalLiters += Math.max(0, liters);

      const row = ensureMonthlyPersonRow(month, payer);
      row.fuelLogs += 1;
      row.fuelPaid += amount;
      row.liters += Math.max(0, liters);
    }
  }

  for (const month of months.values()) {
    const rate = month.totalParticipantKm > 0 ? month.totalFuelPaid / month.totalParticipantKm : 0;
    Object.values(month.people).forEach((person) => {
      person.distanceShare = round(person.distanceShare);
      person.drivenKm = round(person.drivenKm);
      person.fuelShare = roundMoney(person.distanceShare * rate);
      person.net = roundMoney(person.fuelPaid - person.fuelShare);
    });
    month.totalTripKm = round(month.totalTripKm);
    month.totalParticipantKm = round(month.totalParticipantKm);
    month.totalFuelPaid = roundMoney(month.totalFuelPaid);
    month.totalLiters = round(month.totalLiters);
    month.fuelRate = month.totalParticipantKm > 0 ? roundMoney(month.totalFuelPaid / month.totalParticipantKm) : 0;
  }

  return Array.from(months.values()).sort((a, b) => String(b.key).localeCompare(String(a.key)));
}

function getAnomalyEditTarget(type, entry) {
  if (!entry?.id) return null;
  if (type === "fuel" && canManageFuelEntry(entry)) return `fuel:${entry.id}`;
  if (type === "trips" && canManageTripEntry(entry)) return `trips:${entry.id}`;
  return null;
}

function getAnomalyOwnerText(type, entry) {
  if (type === "fuel") return `${entry?.payer || "the fuel payer"} can edit this fuel log from History.`;
  return `${entry?.driver || "the driver"} can edit this trip from History.`;
}

function createEntryAnomaly({ severity = "warning", text, type, entry }) {
  return {
    severity,
    text,
    target: getAnomalyEditTarget(type, entry),
    ownerText: getAnomalyOwnerText(type, entry),
    entryLevel: true
  };
}

function getCurrentPeriodFuelAnomalies(ledger) {
  const anomalies = [];
  const fallbackPrice = Math.max(0.1, Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  const referencePrice = latestFuelPrice && Number(latestFuelPrice.price) > 0 ? Number(latestFuelPrice.price) : fallbackPrice;

  for (const fuel of state.fuel) {
    const amount = Number(fuel.amount || 0);
    const liters = Number(fuel.liters || 0);
    const label = `${fuel.payer || "Unknown"}${fuel.date ? ` · ${formatDate(fuel.date)}` : ""}`;

    if (amount >= 500 && !(liters > 0)) {
      anomalies.push(createEntryAnomaly({
        severity: "warning",
        text: `${label}: ${formatMoney(amount)} is missing liters, so DKK/L and consumption cannot be verified.`,
        type: "fuel",
        entry: fuel
      }));
      continue;
    }

    if (amount > 0 && liters > 0) {
      const pricePerLiter = amount / liters;
      if (pricePerLiter < 8 || pricePerLiter > 25) {
        anomalies.push(createEntryAnomaly({
          severity: "issue",
          text: `${label}: ${formatMoneyFor(pricePerLiter, state.currency)}/L looks outside the normal fuel price range.`,
          type: "fuel",
          entry: fuel
        }));
      } else if (referencePrice > 0) {
        const difference = Math.abs(pricePerLiter - referencePrice) / referencePrice;
        if (difference >= 0.25) {
          anomalies.push(createEntryAnomaly({
            severity: "warning",
            text: `${label}: ${formatMoneyFor(pricePerLiter, state.currency)}/L differs a lot from the current/reference price (${formatMoneyFor(referencePrice, state.currency)}/L).`,
            type: "fuel",
            entry: fuel
          }));
        }
      }
    }
  }

  for (const trip of state.trips) {
    const km = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
    const label = `${trip.driver || "Unknown"}${trip.date ? ` · ${formatDate(trip.date)}` : ""}`;
    if (km > 1000) {
      anomalies.push(createEntryAnomaly({
        severity: "warning",
        text: `${label}: ${formatNumber(km)} km is unusually long for one trip; check start/end odometer.`,
        type: "trips",
        entry: trip
      }));
    }
  }

  if (ledger.totalTripKm > 0 && ledger.totalFuelLiters > 0) {
    const periodConsumption = ledger.totalFuelLiters / ledger.totalTripKm * 100;
    if (periodConsumption < 3 || periodConsumption > 9) {
      const entryAnomalyCount = anomalies.filter((item) => item.entryLevel).length;
      anomalies.push({
        severity: "issue",
        text: `Current period consumption is ${formatNumber(periodConsumption)} L/100 km. That is unusual for this car; check fuel logs, trip distance, or whether fuel belongs to this period.`,
        ownerText: entryAnomalyCount
          ? "Review the linked fuel/trip anomalies above, or use History to edit your own current-period entries."
          : "No single bad entry was identified. This warning comes from the period total; review recent fuel logs and trip distance in History."
      });
    }
  }

  return anomalies;
}

function isCriticalFuelValidationWarning(warning) {
  const text = String(warning || "").toLowerCase();
  return text.includes("unusually high")
    || text.includes("unusual price")
    || text.includes("unusual for this car")
    || text.includes("duplicate fuel")
    || text.includes("wrong amounts")
    || text.includes("wrong amount");
}

function getCurrentPeriodHealthPrediction(ledger) {
  const estimate = ledger.fuelEstimate || calculateFuelEstimate(ledger);
  const validationWarnings = getFuelValidationWarnings(ledger);
  const criticalValidationWarnings = validationWarnings.filter(isCriticalFuelValidationWarning);
  const fuelAnomalies = getCurrentPeriodFuelAnomalies(ledger);
  const openPayments = ledger.settlements.filter((settlement) => {
    const status = normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]);
    return status === "open";
  }).length;
  const paidPayments = ledger.settlements.filter((settlement) => normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]) === "paid").length;

  let status = "Looks normal";
  let tone = "ok";
  const reasons = [];
  const actions = [];

  if (!ledger.totalTripKm && !ledger.totalPaid) {
    return {
      status: "Waiting for data",
      tone: "warning",
      reasons: ["Add trips and fuel logs to get a useful current-period prediction."],
      actions: ["Log real trips and receipts before using predictions."],
      estimate,
      validationWarnings,
      fuelAnomalies,
      openPayments,
      paidPayments
    };
  }

  if (criticalValidationWarnings.length || fuelAnomalies.some((item) => item.severity === "issue")) {
    status = "Check before settling";
    tone = "issue";
  } else if (validationWarnings.length || fuelAnomalies.length || openPayments > 0) {
    status = "Caution";
    tone = "warning";
  }

  if (estimate.hasEstimate) {
    if (estimate.coveragePercent > 135) {
      reasons.push(`Fuel logged is ${formatNumber(estimate.coveragePercent)}% of the expected amount for this period.`);
      actions.push("Check for duplicate fuel logs, wrong amounts/liters, or missing trip distance.");
    } else if (estimate.coveragePercent < 70) {
      reasons.push(`Fuel logged is only ${formatNumber(estimate.coveragePercent)}% of expected.`);
      actions.push("Add missing fuel receipts before requesting payments.");
    } else {
      reasons.push(`Fuel coverage is ${formatNumber(estimate.coveragePercent)}% of expected.`);
    }
  }

  if (fuelAnomalies.length) {
    const entryLinked = fuelAnomalies.filter((item) => item.entryLevel).length;
    reasons.push(`${fuelAnomalies.length} anomaly ${fuelAnomalies.length === 1 ? "was" : "were"} detected${entryLinked ? `, including ${entryLinked} linked entr${entryLinked === 1 ? "y" : "ies"}` : " at period level"}.`);
  }
  if (openPayments > 0) {
    reasons.push(`${openPayments} final payment${openPayments === 1 ? " is" : "s are"} still open.`);
  }
  if (paidPayments > 0) {
    reasons.push(`${paidPayments} payment${paidPayments === 1 ? " is" : "s are"} marked paid, so the period is locked for new entries.`);
  }

  if (paidPayments > 0 && (fuelAnomalies.length || validationWarnings.length)) {
    actions.push("This period is locked because a payment is marked Paid. Reopen the paid payment before correcting trips or fuel logs.");
    actions.push("Review the outlier links below, or use History to edit your own current-period entries.");
    actions.push("After corrections, request/mark paid again, then close the period as admin.");
  } else {
    if (fuelAnomalies.length || criticalValidationWarnings.length) {
      actions.push("Review the outlier links below, or use History to edit your own current-period entries before settling.");
    }
    if (openPayments > 0) {
      actions.push("Request open final payments before closing the period.");
    }
    if (paidPayments > 0) {
      actions.push("Close the period before logging more trips/fuel, or reopen the paid payment to correct this period.");
    }
  }

  if (!actions.length) {
    actions.push(tone === "ok" ? "No obvious data issue. Continue with the normal settlement flow." : "Review the warnings before requesting payments.");
  }

  return { status, tone, reasons, actions, estimate, validationWarnings, fuelAnomalies, openPayments, paidPayments };
}

function getLatestMonthlySignal() {
  const months = buildMonthlyMemberSummaries().filter((month) => month.tripCount || month.fuelLogCount);
  if (!months.length) return null;
  const latest = months[0];
  const people = Object.values(latest.people || {})
    .filter((person) => person.joinedTrips || person.drivenTrips || person.fuelLogs || person.fuelPaid)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  if (!people.length) return { month: latest, text: "No active members in the latest month yet." };
  const biggest = people[0];
  const direction = biggest.net >= 0 ? "paid more than their estimated share" : "used more fuel than they paid for";
  return {
    month: latest,
    text: `${biggest.name} has the largest monthly net in ${latest.label}: ${formatMoneyFor(biggest.net, state.currency)} (${direction}).`
  };
}

function buildSmartPredictions(ledger) {
  const intel = buildFuelIntelligence(ledger);
  const health = getCurrentPeriodHealthPrediction(ledger);
  const distance = els.tripEstimateDistance ? Number(els.tripEstimateDistance.value || 0) : 0;
  const participants = Math.max(1, getTripEstimatorParticipants().length || 1);
  const planDistance = distance > 0 ? distance : 100;
  const planEstimate = calculateTripCostEstimate(planDistance, participants);
  const monthlySignal = intel.consumptionLooksRealistic ? getLatestMonthlySignal() : null;
  const historicalQuality = intel.consumptionLooksRealistic && intel.confidence !== "Low" ? "Good" : intel.confidence === "Low" ? "Limited" : "Needs cleanup";
  const planningConfidence = intel.canUseHistoricalForPlanning ? intel.confidence : latestFuelPrice?.price || intel.effectivePrice ? "Medium" : "Low";
  const planningNote = distance > 0 ? "Using your Plan trip distance." : "Using a 100 km reference because no planned trip distance is entered.";
  return { intel, health, planDistance, participants, planEstimate, monthlySignal, historicalQuality, planningConfidence, planningNote };
}

function renderSmartPredictions(ledger) {
  if (!els.smartPredictions) return;
  const prediction = buildSmartPredictions(ledger);
  const hasData = state.trips.length || state.fuel.length || state.closedPeriods.length;

  if (!hasData) {
    els.smartPredictions.className = "smart-predictions empty-state";
    els.smartPredictions.textContent = "Add trips and fuel receipts to get smart predictions.";
    return;
  }

  const health = prediction.health;
  const toneClass = health.tone === "ok" ? "ok" : health.tone === "issue" ? "issue" : "warning";
  const entryAnomalyCount = health.fuelAnomalies.filter((item) => item.entryLevel).length;
  const editableAnomalyCount = health.fuelAnomalies.filter((item) => item.target).length;
  const anomalyItems = health.fuelAnomalies.slice(0, 6).map((item) => {
    const action = item.target
      ? ` <button class="subtle-button compact-button" type="button" data-edit="${escapeHtml(item.target)}">Edit</button>`
      : "";
    const owner = item.target ? "" : item.ownerText ? ` <small>${escapeHtml(item.ownerText)}</small>` : "";
    return `<li>${escapeHtml(item.text)}${action}${owner}</li>`;
  }).join("");
  const hiddenAnomalyCount = Math.max(0, health.fuelAnomalies.length - 6);
  const hasPeriodLevelWarning = health.fuelAnomalies.some((item) => !item.entryLevel);
  const outlierHelp = health.fuelAnomalies.length
    ? editableAnomalyCount
      ? "Use Edit on linked items before settlement."
      : entryAnomalyCount
        ? "Use History to ask the owner to edit linked entries."
        : "Period-level warning; no single bad entry found."
    : "No current-period outlier found.";
  const historicalTone = prediction.historicalQuality === "Good" ? "ok" : "warning";
  const planningTone = prediction.planningConfidence === "High" ? "ok" : prediction.planningConfidence === "Low" ? "issue" : "warning";

  els.smartPredictions.className = "smart-predictions";
  els.smartPredictions.innerHTML = `
    <div class="smart-prediction-grid">
      <article class="smart-card smart-card-${toneClass}">
        <span>Current period health</span>
        <strong>${escapeHtml(health.status)}</strong>
        <small>${health.reasons.length ? escapeHtml(health.reasons[0]) : "No unusual signal found."}</small>
      </article>
      <article>
        <span>Planning estimate</span>
        <strong>${formatMoneyFor(prediction.planEstimate.totalCost, state.currency)}</strong>
        <small>${formatNumber(prediction.planDistance)} km · ${prediction.participants} person${prediction.participants === 1 ? "" : "s"} · ${formatMoneyFor(prediction.planEstimate.perPerson, state.currency)} each.</small>
      </article>
      <article>
        <span>Planning source</span>
        <strong>${escapeHtml(prediction.intel.estimateSource)}</strong>
        <small>${escapeHtml(prediction.planningNote)}</small>
      </article>
      <article>
        <span>Planning confidence</span>
        <strong><span class="status-pill status-${planningTone}">${prediction.planningConfidence}</span></strong>
        <small>${prediction.intel.canUseHistoricalForPlanning ? "Uses clean historical cost/km." : "Uses car setting because historical data is not trusted for planning."}</small>
      </article>
      <article>
        <span>Historical data quality</span>
        <strong><span class="status-pill status-${historicalTone}">${prediction.historicalQuality}</span></strong>
        <small>${prediction.intel.consumptionLooksRealistic ? "Historical consumption looks plausible." : "Historical consumption looks unusual and is ignored for planning."}</small>
      </article>
      <article>
        <span>Outliers to review</span>
        <strong>${health.fuelAnomalies.length}</strong>
        <small>${escapeHtml(outlierHelp)}</small>
      </article>
    </div>
    <div class="smart-prediction-details">
      <article>
        <h3>Suggested action</h3>
        <ul>${health.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>
      </article>
      <article>
        <h3>Why this estimate?</h3>
        <p>${escapeHtml(prediction.planEstimate.explanation)}</p>
        ${!prediction.intel.consumptionLooksRealistic ? `<p>After the production reset and a few real fuel logs, the historical model will become more useful.</p>` : ""}
        ${prediction.monthlySignal ? `<p>${escapeHtml(prediction.monthlySignal.text)}</p>` : ""}
      </article>
      ${health.fuelAnomalies.length ? `<article><h3>Outliers and next steps</h3><ul>${anomalyItems}${hiddenAnomalyCount ? `<li>${hiddenAnomalyCount} more not shown here. Use History to review all current-period entries.</li>` : ""}</ul>${hasPeriodLevelWarning ? `<button class="subtle-button compact-button" type="button" data-review-period="true">Review period data</button><p class="entry-meta">Opens History and expands current-period trips/fuel so you can inspect totals and edit entries you own.</p>` : ""}</article>` : ""}
    </div>
  `;
}


function renderMonthlyMemberSummaries() {
  if (!els.monthlyMemberSummaries) return;
  const months = buildMonthlyMemberSummaries().filter((month) => month.tripCount || month.fuelLogCount);

  if (!months.length) {
    els.monthlyMemberSummaries.className = "monthly-summary empty-state";
    els.monthlyMemberSummaries.textContent = "Add trips and fuel receipts to build monthly member summaries.";
    return;
  }

  els.monthlyMemberSummaries.className = "monthly-summary";
  els.monthlyMemberSummaries.innerHTML = months.slice(0, 12).map((month, index) => renderMonthlySummaryCard(month, index === 0)).join("");
}

function renderMonthlySummaryCard(month, open) {
  const people = Object.values(month.people)
    .filter((person) => person.joinedTrips || person.drivenTrips || person.fuelLogs || person.fuelPaid)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.name.localeCompare(b.name));

  return `
    <details class="monthly-summary-card" ${open ? "open" : ""}>
      <summary>
        <div>
          <strong>${escapeHtml(month.label)}</strong>
          <p>${month.tripCount} trip${month.tripCount === 1 ? "" : "s"} · ${month.fuelLogCount} fuel log${month.fuelLogCount === 1 ? "" : "s"} · ${formatNumber(month.totalTripKm)} km</p>
        </div>
        <span>${formatMoneyFor(month.totalFuelPaid, state.currency)}</span>
      </summary>
      <div class="period-stats monthly-stats">
        <div><span>Trip km</span><b>${formatNumber(month.totalTripKm)} km</b></div>
        <div><span>Distance share</span><b>${formatNumber(month.totalParticipantKm)} km</b></div>
        <div><span>Fuel paid</span><b>${formatMoneyFor(month.totalFuelPaid, state.currency)}</b></div>
        <div><span>Fuel rate</span><b>${month.fuelRate > 0 ? `${formatMoneyFor(month.fuelRate, state.currency)}/km` : "-"}</b></div>
        <div><span>Liters</span><b>${month.totalLiters > 0 ? `${formatNumber(month.totalLiters)} L` : "-"}</b></div>
        <div><span>People active</span><b>${people.length}</b></div>
      </div>
      ${people.length ? `
        <div class="responsive-table-wrap">
          <table class="monthly-member-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Driven</th>
                <th>Joined</th>
                <th>Distance share</th>
                <th>Fuel paid</th>
                <th>Fuel share</th>
                <th>Monthly net</th>
              </tr>
            </thead>
            <tbody>
              ${people.map((person) => `
                <tr>
                  <td>${escapeHtml(person.name)}</td>
                  <td>${person.drivenTrips} · ${formatNumber(person.drivenKm)} km</td>
                  <td>${person.joinedTrips}</td>
                  <td>${formatNumber(person.distanceShare)} km</td>
                  <td>${formatMoneyFor(person.fuelPaid, state.currency)}${person.fuelLogs ? `<br><small>${person.fuelLogs} log${person.fuelLogs === 1 ? "" : "s"}</small>` : ""}</td>
                  <td>${formatMoneyFor(person.fuelShare, state.currency)}</td>
                  <td><strong class="${person.net >= 0 ? "positive-net" : "negative-net"}">${person.net >= 0 ? "+" : ""}${formatMoneyFor(person.net, state.currency)}</strong></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        <p class="entry-meta">Monthly net = fuel paid minus estimated fuel share for that month. Positive means the person paid more fuel than their share; negative means they used more fuel than they paid for.</p>
      ` : `<p class="entry-meta">No member activity for this month.</p>`}
    </details>
  `;
}

function calculateLedger() {
  const people = Object.fromEntries(
    state.members.map((member) => [
      member,
      {
        km: 0,
        tripCost: 0,
        fuelPaid: 0,
        net: 0
      }
    ])
  );

  for (const trip of state.trips) {
    const km = trip.endKm - trip.startKm;
    const participants = getTripParticipants(trip).filter((member) => people[member]);
    const shareKm = participants.length > 0 ? km / participants.length : km;

    for (const participant of participants.length > 0 ? participants : [trip.driver]) {
      if (people[participant]) people[participant].km += shareKm;
    }
  }

  for (const fuel of state.fuel) {
    people[fuel.payer].fuelPaid += fuel.amount;
  }

  const totalTripKm = round(
    state.trips.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm) - Number(trip.startKm)), 0)
  );
  const fuelByPerson = Object.fromEntries(state.members.map((member) => [member, 0]));
  const fuelLitersByPerson = Object.fromEntries(state.members.map((member) => [member, 0]));
  for (const fuel of state.fuel) {
    if (fuelByPerson[fuel.payer] !== undefined) {
      fuelByPerson[fuel.payer] = roundMoney(fuelByPerson[fuel.payer] + Number(fuel.amount || 0));
      fuelLitersByPerson[fuel.payer] = round(fuelLitersByPerson[fuel.payer] + Number(fuel.liters || 0));
    }
  }
  const totalFuelLiters = round(Object.values(fuelLitersByPerson).reduce((sum, liters) => sum + Number(liters || 0), 0));
  const receiptPricePerLiter = totalFuelLiters > 0 ? roundMoney(state.fuel.reduce((sum, fuel) => sum + Number(fuel.amount || 0), 0) / totalFuelLiters) : 0;
  const receiptConsumption = totalFuelLiters > 0 && totalTripKm > 0 ? round(totalFuelLiters / totalTripKm * 100) : 0;
  const receiptKmPerLiter = totalFuelLiters > 0 && totalTripKm > 0 ? round(totalTripKm / totalFuelLiters) : 0;

  let totalKm = 0;
  let totalPaid = 0;

  for (const person of Object.values(people)) {
    person.km = round(person.km);
    person.fuelPaid = roundMoney(person.fuelPaid);
    totalKm += person.km;
    totalPaid += person.fuelPaid;
  }

  const fuelRate = totalKm > 0 ? totalPaid / totalKm : 0;
  let totalCost = 0;

  for (const person of Object.values(people)) {
    person.tripCost = roundMoney(person.km * fuelRate);
    person.net = roundMoney(person.fuelPaid - person.tripCost);
    totalCost += person.tripCost;
  }

  const fuelEstimate = calculateFuelEstimate({ totalTripKm: round(totalTripKm), totalPaid: roundMoney(totalPaid) });
  const historicalFuelStats = calculateHistoricalFuelStats({
    currentTrips: state.trips,
    currentFuel: state.fuel
  });

  return {
    people,
    totalTripKm,
    totalShareKm: round(totalKm),
    totalKm: round(totalKm),
    fuelByPerson,
    fuelLitersByPerson,
    totalFuelLiters,
    receiptPricePerLiter,
    receiptConsumption,
    receiptKmPerLiter,
    historicalFuelStats,
    fuelPayments: [...state.fuel].sort(byNewest),
    fuelEstimate,
    fuelRate,
    totalCost: roundMoney(totalCost),
    totalPaid: roundMoney(totalPaid),
    period: getLedgerPeriod(),
    settlements: buildSettlements(people)
  };
}

function calculateHistoricalFuelStats({ currentTrips = [], currentFuel = [] } = {}) {
  const periods = [
    { trips: currentTrips, fuel: currentFuel },
    ...state.closedPeriods.map((period) => ({
      trips: Array.isArray(period.trips) ? period.trips : [],
      fuel: Array.isArray(period.fuel) ? period.fuel : [],
      totalTripKm: Number(period.totalTripKm || 0),
      totalPaid: Number(period.totalPaid || 0)
    }))
  ];

  let totalTripKm = 0;
  let totalPaid = 0;
  let totalLiters = 0;
  let totalAmountWithLiters = 0;
  let fuelLogsWithLiters = 0;
  let periodsWithTripKm = 0;
  let periodsWithLiters = 0;

  for (const period of periods) {
    const trips = Array.isArray(period.trips) ? period.trips : [];
    const fuel = Array.isArray(period.fuel) ? period.fuel : [];
    const periodTripKm = Number(period.totalTripKm || trips.reduce((sum, trip) => {
      return sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
    }, 0));
    const periodPaid = Number(period.totalPaid || fuel.reduce((sum, item) => sum + Number(item.amount || 0), 0));
    const periodLiters = fuel.reduce((sum, item) => sum + Number(item.liters || 0), 0);

    if (periodTripKm > 0) {
      totalTripKm += periodTripKm;
      totalPaid += periodPaid;
      periodsWithTripKm += 1;
    }

    if (periodTripKm > 0 && periodLiters > 0) {
      totalLiters += periodLiters;
      periodsWithLiters += 1;
    }

    for (const item of fuel) {
      const liters = Number(item.liters || 0);
      const amount = Number(item.amount || 0);
      if (liters > 0 && amount > 0) {
        totalAmountWithLiters += amount;
        fuelLogsWithLiters += 1;
      }
    }
  }

  return {
    totalTripKm: round(totalTripKm),
    totalPaid: roundMoney(totalPaid),
    totalLiters: round(totalLiters),
    costPerKm: totalTripKm > 0 ? roundMoney(totalPaid / totalTripKm) : 0,
    pricePerLiter: totalLiters > 0 ? roundMoney(totalAmountWithLiters / totalLiters) : 0,
    litersPer100Km: totalLiters > 0 && totalTripKm > 0 ? round(totalLiters / totalTripKm * 100) : 0,
    kmPerLiter: totalLiters > 0 && totalTripKm > 0 ? round(totalTripKm / totalLiters) : 0,
    fuelLogsWithLiters,
    periodsWithTripKm,
    periodsWithLiters
  };
}

function renderSummary(ledger) {
  els.totalKm.textContent = formatNumber(ledger.totalKm);
  els.fuelRate.textContent = `${formatMoney(ledger.fuelRate)}/km`;
  els.totalCost.textContent = formatMoney(ledger.totalCost);
  els.totalPaid.textContent = formatMoney(ledger.totalPaid);
}

function renderBalances(ledger) {
  els.peopleBalances.innerHTML = state.members
    .map((member) => {
      const person = ledger.people[member];
      return `
        <article class="person-card">
          <header>
            <strong>${escapeHtml(member)}</strong>
          </header>
          <div class="stat-row"><span>Distance share</span><b>${formatNumber(person.km)} km</b></div>
          <div class="stat-row"><span>Fuel share</span><b>${formatMoney(person.tripCost)}</b></div>
          <div class="stat-row"><span>Fuel paid</span><b>${formatMoney(person.fuelPaid)}</b></div>
        </article>
      `;
    })
    .join("");
}

function shouldShowSettlementToCurrentUser(settlement) {
  if (!settlement) return false;
  if (canManageSettings()) return true;
  const profile = getCurrentMemberProfile();
  if (!profile?.name) return false;
  return settlement.from === profile.name || settlement.to === profile.name;
}

function getVisibleSettlements(ledger) {
  return (ledger?.settlements || []).filter(shouldShowSettlementToCurrentUser);
}


function getSettlementProgress(ledger) {
  const settlements = ledger?.settlements || [];
  return settlements.reduce(
    (acc, item) => {
      const status = normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]);
      acc.totalCount += 1;
      acc.totalAmount += Number(item.amount || 0);
      if (status === "paid") {
        acc.paidCount += 1;
        acc.paidAmount += Number(item.amount || 0);
      } else if (status === "requested") {
        acc.requestedCount += 1;
        acc.requestedAmount += Number(item.amount || 0);
      } else {
        acc.openCount += 1;
        acc.openAmount += Number(item.amount || 0);
      }
      return acc;
    },
    { totalCount: 0, totalAmount: 0, requestedCount: 0, requestedAmount: 0, paidCount: 0, paidAmount: 0, openCount: 0, openAmount: 0 }
  );
}

function buildClosePeriodSummary(ledger) {
  const progress = getSettlementProgress(ledger);
  const requestedNotPaid = progress.requestedCount;
  return [
    `${progress.totalCount} final payment${progress.totalCount === 1 ? "" : "s"}`,
    `${progress.paidCount} paid`,
    `${requestedNotPaid} requested but not marked paid`,
    `${progress.openCount} open`
  ].join(" · ");
}

function buildClosePeriodConfirmation(ledger) {
  const progress = getSettlementProgress(ledger);
  const lines = [
    `Close ${ledger.period.label}?`,
    "",
    `This archives ${formatNumber(ledger.totalKm)} participant km and ${formatMoney(ledger.totalPaid)} in fuel, then starts a fresh period.`,
    "",
    `Settlement status: ${buildClosePeriodSummary(ledger)}.`
  ];

  if (progress.requestedCount > 0) {
    lines.push(
      "",
      `${progress.requestedCount} payment${progress.requestedCount === 1 ? " is" : "s are"} requested but not marked paid yet. You can still close the period if the MobilePay requests have been sent, but this period will be archived with those payment${progress.requestedCount === 1 ? "" : "s"} still marked Requested.`
    );
  }

  lines.push("", "Continue?");
  return lines.join("\n");
}

function renderSettlements(ledger) {
  const isAdminView = canManageSettings();
  const settlementProgress = getSettlementProgress(ledger);
  els.closePeriod.classList.toggle("hidden", !isAdminView);
  els.closePeriod.disabled = !isAdminView || (state.trips.length === 0 && state.fuel.length === 0) || settlementProgress.openCount > 0;
  els.closePeriod.title = settlementProgress.openCount > 0 ? "Request all open final payments before closing this period." : "Close this settlement period and start a fresh one for new trips/fuel.";

  renderSettlementWarning(ledger);
  renderPeriodBreakdown(ledger);

  const visibleSettlements = getVisibleSettlements(ledger);

  if (ledger.settlements.length === 0) {
    els.paymentOverview.replaceChildren();
    if (els.memberActionPanel) els.memberActionPanel.replaceChildren();
    els.settlements.replaceChildren(emptyNode("All even."));
    return;
  }

  // Rendering must be read-only. Stale payment status keys are ignored here and
  // cleaned up during explicit save/period-close flows instead of writing while rendering.
  renderPaymentOverview(ledger, visibleSettlements);
  renderMemberActionPanel(ledger, visibleSettlements);

  if (visibleSettlements.length === 0) {
    els.settlements.replaceChildren(emptyNode("No final payments involve you in this period."));
    return;
  }

  els.settlements.innerHTML = visibleSettlements
    .map(
      (item) => {
        const key = settlementKey(item);
        const status = normalizePaymentStatus(state.paymentStatuses[key]);
        const fromPerson = ledger.people[item.from];
        const toPerson = ledger.people[item.to];
        const message = `${item.from} pays ${item.to} ${formatMoney(item.amount)} for shared car fuel`;
        const canRequest = canManageSettlementRequest(item);
        const canMarkPaid = canMarkSettlementPaid(item);
        const pending = pendingSettlementRequestKeys.has(key);
        let requestControls = "";

        if (status === "open") {
          requestControls += canRequest
            ? `<button class="subtle-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="requested" ${pending ? "disabled" : ""}>${pending ? "Requesting..." : "Requested"}</button>`
            : `<span class="request-note">Only ${escapeHtml(item.to)} can request this payment.</span>`;
        } else if (status === "requested") {
          if (canMarkPaid) {
            const mobilePayPrompt = getMobilePayReturnPrompt(key);
            requestControls += `<button class="subtle-button compact-button" type="button" data-copy="${escapeHtml(formatPaymentAmountOnly(item.amount))}">Copy amount</button>`;
            requestControls += `<button class="subtle-button compact-button" type="button" data-open-mobilepay="true" data-payment-key="${escapeHtml(key)}">Open MobilePay</button>`;
            requestControls += `<button class="subtle-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="paid" ${pending ? "disabled" : ""}>${pending ? "Marking paid..." : "Mark paid"}</button>`;
            requestControls += mobilePayPrompt
              ? `<span class="request-note mobilepay-helper">MobilePay opened. After paying ${escapeHtml(mobilePayPrompt.amount)} to ${escapeHtml(mobilePayPrompt.to)}, return here and tap Mark paid.</span>`
              : `<span class="request-note mobilepay-helper">Open MobilePay, pay manually, then return and tap Mark paid.</span>`;
          } else {
            requestControls += `<span class="request-note">Waiting for ${escapeHtml(item.from)} to pay.</span>`;
          }
          if (canRequest) {
            requestControls += `<button class="text-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="open" ${pending ? "disabled" : ""}>${pending ? "Reopening..." : "Reopen"}</button>`;
          }
        } else if (status === "paid") {
          requestControls += `<span class="request-note">Marked paid in the app.</span>`;
          if (canRequest || canManageSettings()) {
            requestControls += `<button class="text-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="open" ${pending ? "disabled" : ""}>${pending ? "Reopening..." : "Reopen"}</button>`;
          }
        }

        return `
        <article class="settlement-card ${status === "requested" ? "is-requested" : ""} ${status === "paid" ? "is-paid" : ""}">
          <div class="settlement-main">
            <div>
              <strong>${escapeHtml(item.from)}</strong>
              <span> pays </span>
              <strong>${escapeHtml(item.to)}</strong>
              <span class="status-chip ${status}">${statusLabel(status)}</span>
            </div>
            <p>${escapeHtml(ledger.period.label)} · ${formatNumber(fromPerson.km)} km distance share at ${formatMoney(ledger.fuelRate)}/km · ${escapeHtml(item.to)} paid ${formatMoney(toPerson.fuelPaid)}</p>
            <details class="settlement-details">
              <summary>Why this payment?</summary>
              ${renderSettlementMathDetails(item, ledger)}
            </details>
            <details class="settlement-details">
              <summary>Fuel payments included</summary>
              ${renderFuelPaymentList(ledger.fuelPayments)}
            </details>
          </div>
          <div class="settlement-actions">
            <strong>${formatMoney(item.amount)}</strong>
            ${requestControls}
          </div>
        </article>
      `;
      }
    )
    .join("");
}

async function closeCurrentPeriod(options = {}) {
  if (!canManageSettings() && !options.allowMemberClose) {
    alert("Only an admin can close periods manually.");
    return;
  }
  if (state.trips.length === 0 && state.fuel.length === 0) {
    alert("Add trips or fuel before closing a period.");
    return;
  }

  const ledger = calculateLedger();
  const settlementProgress = getSettlementProgress(ledger);
  if (settlementProgress.openCount > 0 && !options.allowOpenPayments) {
    alert(`${settlementProgress.openCount} final payment${settlementProgress.openCount === 1 ? " is" : "s are"} still open. Request all final payments before closing this period.`);
    return;
  }

  if (!options.skipFuelValidation && isFuelEstimateWarningActive(ledger)) {
    if (!confirm(buildFuelValidationMessage(ledger, "close this period anyway"))) return;
  }

  if (!options.skipConfirm && !confirm(buildClosePeriodConfirmation(ledger))) {
    return;
  }

  const period = {
    id: crypto.randomUUID(),
    closedAt: new Date().toISOString(),
    label: ledger.period.label,
    currency: state.currency,
    totalTripKm: ledger.totalTripKm,
    totalKm: ledger.totalKm,
    fuelRate: roundMoney(ledger.fuelRate),
    totalCost: ledger.totalCost,
    totalPaid: ledger.totalPaid,
    people: state.members.map((member) => ({
      name: member,
      km: ledger.people[member].km,
      fuelShare: ledger.people[member].tripCost,
      fuelPaid: ledger.people[member].fuelPaid
    })),
    settlements: ledger.settlements.map((item) => ({
      ...item,
      status: normalizePaymentStatus(state.paymentStatuses[settlementKey(item)])
    })),
    trips: structuredClone(state.trips),
    fuel: structuredClone(state.fuel)
  };

  if (!(await closeNormalizedPeriodFirst(period))) {
    return;
  }

  state.closedPeriods.unshift(period);
  state.trips = [];
  state.fuel = [];
  state.paymentStatuses = {};
  state.lastOdometer = getLatestOdometer();
  saveState();
  setDefaultDates();
  render();
}

async function closeNormalizedPeriodFirst(periodSnapshot) {
  if (!supabaseClient || !currentSession) return true;

  try {
    setSyncStatus("Saving");
    const context = await getNormalizedWriteContext();
    if (!context?.openPeriodId) return true;

    const closedAt = periodSnapshot.closedAt || new Date().toISOString();
    const closeResult = await supabaseClient
      .from("settlement_periods")
      .update({
        status: "closed",
        label: periodSnapshot.label || "Closed period",
        closed_at: closedAt,
        snapshot_json: periodSnapshot,
        updated_at: new Date().toISOString()
      })
      .eq("id", context.openPeriodId);
    if (closeResult.error) throw closeResult.error;

    await ensureOpenSettlementPeriod(context.ledgerId);

    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Closed the normalized settlement period and opened a fresh period. JSON will be updated as backup."
    };
    return true;
  } catch (error) {
    console.warn("Table-primary period close failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not close the normalized settlement period, so JSON was not changed: ${error.message || error}`
    };
    alert("Could not close this period in the normalized database. The period was not archived. Check the console for details.");
    render();
    return false;
  }
}

function renderSettlementWarning(ledger) {
  const warnings = getFuelValidationWarnings(ledger);

  if (warnings.length > 0) {
    els.settlementWarning.classList.remove("hidden");
    els.settlementWarning.textContent = `Settlement check: ${warnings[0]}`;
    return;
  }

  els.settlementWarning.classList.add("hidden");
  els.settlementWarning.textContent = "";
}

function renderPeriodBreakdown(ledger) {
  const activityStats = buildPeriodActivityStats(ledger);
  const fuelByPerson = Object.entries(ledger.fuelByPerson || {})
    .filter(([, amount]) => amount > 0)
    .map(([name, amount]) => {
      const liters = Number(ledger.fuelLitersByPerson?.[name] || 0);
      const detail = liters > 0 ? `${formatMoney(amount)} · ${formatNumber(liters)} L` : formatMoney(amount);
      return `<li><span>${escapeHtml(name)}</span><b>${detail}</b></li>`;
    })
    .join("") || `<li><span>Fuel payments</span><b>None yet</b></li>`;

  const periodSummaryCard = `
    <div class="period-breakdown-card wide-breakdown settlement-period-overview period-summary-card">
      <span>Current settlement period</span>
      <div class="period-counter-grid compact-counters">
        <div><strong>${activityStats.tripCount}</strong><small>Trips</small></div>
        <div><strong>${activityStats.fuelCount}</strong><small>Fuel logs</small></div>
        <div><strong>${formatNumber(activityStats.totalTripKm)} km</strong><small>Trip km</small></div>
        <div><strong>${formatNumber(ledger.totalShareKm)} km</strong><small>Participant km</small></div>
        <div><strong>${formatMoney(activityStats.totalFuelPaid)}</strong><small>Fuel paid</small></div>
        <div><strong>${ledger.totalTripKm > 0 && ledger.totalPaid > 0 ? `${formatMoney(ledger.totalPaid / ledger.totalTripKm)}/km` : "—"}</strong><small>Cost per trip km</small></div>
      </div>
      <small>This is the active open period only. These totals are what the current settlement uses.</small>
    </div>
  `;

  const detailedCards = `
    ${renderFuelEstimateCard(ledger)}
    <div class="period-breakdown-card wide-breakdown fuel-consumption-card">
      <span>Fuel consumption in this period</span>
      <strong>${ledger.receiptConsumption > 0 ? `${formatNumber(ledger.receiptConsumption)} L/100 km` : "Not enough data"}</strong>
      <small>${ledger.receiptKmPerLiter > 0 ? `${formatNumber(ledger.receiptKmPerLiter)} km/L · ${formatNumber(ledger.totalFuelLiters)} L logged.` : "Add liters on fuel receipts to build consumption statistics."}</small>
    </div>
    ${renderHistoricalFuelStatsCard(ledger.historicalFuelStats)}
    <div class="period-breakdown-card wide-breakdown">
      <span>Fuel payments by payer</span>
      <ul>${fuelByPerson}</ul>
    </div>
    <div class="period-breakdown-card wide-breakdown full-breakdown">
      <span>Activity by person</span>
      <small>Per-person totals for this open settlement period.</small>
      ${renderPeriodActivityTable(activityStats)}
    </div>
  `;

  if (!canManageSettings()) {
    els.periodBreakdown.innerHTML = `
      ${periodSummaryCard}
      <details class="member-period-details wide-breakdown">
        <summary>Show period details</summary>
        <div class="period-breakdown member-period-details-grid">
          ${detailedCards}
        </div>
      </details>
    `;
    return;
  }

  els.periodBreakdown.innerHTML = `
    ${periodSummaryCard}
    ${detailedCards}
  `;
}

function buildPeriodActivityStats(ledger) {
  const byPerson = Object.fromEntries(
    state.members.map((member) => [
      member,
      {
        name: member,
        driverTrips: 0,
        joinedTrips: 0,
        distanceShare: Number(ledger.people?.[member]?.km || 0),
        fuelLogs: 0,
        fuelPaid: Number(ledger.people?.[member]?.fuelPaid || 0)
      }
    ])
  );

  let totalTripKm = 0;
  for (const trip of state.trips) {
    const km = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
    totalTripKm += km;
    if (byPerson[trip.driver]) byPerson[trip.driver].driverTrips += 1;
    for (const participant of getTripParticipants(trip)) {
      if (byPerson[participant]) byPerson[participant].joinedTrips += 1;
    }
  }

  let totalFuelPaid = 0;
  for (const fuel of state.fuel) {
    const amount = Number(fuel.amount || 0);
    totalFuelPaid += amount;
    if (byPerson[fuel.payer]) byPerson[fuel.payer].fuelLogs += 1;
  }

  return {
    tripCount: state.trips.length,
    fuelCount: state.fuel.length,
    totalTripKm: round(totalTripKm),
    totalFuelPaid: roundMoney(totalFuelPaid),
    people: Object.values(byPerson)
      .filter((person) => person.driverTrips || person.joinedTrips || person.fuelLogs || person.distanceShare || person.fuelPaid)
      .sort((a, b) => (b.distanceShare + b.fuelPaid) - (a.distanceShare + a.fuelPaid) || a.name.localeCompare(b.name))
  };
}

function renderPeriodActivityTable(stats) {
  if (!stats.people.length) {
    return `<p class="entry-meta">No trips or fuel logs in this settlement period yet.</p>`;
  }

  return `
    <div class="activity-table" role="table" aria-label="Current period activity by person">
      <div class="activity-row activity-head" role="row">
        <span>Person</span>
        <span>Trips driven</span>
        <span>Trips joined</span>
        <span>Distance share</span>
        <span>Fuel logs</span>
        <span>Fuel paid</span>
      </div>
      ${stats.people.map((person) => `
        <div class="activity-row" role="row">
          <strong>${escapeHtml(person.name)}</strong>
          <span>${person.driverTrips}</span>
          <span>${person.joinedTrips}</span>
          <span>${formatNumber(person.distanceShare)} km</span>
          <span>${person.fuelLogs}</span>
          <span>${formatMoney(person.fuelPaid)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderHistoricalFuelStatsCard(stats = {}) {
  if (!stats.periodsWithTripKm) {
    return `
      <div class="period-breakdown-card wide-breakdown">
        <span>Historical average</span>
        <strong>Not enough data yet</strong>
        <small>Close settlement periods and enter liters on fuel receipts to build reliable planning stats.</small>
      </div>
    `;
  }

  const consumptionText = stats.litersPer100Km > 0
    ? `${formatNumber(stats.litersPer100Km)} L/100 km · ${formatNumber(stats.kmPerLiter)} km/L`
    : "Add liters to fuel logs";
  const priceText = stats.pricePerLiter > 0
    ? `${formatMoneyFor(stats.pricePerLiter, state.currency)}/L`
    : "Add liters to fuel logs";

  return `
    <div class="period-breakdown-card wide-breakdown">
      <span>Historical average for planning</span>
      <ul>
        <li><span>Fuel cost per trip km</span><b>${stats.costPerKm > 0 ? `${formatMoneyFor(stats.costPerKm, state.currency)}/km` : "Not enough data"}</b></li>
        <li><span>Average fuel price</span><b>${priceText}</b></li>
        <li><span>Fuel consumption</span><b>${consumptionText}</b></li>
        <li><span>Data used</span><b>${formatNumber(stats.totalTripKm)} km · ${formatMoneyFor(stats.totalPaid, state.currency)} · ${stats.fuelLogsWithLiters} fuel logs with liters</b></li>
      </ul>
    </div>
  `;
}

function renderFuelPaymentList(fuelPayments) {
  if (!fuelPayments || fuelPayments.length === 0) {
    return `<p class="entry-meta">No fuel payments have been added to this period.</p>`;
  }

  return `
    <ul class="included-fuel-list">
      ${fuelPayments
        .map((fuel) => {
          const liters = Number(fuel.liters || 0);
          const literText = liters > 0 ? ` · ${formatNumber(liters)} L · ${formatMoneyFor(Number(fuel.amount || 0) / liters, state.currency)}/L` : "";
          return `<li><span>${escapeHtml(fuel.payer)} · ${formatDate(fuel.date)}${literText}</span><b>${formatMoney(fuel.amount)}</b></li>`;
        })
        .join("")}
    </ul>
  `;
}

function renderSettlementMathDetails(settlement, ledger) {
  const fromPerson = ledger.people?.[settlement.from] || {};
  const toPerson = ledger.people?.[settlement.to] || {};
  const fromFuelShare = Number(fromPerson.tripCost || 0);
  const fromFuelPaid = Number(fromPerson.fuelPaid || 0);
  const fromOwes = Math.max(0, fromFuelShare - fromFuelPaid);
  const toFuelShare = Number(toPerson.tripCost || 0);
  const toFuelPaid = Number(toPerson.fuelPaid || 0);
  const toIsOwed = Math.max(0, toFuelPaid - toFuelShare);

  return `
    <div class="settlement-math">
      <p class="entry-meta">The receipts form one shared fuel pool. The app first calculates each person’s fuel share from their distance share, then balances people who paid too little with people who paid too much.</p>
      <ul class="included-fuel-list settlement-math-list">
        <li><span>${escapeHtml(settlement.from)} distance share</span><b>${formatNumber(fromPerson.km || 0)} km</b></li>
        <li><span>${escapeHtml(settlement.from)} fuel share</span><b>${formatMoney(fromFuelShare)}</b></li>
        <li><span>${escapeHtml(settlement.from)} fuel paid</span><b>${formatMoney(fromFuelPaid)}</b></li>
        <li class="math-total"><span>${escapeHtml(settlement.from)} still owes</span><b>${formatMoney(fromOwes)}</b></li>
        <li><span>${escapeHtml(settlement.to)} fuel paid</span><b>${formatMoney(toFuelPaid)}</b></li>
        <li><span>${escapeHtml(settlement.to)} own fuel share</span><b>${formatMoney(toFuelShare)}</b></li>
        <li class="math-total"><span>${escapeHtml(settlement.to)} is owed</span><b>${formatMoney(toIsOwed)}</b></li>
        <li class="math-result"><span>This payment settles</span><b>${formatMoney(settlement.amount)}</b></li>
      </ul>
      <p class="entry-meta">So ${escapeHtml(settlement.from)} is not paying for a specific receipt. ${escapeHtml(settlement.from)} is paying ${escapeHtml(settlement.to)} because ${escapeHtml(settlement.to)} paid more into the shared fuel pool than their own share.</p>
    </div>
  `;
}

function renderFuelEstimateCard(ledger) {
  const estimate = ledger.fuelEstimate || calculateFuelEstimate(ledger);
  if (!estimate.hasEstimate || ledger.totalTripKm <= 0) {
    return `
      <div class="period-breakdown-card wide-breakdown estimate-card">
        <span>Fuel estimate</span>
        <strong>Not enough data yet</strong>
        <small>Add trip kilometers and configure fuel settings to estimate expected fuel cost.</small>
      </div>
    `;
  }

  const source = estimate.source === "live" ? "Circle K/INGO live price" : "fallback price";
  return `
    <div class="period-breakdown-card wide-breakdown estimate-card ${estimate.warningLevel !== "ok" ? "is-warning" : ""}">
      <span>Expected fuel cost check</span>
      <strong>${formatMoney(estimate.expectedCost)}</strong>
      <small>${formatNumber(ledger.totalTripKm)} km × ${formatNumber(estimate.consumption)} L/100 km × ${formatMoneyFor(estimate.pricePerLiter, state.currency)}/L (${escapeHtml(source)}). Logged fuel: ${formatMoney(ledger.totalPaid)} · Coverage: ${formatNumber(estimate.coveragePercent)}%.</small>
    </div>
  `;
}

function calculateFuelEstimate(ledger) {
  const totalTripKm = Number(ledger.totalTripKm || 0);
  const totalPaid = Number(ledger.totalPaid || 0);
  const consumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const fallbackPrice = Math.max(0.1, Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  const livePrice = latestFuelPrice && latestFuelPrice.price > 0 ? Number(latestFuelPrice.price) : 0;
  const pricePerLiter = livePrice || fallbackPrice;
  const source = livePrice ? "live" : "fallback";
  const threshold = Math.min(100, Math.max(1, Number(state.fuelWarningThreshold) || defaults.fuelWarningThreshold));
  const highThreshold = 140;
  const liters = totalTripKm * consumption / 100;
  const expectedCost = roundMoney(liters * pricePerLiter);
  const coveragePercent = expectedCost > 0 ? round(totalPaid / expectedCost * 100) : 100;
  const minimumRequired = expectedCost * threshold / 100;
  const maximumExpected = expectedCost * highThreshold / 100;
  const missingAmount = expectedCost > 0 && totalPaid < minimumRequired ? roundMoney(minimumRequired - totalPaid) : 0;
  const excessAmount = expectedCost > 0 && totalPaid > maximumExpected ? roundMoney(totalPaid - maximumExpected) : 0;
  const warningLevel = missingAmount > 0 ? "low" : excessAmount > 0 ? "high" : "ok";
  return {
    hasEstimate: totalTripKm > 0 && pricePerLiter > 0 && consumption > 0,
    consumption,
    pricePerLiter,
    source,
    expectedCost,
    coveragePercent,
    threshold,
    highThreshold,
    minimumRequired: roundMoney(minimumRequired),
    maximumExpected: roundMoney(maximumExpected),
    missingAmount,
    excessAmount,
    warningLevel
  };
}

async function refreshFuelPriceEstimate() {
  window.clearTimeout(fuelPriceTimer);
  const fuelType = state.fuelType || defaults.fuelType;
  try {
    const response = await fetch(`${fuelPriceUrl}?fuelType=${encodeURIComponent(fuelType)}`);
    if (response.ok) {
      const data = await response.json();
      if (data?.price) {
        latestFuelPrice = data;
        render();
      }
    }
  } catch {
    // The app falls back to the configured manual price if the public price API is unavailable.
  }
  fuelPriceTimer = window.setTimeout(refreshFuelPriceEstimate, 60 * 60 * 1000);
}

function getFuelValidationWarnings(ledger) {
  const warnings = [];
  const hasTrips = state.trips.length > 0 || ledger.totalTripKm > 0;
  const estimate = ledger.fuelEstimate || calculateFuelEstimate(ledger);
  const noFuel = hasTrips && ledger.totalPaid <= 0;

  if (noFuel && estimate.hasEstimate) {
    warnings.push(`No fuel payments have been added yet. Based on ${formatNumber(ledger.totalTripKm)} trip km, ${formatNumber(estimate.consumption)} L/100 km and ${formatMoneyFor(estimate.pricePerLiter, state.currency)}/L, expected fuel cost is about ${formatMoney(estimate.expectedCost)}.`);
  } else if (noFuel) {
    warnings.push("There are trips in this period, but no fuel payments yet. Add every refuel receipt before requesting settlements.");
  } else if (estimate.hasEstimate && estimate.missingAmount > 0) {
    warnings.push(`Fuel payments look incomplete. Expected about ${formatMoney(estimate.expectedCost)} for ${formatNumber(ledger.totalTripKm)} trip km, but only ${formatMoney(ledger.totalPaid)} has been logged (${formatNumber(estimate.coveragePercent)}% of expected).`);
  } else if (estimate.hasEstimate && estimate.excessAmount > 0) {
    warnings.push(`Fuel payments look unusually high. Expected about ${formatMoney(estimate.expectedCost)} for ${formatNumber(ledger.totalTripKm)} trip km, but ${formatMoney(ledger.totalPaid)} has been logged (${formatNumber(estimate.coveragePercent)}% of expected). Check for duplicate fuel logs, wrong amounts, or missing trips.`);
  }

  const largePaymentWithoutLiters = state.fuel.find((fuel) => Number(fuel.amount || 0) >= 500 && !(Number(fuel.liters || 0) > 0));
  if (largePaymentWithoutLiters) {
    warnings.push(`${largePaymentWithoutLiters.payer} logged ${formatMoney(largePaymentWithoutLiters.amount)} without liters. Add liters from the receipt to verify the price per liter.`);
  }

  for (const fuel of state.fuel) {
    const amount = Number(fuel.amount || 0);
    const liters = Number(fuel.liters || 0);
    if (!(amount > 0 && liters > 0)) continue;
    const pricePerLiter = amount / liters;
    if (pricePerLiter < 8 || pricePerLiter > 25) {
      warnings.push(`${fuel.payer}'s fuel log on ${formatDate(fuel.date)} has an unusual price: ${formatMoneyFor(pricePerLiter, state.currency)}/L.`);
    }
  }

  if (ledger.totalTripKm > 0 && ledger.totalFuelLiters > 0) {
    const litersPer100Km = ledger.totalFuelLiters / ledger.totalTripKm * 100;
    if (litersPer100Km < 3 || litersPer100Km > 9) {
      warnings.push(`Receipt-based fuel consumption is unusual for this car: ${formatNumber(litersPer100Km)} L/100 km. Check liters, trip distance, and whether fuel belongs to this period.`);
    }
  }

  return warnings;
}

function isFuelEstimateWarningActive(ledger) {
  return getFuelValidationWarnings(ledger).length > 0;
}

function buildFuelValidationMessage(ledger, actionLabel = "continue") {
  const estimate = ledger.fuelEstimate || calculateFuelEstimate(ledger);
  const warnings = getFuelValidationWarnings(ledger);
  const lines = [
    "Fuel sanity check",
    "",
    ...warnings.map((warning) => `- ${warning}`),
    "",
    `Trips in this period: ${formatNumber(ledger.totalTripKm)} km`,
    `Fuel logged: ${formatMoney(ledger.totalPaid)}`,
  ];

  if (estimate.hasEstimate) {
    lines.push(
      `Expected fuel cost: about ${formatMoney(estimate.expectedCost)}`,
      `Coverage: ${formatNumber(estimate.coveragePercent)}% of expected`,
      `Low warning below: ${formatNumber(estimate.threshold)}%`,
      `High warning above: ${formatNumber(estimate.highThreshold)}%`,
      "",
      `This estimate uses ${formatNumber(estimate.consumption)} L/100 km and ${formatMoneyFor(estimate.pricePerLiter, state.currency)}/L.`
    );
  }

  lines.push(
    "",
    "Check that fuel amounts, liters, and all trips in this period are correct before requesting payments.",
    "",
    `Are you sure you want to ${actionLabel}?`
  );

  return lines.join("\n");
}

function renderPaymentOverview(ledger, visibleSettlements = getVisibleSettlements(ledger)) {
  const hiddenCount = Math.max(0, (ledger.settlements || []).length - visibleSettlements.length);
  const totals = visibleSettlements.reduce(
    (acc, item) => {
      const status = normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]);
      acc.totalCount += 1;
      acc.totalAmount += item.amount;
      if (status === "paid") {
        acc.paidCount += 1;
        acc.paidAmount += item.amount;
      } else if (status === "requested") {
        acc.requestedCount += 1;
        acc.requestedAmount += item.amount;
      } else {
        acc.openCount += 1;
        acc.openAmount += item.amount;
      }
      return acc;
    },
    { totalCount: 0, totalAmount: 0, requestedCount: 0, requestedAmount: 0, paidCount: 0, paidAmount: 0, openCount: 0, openAmount: 0 }
  );

  els.paymentOverview.innerHTML = `
    <div>
      <span>Final payments</span>
      <strong>${totals.totalCount}</strong>
      <small>${hiddenCount ? `Showing ${totals.totalCount} payment${totals.totalCount === 1 ? "" : "s"} relevant to you. ${hiddenCount} other period payment${hiddenCount === 1 ? "" : "s"} hidden.` : "Payments needed after all trips and fuel receipts are netted."}</small>
    </div>
    <div>
      <span>Requested / paid</span>
      <strong>${totals.requestedCount} requested · ${totals.paidCount} paid</strong>
      <small>${formatMoney(totals.requestedAmount)} requested; ${formatMoney(totals.paidAmount)} marked paid.</small>
    </div>
    <div>
      <span>Open payments</span>
      <strong>${totals.openCount} · ${formatMoney(totals.openAmount)}</strong>
      <small>${hiddenCount ? "Open payments involving you." : "Final payments not requested yet. Period-wide, not just your account."}</small>
    </div>
  `;
}



function getMemberActionSummary(ledger, visibleSettlements = getVisibleSettlements(ledger)) {
  const profile = getCurrentMemberProfile();
  const isAdmin = canManageSettings();
  const visible = visibleSettlements || [];
  const requested = visible.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "requested");
  const paid = visible.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "paid");
  const open = visible.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "open");
  const name = profile?.name || currentUser;
  const sum = (rows) => rows.reduce((total, item) => total + Number(item.amount || 0), 0);

  const openToMe = name ? open.filter((item) => item.to === name) : [];
  const requestedFromMe = name ? requested.filter((item) => item.from === name) : [];
  const paidFromMe = name ? paid.filter((item) => item.from === name) : [];
  const openFromMe = name ? open.filter((item) => item.from === name) : [];
  const requestedToMe = name ? requested.filter((item) => item.to === name) : [];
  const paidToMe = name ? paid.filter((item) => item.to === name) : [];

  if (isAdmin) {
    const all = ledger.settlements || [];
    const allRequested = all.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "requested");
    const allPaid = all.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "paid");
    const allOpenItems = all.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "open");
    const adminCanRequest = name ? allOpenItems.filter((item) => item.to === name) : [];
    const otherFuelPayersMustRequest = name ? allOpenItems.filter((item) => item.to !== name) : allOpenItems;
    const requestedYouCanManage = name
      ? allRequested.filter((item) => item.to === name || item.from === name)
      : allRequested;
    const readyText = allOpenItems.length
      ? `${allOpenItems.length} open payment${allOpenItems.length === 1 ? "" : "s"} must be requested before closing the period.`
      : `Ready to close: ${all.length} final payment${all.length === 1 ? "" : "s"} · ${allPaid.length} paid · ${allRequested.length} requested but not marked paid · 0 open.`;
    const adminActionText = allOpenItems.length
      ? `You can request ${adminCanRequest.length} payment${adminCanRequest.length === 1 ? "" : "s"} where you are the recipient. ${otherFuelPayersMustRequest.length} open payment${otherFuelPayersMustRequest.length === 1 ? "" : "s"} must be requested by another fuel payer.`
      : allRequested.length
        ? `${allRequested.length} payment${allRequested.length === 1 ? " is" : "s are"} requested but not marked paid. You can close anyway if the MobilePay requests have been sent.`
        : "All final payments are marked paid. The period is ready to close.";
    return {
      isAdmin,
      actionCount: allOpenItems.length,
      title: "Settlement status",
      body: all.length
        ? `${allRequested.length} requested and ${allPaid.length} paid of ${all.length} final payment${all.length === 1 ? "" : "s"}. ${readyText}`
        : "No final payments are needed for this period.",
      detail: all.length
        ? `${adminActionText}${requestedYouCanManage.length ? ` ${requestedYouCanManage.length} requested payment${requestedYouCanManage.length === 1 ? "" : "s"} involving you can be reopened if needed.` : ""}`
        : "Admin period-wide summary."
    };
  }

  if (openToMe.length) {
    return {
      isAdmin,
      actionCount: openToMe.length,
      title: "What do I need to do?",
      body: `Request ${openToMe.length} payment${openToMe.length === 1 ? "" : "s"} totaling ${formatMoney(sum(openToMe))}.`,
      detail: "You paid fuel and these payments are ready for you to request."
    };
  }

  if (requestedFromMe.length) {
    const recipients = requestedFromMe.map((item) => `${item.to} ${formatMoney(item.amount)}`).join(", ");
    return {
      isAdmin,
      actionCount: requestedFromMe.length,
      title: "What do I need to do?",
      body: `You have been asked to pay ${formatMoney(sum(requestedFromMe))}: ${recipients}.`,
      detail: "Pay in MobilePay, then mark the payment as paid in the app."
    };
  }

  if (paidFromMe.length) {
    return {
      isAdmin,
      actionCount: 0,
      title: "What do I need to do?",
      body: `You marked ${formatMoney(sum(paidFromMe))} as paid.`,
      detail: "No further action is needed unless the recipient asks you to reopen it."
    };
  }

  if (openFromMe.length) {
    return {
      isAdmin,
      actionCount: 0,
      title: "What do I need to do?",
      body: `You owe ${formatMoney(sum(openFromMe))}, but the fuel payer has not requested it yet.`,
      detail: "No action is needed until the fuel payer requests payment."
    };
  }

  if (requestedToMe.length) {
    return {
      isAdmin,
      actionCount: 0,
      title: "What do I need to do?",
      body: `You requested ${formatMoney(sum(requestedToMe))}. Waiting for MobilePay payment.`,
      detail: "The payer can mark it as paid after paying."
    };
  }

  if (paidToMe.length) {
    return {
      isAdmin,
      actionCount: 0,
      title: "What do I need to do?",
      body: `${formatMoney(sum(paidToMe))} has been marked as paid to you.`,
      detail: "Check MobilePay if needed. You can reopen the payment if it was marked paid by mistake."
    };
  }

  return {
    isAdmin,
    actionCount: 0,
    title: "What do I need to do?",
    body: visible.length ? "Your visible payments are balanced for now." : "No final payments involve you in this period.",
    detail: "Only payments involving your member profile are shown below."
  };
}

function renderSettleActionBadge(ledger) {
  const settleTab = els.sectionTabs.find((button) => button.dataset.viewTab === "settle");
  if (!settleTab) return;
  const summary = getMemberActionSummary(ledger);
  let badge = settleTab.querySelector(".tab-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "tab-badge";
    settleTab.appendChild(badge);
  }
  const count = Number(summary.actionCount || 0);
  badge.textContent = count > 9 ? "9+" : String(count);
  badge.classList.toggle("hidden", count <= 0);
  settleTab.setAttribute("aria-label", count > 0 ? `Settle, ${count} action${count === 1 ? "" : "s"}` : "Settle");
}

function renderMemberActionPanel(ledger, visibleSettlements = getVisibleSettlements(ledger)) {
  if (!els.memberActionPanel) return;
  if (!currentSession && supabaseClient) {
    els.memberActionPanel.replaceChildren();
    return;
  }

  const summary = getMemberActionSummary(ledger, visibleSettlements);
  els.memberActionPanel.innerHTML = `
    <div class="member-action-card ${summary.isAdmin ? "is-admin" : ""}">
      <span>${escapeHtml(summary.title)}</span>
      <strong>${escapeHtml(summary.body)}</strong>
      <small>${escapeHtml(summary.detail)}</small>
    </div>
  `;
}

async function updatePaymentStatus(button) {
  const key = button.dataset.paymentKey;
  if (pendingSettlementRequestKeys.has(key)) return;

  const ledger = calculateLedger();
  const settlement = ledger.settlements.find((item) => settlementKey(item) === key);

  const requestedStatus = normalizePaymentStatus(button.dataset.paymentStatus);
  const previousStatus = normalizePaymentStatus(state.paymentStatuses[key]);
  const mayChangeRequest = requestedStatus === "requested" || requestedStatus === "open";
  const mayMarkPaid = requestedStatus === "paid";

  if (!settlement || (mayChangeRequest && !canManageSettlementRequest(settlement) && !canManageSettings()) || (mayMarkPaid && !canMarkSettlementPaid(settlement))) {
    alert(requestedStatus === "paid" ? "Only the person who owes this payment can mark it as paid." : "Only the person who paid for fuel in this settlement can request or reopen that payment.");
    render();
    return;
  }

  if (button.dataset.paymentStatus === "requested" && isFuelEstimateWarningActive(ledger)) {
    if (!confirm(buildFuelValidationMessage(ledger, "request this payment anyway"))) {
      render();
      return;
    }
  }

  const nextStatus = requestedStatus;
  pendingSettlementRequestKeys.add(key);
  button.disabled = true;
  button.textContent = nextStatus === "requested" ? "Requesting..." : nextStatus === "paid" ? "Marking paid..." : "Reopening...";
  setSyncStatus("Saving");

  const tableSaved = await saveSettlementRequestToNormalizedTableFirst(settlement, nextStatus);
  if (!tableSaved) {
    pendingSettlementRequestKeys.delete(key);
    render();
    return;
  }

  state.paymentStatuses[key] = nextStatus;
  if (["paid", "open", "requested"].includes(nextStatus)) clearMobilePayReturnPrompt(key);
  saveState();
  pendingSettlementRequestKeys.delete(key);
  render();

  if (nextStatus === "requested") {
    sendSettlementPush(settlement).catch((error) => {
      console.warn("Settlement push notification failed", error);
    });
  }

  // Requesting or marking a payment must never close the period automatically.
  // A period can contain requested/paid payments while the admin reviews it.
  // Closing is an explicit admin-only action via the Close period button.
}

async function copySettlement(button) {
  const text = button.dataset.copy;
  const originalText = button.dataset.originalText || button.textContent || "Copy";
  button.dataset.originalText = originalText;

  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
    button.textContent = "Copied";
  }

  window.setTimeout(() => {
    button.textContent = button.dataset.originalText || "Copy";
  }, 1600);
}


function exportLedgerBackup() {
  const filename = `fuel-ledger-backup-${localDateString()}.json`;
  const backup = {
    exportedAt: new Date().toISOString(),
    app: "Fuel Ledger",
    version: 1,
    state: normalizeState(state)
  };
  downloadTextFile(filename, JSON.stringify(backup, null, 2), "application/json");
  setDataToolsMessage("Backup exported.");
}

async function importLedgerBackup() {
  const file = els.importLedgerFile?.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const importedState = normalizeState(parsed.state || parsed);
    const memberCount = importedState.members.length;
    const tripCount = importedState.trips.length;
    const fuelCount = importedState.fuel.length;
    const periodCount = importedState.closedPeriods.length;

    if (
      !confirm(
        `Restore this backup? This will replace the current ledger with ${memberCount} people, ${tripCount} current trips, ${fuelCount} current fuel payments, and ${periodCount} closed periods.`
      )
    ) {
      return;
    }

    state = importedState;
    state.lastOdometer = getLatestOdometer();
    saveState();
    setDefaultDates();
    render();
    setDataToolsMessage("Backup imported and saved.");
  } catch (error) {
    setDataToolsMessage(`Could not import backup: ${error.message || "invalid JSON"}`);
  } finally {
    if (els.importLedgerFile) els.importLedgerFile.value = "";
  }
}

function downloadLedgerCsv() {
  const date = localDateString();
  const trips = [];
  for (const trip of state.trips) trips.push(csvTripRow(trip, "current", ""));
  for (const period of state.closedPeriods) {
    for (const trip of period.trips || []) trips.push(csvTripRow(trip, "closed", period.label || period.closedAt || ""));
  }

  const fuel = [];
  for (const item of state.fuel) fuel.push(csvFuelRow(item, "current", ""));
  for (const period of state.closedPeriods) {
    for (const item of period.fuel || []) fuel.push(csvFuelRow(item, "closed", period.label || period.closedAt || ""));
  }

  downloadTextFile(
    `fuel-ledger-trips-${date}.csv`,
    toCsv([
      ["period_status", "period", "date", "driver", "start_km", "end_km", "trip_km", "participants", "participant_count", "note"],
      ...trips
    ]),
    "text/csv;charset=utf-8"
  );
  downloadTextFile(
    `fuel-ledger-fuel-${date}.csv`,
    toCsv([
      ["period_status", "period", "date", "payer", "amount", "currency", "liters", "price_per_liter", "odometer", "station", "station_brand", "station_latitude", "station_longitude", "user_latitude", "user_longitude", "full_tank"],
      ...fuel
    ]),
    "text/csv;charset=utf-8"
  );
  setDataToolsMessage("CSV files downloaded.");
}


function downloadCurrentPeriodReport() {
  const ledger = calculateLedger();
  const activity = buildPeriodActivityStats(ledger);
  const settlements = ledger.settlements || [];
  const requestedSettlements = settlements.filter((settlement) => getSettlementStatus(settlement) === "requested");
  const paidSettlements = settlements.filter((settlement) => getSettlementStatus(settlement) === "paid");
  const openSettlements = settlements.filter((settlement) => getSettlementStatus(settlement) === "open");
  const periodLabel = ledger.period?.label || "Current settlement period";
  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  const lines = [];
  lines.push(`# Fuel Ledger report - ${periodLabel}`);
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## Period totals");
  lines.push(`- Trips: ${activity.tripCount}`);
  lines.push(`- Fuel logs: ${activity.fuelCount}`);
  lines.push(`- Trip km: ${formatNumber(activity.totalTripKm)} km`);
  lines.push(`- Participant km: ${formatNumber(ledger.totalShareKm)} km`);
  lines.push(`- Fuel paid: ${formatMoney(ledger.totalPaid)}`);
  lines.push(`- Fuel cost per participant km: ${ledger.totalShareKm > 0 ? `${formatMoney(ledger.fuelRate)}/km` : "-"}`);
  lines.push(`- Fuel cost per trip km: ${ledger.totalTripKm > 0 ? `${formatMoney(ledger.totalPaid / ledger.totalTripKm)}/km` : "-"}`);
  lines.push(`- Fuel consumption: ${ledger.receiptConsumption > 0 ? `${formatNumber(ledger.receiptConsumption)} L/100 km (${formatNumber(ledger.receiptKmPerLiter)} km/L)` : "Not enough liter data"}`);
  lines.push("");
  lines.push("## Final payments");
  lines.push(`- Total final payment lines: ${settlements.length}`);
  lines.push(`- Requested: ${requestedSettlements.length} (${formatMoney(requestedSettlements.reduce((sum, item) => sum + Number(item.amount || 0), 0))})`);
  lines.push(`- Paid: ${paidSettlements.length} (${formatMoney(paidSettlements.reduce((sum, item) => sum + Number(item.amount || 0), 0))})`);
  lines.push(`- Open: ${openSettlements.length} (${formatMoney(openSettlements.reduce((sum, item) => sum + Number(item.amount || 0), 0))})`);
  if (settlements.length) {
    lines.push("");
    for (const settlement of settlements) {
      lines.push(`- ${settlement.from} pays ${settlement.to}: ${formatMoney(settlement.amount)} (${statusLabel(getSettlementStatus(settlement))})`);
    }
  } else {
    lines.push("- No payments needed.");
  }
  lines.push("");
  lines.push("## Activity by person");
  if (activity.people.length) {
    lines.push("| Person | Trips driven | Trips joined | Distance share | Fuel logs | Fuel paid | Fuel share | Net |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const person of activity.people) {
      const ledgerPerson = ledger.people[person.name] || {};
      lines.push(`| ${markdownCell(person.name)} | ${person.driverTrips} | ${person.joinedTrips} | ${formatNumber(person.distanceShare)} km | ${person.fuelLogs} | ${formatMoney(person.fuelPaid)} | ${formatMoney(ledgerPerson.tripCost || 0)} | ${formatMoney(ledgerPerson.net || 0)} |`);
    }
  } else {
    lines.push("No activity in this period.");
  }
  lines.push("");
  lines.push("## Fuel payments by payer");
  const fuelPayers = Object.entries(ledger.fuelByPerson || {}).filter(([, amount]) => Number(amount || 0) > 0);
  if (fuelPayers.length) {
    for (const [name, amount] of fuelPayers) {
      const liters = Number(ledger.fuelLitersByPerson?.[name] || 0);
      lines.push(`- ${name}: ${formatMoney(amount)}${liters > 0 ? ` · ${formatNumber(liters)} L` : ""}`);
    }
  } else {
    lines.push("- No fuel payments in this period.");
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("Final payments are not one payment per trip. They are the netted result after all trips and fuel receipts in the open period are balanced.");

  downloadTextFile(`fuel-ledger-period-report-${localDateString()}.md`, lines.join("\n"), "text/markdown;charset=utf-8");
  setDataToolsMessage("Current period report downloaded.");
}


function downloadClosedPeriodReport(periodId) {
  const period = state.closedPeriods.find((item) => item.id === periodId);
  if (!period) {
    alert("Could not find that closed period.");
    return;
  }

  const lines = buildClosedPeriodReportLines(period);
  const closedDate = String(period.closedAt || localDateString()).slice(0, 10);
  downloadTextFile(`fuel-ledger-closed-period-${closedDate}-${period.id.slice(0, 8)}.md`, lines.join("\n"), "text/markdown;charset=utf-8");
}

function buildClosedPeriodReportLines(period) {
  const currency = period.currency || state.currency;
  const trips = Array.isArray(period.trips) ? period.trips : [];
  const fuel = Array.isArray(period.fuel) ? period.fuel : [];
  const settlements = Array.isArray(period.settlements) ? period.settlements : [];
  const people = Array.isArray(period.people) ? period.people : [];
  const requested = settlements.filter((item) => normalizePaymentStatus(item.status) === "requested");
  const paid = settlements.filter((item) => normalizePaymentStatus(item.status) === "paid");
  const open = settlements.filter((item) => normalizePaymentStatus(item.status) === "open");
  const totalLiters = fuel.reduce((sum, item) => sum + Number(item.liters || 0), 0);
  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const label = period.label || "Closed settlement period";

  const lines = [];
  lines.push(`# Fuel Ledger closed period - ${label}`);
  lines.push("");
  lines.push(`Closed: ${period.closedAt ? formatDate(String(period.closedAt).slice(0, 10)) : "-"}`);
  lines.push(`Report generated: ${generatedAt}`);
  lines.push("");
  lines.push("## Period totals");
  lines.push(`- Trips: ${trips.length}`);
  lines.push(`- Fuel logs: ${fuel.length}`);
  lines.push(`- Trip km: ${formatNumber(period.totalTripKm || period.totalKm || 0)} km`);
  lines.push(`- Participant km: ${formatNumber(period.totalKm || 0)} km`);
  lines.push(`- Fuel paid: ${formatMoneyFor(period.totalPaid || 0, currency)}`);
  lines.push(`- Fuel rate: ${formatMoneyFor(period.fuelRate || 0, currency)}/km`);
  if (totalLiters > 0) lines.push(`- Liters logged: ${formatNumber(totalLiters)} L`);
  lines.push("");
  lines.push("## Final payments");
  lines.push(`- Total final payments: ${settlements.length}`);
  lines.push(`- Paid: ${paid.length} (${formatMoneyFor(paid.reduce((sum, item) => sum + Number(item.amount || 0), 0), currency)})`);
  lines.push(`- Requested but not marked paid: ${requested.length} (${formatMoneyFor(requested.reduce((sum, item) => sum + Number(item.amount || 0), 0), currency)})`);
  lines.push(`- Open / not requested: ${open.length} (${formatMoneyFor(open.reduce((sum, item) => sum + Number(item.amount || 0), 0), currency)})`);
  if (settlements.length) {
    lines.push("");
    for (const item of settlements) {
      lines.push(`- ${item.from} pays ${item.to}: ${formatMoneyFor(item.amount || 0, currency)} (${statusLabel(item.status)})`);
    }
  } else {
    lines.push("- No payments were needed.");
  }
  lines.push("");
  lines.push("## Activity by person");
  if (people.length) {
    lines.push("| Person | Distance share | Fuel share | Fuel paid |");
    lines.push("|---|---:|---:|---:|");
    for (const person of people) {
      lines.push(`| ${markdownCell(person.name)} | ${formatNumber(person.km || 0)} km | ${formatMoneyFor(person.fuelShare || 0, currency)} | ${formatMoneyFor(person.fuelPaid || 0, currency)} |`);
    }
  } else {
    lines.push("No people activity was saved for this period.");
  }
  lines.push("");
  lines.push("## Trips");
  if (trips.length) {
    for (const trip of [...trips].sort(byNewest)) {
      const km = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
      lines.push(`- ${formatDate(trip.date)} · ${trip.driver} · ${formatNumber(km)} km · ${formatNumber(trip.startKm || 0)} to ${formatNumber(trip.endKm || 0)} km · split: ${getTripParticipants(trip).join(", ")}${trip.note ? ` · ${trip.note}` : ""}`);
    }
  } else {
    lines.push("No trips saved in this period.");
  }
  lines.push("");
  lines.push("## Fuel logs");
  if (fuel.length) {
    for (const item of [...fuel].sort(byNewest)) {
      const liters = Number(item.liters || 0);
      const price = liters > 0 ? ` · ${formatNumber(liters)} L · ${formatMoneyFor(Number(item.amount || 0) / liters, currency)}/L` : "";
      const odometer = item.odometer ? ` · ${formatNumber(item.odometer)} km` : "";
      const station = item.station ? ` · ${item.station}` : "";
      lines.push(`- ${formatDate(item.date)} · ${item.payer} · ${formatMoneyFor(item.amount || 0, currency)}${price}${odometer}${station}`);
    }
  } else {
    lines.push("No fuel logs saved in this period.");
  }
  lines.push("");
  lines.push("## Note");
  lines.push("Final payments are netted across the whole settlement period. They are not one payment per trip.");
  return lines;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
}

function csvTripRow(trip, periodStatus, periodLabel) {
  const participants = getTripParticipants(trip);
  return [
    periodStatus,
    periodLabel,
    trip.date || "",
    trip.driver || "",
    trip.startKm ?? "",
    trip.endKm ?? "",
    round(Number(trip.endKm || 0) - Number(trip.startKm || 0)),
    participants.join("; "),
    participants.length,
    trip.note || ""
  ];
}

function csvFuelRow(fuel, periodStatus, periodLabel) {
  const liters = Number(fuel.liters || 0);
  const amount = Number(fuel.amount || 0);
  return [
    periodStatus,
    periodLabel,
    fuel.date || "",
    fuel.payer || "",
    amount,
    state.currency,
    liters || "",
    liters > 0 ? roundMoney(amount / liters) : "",
    fuel.odometer || "",
    fuel.station || "",
    fuel.stationInfo?.brand || "",
    fuel.stationInfo?.latitude || "",
    fuel.stationInfo?.longitude || "",
    fuel.location?.latitude || "",
    fuel.location?.longitude || "",
    fuel.fullTank ? "yes" : "no"
  ];
}

function removeUnusedTestUsers() {
  const removable = state.members.filter((member) => /test/i.test(member) && !memberHasLedgerData(member));

  if (removable.length === 0) {
    setDataToolsMessage("No unused test users found.");
    return;
  }

  if (!confirm(`Remove these unused test users?\n\n${removable.join("\n")}`)) return;

  state.members = state.members.filter((member) => !removable.includes(member));
  for (const member of removable) delete state.memberProfiles[member];
  if (!state.members.includes(currentUser)) {
    currentUser = getCurrentMemberProfile()?.name || state.members[0] || "";
    localStorage.setItem(userKey, currentUser);
  }
  saveState();
  render();
  setDataToolsMessage(`Removed ${removable.length} unused test user${removable.length === 1 ? "" : "s"}.`);
}

function memberHasLedgerData(member) {
  const inCurrentTrips = state.trips.some(
    (trip) => trip.driver === member || getTripParticipants(trip).includes(member)
  );
  const inCurrentFuel = state.fuel.some((fuel) => fuel.payer === member);
  const inPayments = Object.keys(state.paymentStatuses || {}).some((key) => key.includes(`${member}->`) || key.includes(`->${member}:`));
  const inClosedPeriods = state.closedPeriods.some((period) => {
    return (
      (period.people || []).some((person) => person.name === member) ||
      (period.trips || []).some((trip) => trip.driver === member || getTripParticipants(trip).includes(member)) ||
      (period.fuel || []).some((fuel) => fuel.payer === member) ||
      (period.settlements || []).some((settlement) => settlement.from === member || settlement.to === member)
    );
  });
  return inCurrentTrips || inCurrentFuel || inPayments || inClosedPeriods;
}

function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? "");
          return /[",\n;]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
        })
        .join(",")
    )
    .join("\n");
}

function downloadTextFile(filename, content, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function setDataToolsMessage(message) {
  if (!els.dataToolsMessage) return;
  els.dataToolsMessage.textContent = message;
}


function canManageTripEntry(trip) {
  if (!trip) return false;
  if (canManageSettings()) return true;
  const profile = getCurrentMemberProfile();
  return Boolean(profile && trip.driver === profile.name);
}

function canManageFuelEntry(fuel) {
  if (!fuel) return false;
  if (canManageSettings()) return true;
  const profile = getCurrentMemberProfile();
  return Boolean(profile && fuel.payer === profile.name);
}

function showLogViewForEditing() {
  activeView = "log";
  localStorage.setItem(viewStorageKey, activeView);
  renderSectionNavigation();
}

function showHistoryForPeriodReview() {
  activeView = "history";
  localStorage.setItem(viewStorageKey, activeView);
  render();
  const historySection = document.querySelector('[data-view="history"]');
  if (historySection) {
    historySection.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  document.querySelectorAll('[data-view="history"] details.history-group').forEach((details) => {
    details.open = true;
  });
}

function editEntry(value) {
  const [type, id] = String(value || "").split(":");
  if (type === "trips") {
    const trip = state.trips.find((entry) => entry.id === id);
    if (!canManageTripEntry(trip)) {
      alert("You can only edit your own trip logs.");
      return;
    }
    startTripEdit(id);
    return;
  }
  if (type === "fuel") {
    const fuel = state.fuel.find((entry) => entry.id === id);
    if (!canManageFuelEntry(fuel)) {
      alert("You can only edit your own fuel logs.");
      return;
    }
    startFuelEdit(id);
  }
}

function startTripEdit(id) {
  const trip = state.trips.find((entry) => entry.id === id);
  if (!trip) return;

  showLogViewForEditing();
  editingFuelId = null;
  editingTripId = id;
  renderPeopleSelectors();
  els.tripDriver.value = trip.driver;
  els.tripDate.value = trip.date;
  els.startKm.value = trip.startKm;
  els.endKm.value = trip.endKm;
  els.tripNote.value = trip.note || "";
  renderParticipantOptions();
  const participants = new Set(getTripParticipants(trip));
  for (const input of els.tripParticipants.querySelectorAll("input")) {
    input.checked = participants.has(input.value);
  }
  updateEditUi();
  els.tripForm.scrollIntoView({ behavior: "smooth", block: "start" });
  els.startKm.focus();
}

function startFuelEdit(id) {
  const fuel = state.fuel.find((entry) => entry.id === id);
  if (!fuel) return;

  showLogViewForEditing();
  editingTripId = null;
  editingFuelId = id;
  renderPeopleSelectors();
  els.fuelPayer.value = fuel.payer;
  els.fuelDate.value = fuel.date;
  els.fuelAmount.value = fuel.amount;
  if (els.fuelLiters) els.fuelLiters.value = fuel.liters || "";
  if (els.fuelOdometer) els.fuelOdometer.value = fuel.odometer || "";
  if (els.fuelStation) els.fuelStation.value = fuel.station || fuel.stationInfo?.name || "";
  if (els.fuelLatitude) els.fuelLatitude.value = fuel.location?.latitude || "";
  if (els.fuelLongitude) els.fuelLongitude.value = fuel.location?.longitude || "";
  if (els.fuelStationLatitude) els.fuelStationLatitude.value = fuel.stationInfo?.latitude || "";
  if (els.fuelStationLongitude) els.fuelStationLongitude.value = fuel.stationInfo?.longitude || "";
  if (els.fuelStationBrand) els.fuelStationBrand.value = fuel.stationInfo?.brand || "";
  if (els.fuelFullTank) els.fuelFullTank.checked = Boolean(fuel.fullTank);
  const details = document.querySelector("#fuelDetails");
  if (details) details.open = true;
  updateEditUi();
  els.fuelForm.scrollIntoView({ behavior: "smooth", block: "start" });
  els.fuelAmount.focus();
}

function updateEditUi() {
  if (els.tripSubmit) els.tripSubmit.textContent = editingTripId ? "Save trip changes" : "Add trip";
  if (els.cancelTripEdit) els.cancelTripEdit.classList.toggle("hidden", !editingTripId);
  if (els.fuelSubmit) els.fuelSubmit.textContent = editingFuelId ? "Save fuel changes" : "Add fuel";
  if (els.cancelFuelEdit) els.cancelFuelEdit.classList.toggle("hidden", !editingFuelId);
}

function renderHistory() {
  if (state.trips.length === 0) {
    els.tripList.replaceChildren(emptyNode());
  } else {
    els.tripList.innerHTML = renderCategorizedTrips(state.trips);
  }

  if (state.fuel.length === 0) {
    els.fuelList.replaceChildren(emptyNode());
  } else {
    els.fuelList.innerHTML = renderCategorizedFuel(state.fuel);
  }
}

function renderCategorizedTrips(trips) {
  const sortedTrips = [...trips].sort(byNewest);
  const grouped = groupBy(sortedTrips, (trip) => trip.driver || "Unknown");
  const totalKm = round(sortedTrips.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0)), 0));
  const summary = `
    <article class="entry-card history-summary-card">
      <strong>Current period trip log</strong>
      <p>${sortedTrips.length} trip${sortedTrips.length === 1 ? "" : "s"} · ${formatNumber(totalKm)} km total</p>
      <p class="entry-meta">Grouped by driver and collapsed by default. Open a driver to inspect the individual trips.</p>
    </article>
  `;

  return summary + Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([driver, driverTrips]) => {
      const driverKm = round(driverTrips.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0)), 0));
      return `
        <details class="history-group">
          <summary>
            <strong>${escapeHtml(driver)}</strong>
            <span>${driverTrips.length} trip${driverTrips.length === 1 ? "" : "s"} · ${formatNumber(driverKm)} km</span>
          </summary>
          <div class="entry-list grouped-entry-list">
            ${driverTrips.map(renderTripEntryCard).join("")}
          </div>
        </details>
      `;
    })
    .join("");
}

function renderTripEntryCard(trip) {
  const km = round(Number(trip.endKm || 0) - Number(trip.startKm || 0));
  const participants = getTripParticipants(trip);
  const category = getTripCategory(trip);
  return `
    <article class="entry-card">
      <header>
        <strong>${escapeHtml(trip.driver)}</strong>
        ${canManageTripEntry(trip) ? `<div class="entry-actions"><button class="subtle-button compact-button" type="button" data-edit="trips:${trip.id}">Edit</button><button class="text-button compact-button" type="button" data-delete="trips:${trip.id}">Delete</button></div>` : ""}
      </header>
      <p>${formatNumber(km)} km · Total ${formatNumber(trip.endKm)} km <span class="category-chip">${escapeHtml(category)}</span></p>
      <p class="entry-meta">${formatDate(trip.date)} · ${formatNumber(trip.startKm)} to ${formatNumber(trip.endKm)} km</p>
      <p class="entry-meta">Split between ${participants.map(escapeHtml).join(", ")}</p>
      ${trip.note ? `<p>${escapeHtml(trip.note)}</p>` : ""}
    </article>
  `;
}

function renderCategorizedFuel(fuelLogs) {
  const sortedFuel = [...fuelLogs].sort(byNewest);
  const grouped = groupBy(sortedFuel, (fuel) => fuel.payer || "Unknown");
  const totalPaid = roundMoney(sortedFuel.reduce((sum, fuel) => sum + Number(fuel.amount || 0), 0));
  const totalLiters = round(sortedFuel.reduce((sum, fuel) => sum + Number(fuel.liters || 0), 0));
  const summary = `
    <article class="entry-card history-summary-card">
      <strong>Current period fuel log</strong>
      <p>${sortedFuel.length} fuel log${sortedFuel.length === 1 ? "" : "s"} · ${formatMoney(totalPaid)}${totalLiters > 0 ? ` · ${formatNumber(totalLiters)} L` : ""}</p>
      <p class="entry-meta">Grouped by payer and collapsed by default. Open a payer to inspect the individual fuel logs.</p>
    </article>
  `;

  return summary + Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([payer, payerFuel]) => {
      const payerPaid = roundMoney(payerFuel.reduce((sum, fuel) => sum + Number(fuel.amount || 0), 0));
      const payerLiters = round(payerFuel.reduce((sum, fuel) => sum + Number(fuel.liters || 0), 0));
      return `
        <details class="history-group">
          <summary>
            <strong>${escapeHtml(payer)}</strong>
            <span>${payerFuel.length} fuel log${payerFuel.length === 1 ? "" : "s"} · ${formatMoney(payerPaid)}${payerLiters > 0 ? ` · ${formatNumber(payerLiters)} L` : ""}</span>
          </summary>
          <div class="entry-list grouped-entry-list">
            ${payerFuel.map(renderFuelEntryCard).join("")}
          </div>
        </details>
      `;
    })
    .join("");
}

function renderFuelEntryCard(fuel) {
  return `
    <article class="entry-card">
      <header>
        <strong>${escapeHtml(fuel.payer)}</strong>
        ${canManageFuelEntry(fuel) ? `<div class="entry-actions"><button class="subtle-button compact-button" type="button" data-edit="fuel:${fuel.id}">Edit</button><button class="text-button compact-button" type="button" data-delete="fuel:${fuel.id}">Delete</button></div>` : ""}
      </header>
      <p>${formatMoney(fuel.amount)}${Number(fuel.liters || 0) > 0 ? ` · ${formatNumber(fuel.liters)} L` : ""}</p>
      <p class="entry-meta">${formatDate(fuel.date)}${Number(fuel.liters || 0) > 0 ? ` · ${formatMoneyFor(Number(fuel.amount || 0) / Number(fuel.liters || 1), state.currency)}/L` : ""}${fuel.odometer ? ` · ${formatNumber(fuel.odometer)} km` : ""}${fuel.station ? ` · ${escapeHtml(fuel.station)}` : ""}${fuel.location?.latitude && fuel.location?.longitude ? ` · GPS saved` : ""}${fuel.fullTank ? " · full tank" : ""}</p>
    </article>
  `;
}

function getTripCategory(trip) {
  const text = `${trip.note || ""} ${trip.purpose || ""}`.toLowerCase();
  if (text.includes("auto test") || text.includes("stress")) return "Test";
  if (text.includes("fuel") || text.includes("refuel") || text.includes("tank")) return "Fuel";
  if (text.includes("holiday") || text.includes("vacation") || text.includes("weekend")) return "Trip";
  if (text.includes("work") || text.includes("office")) return "Work";
  return "General";
}

function groupBy(items, getKey) {
  return items.reduce((groups, item) => {
    const key = getKey(item);
    groups[key] = groups[key] || [];
    groups[key].push(item);
    return groups;
  }, {});
}

function renderSystemHealth(ledger) {
  if (!els.systemHealthPanel || !els.systemHealthSummary || !els.systemHealthList) return;

  const checks = buildSystemHealthChecks(ledger);
  const counts = checks.reduce(
    (acc, check) => {
      acc[check.level] = (acc[check.level] || 0) + 1;
      return acc;
    },
    { issue: 0, warning: 0, ok: 0 }
  );

  els.systemHealthSummary.innerHTML = `
    <article class="health-summary-card ${counts.issue ? "has-issue" : ""}">
      <span>Needs attention</span>
      <strong>${counts.issue || 0}</strong>
    </article>
    <article class="health-summary-card ${counts.warning ? "has-warning" : ""}">
      <span>Warnings</span>
      <strong>${counts.warning || 0}</strong>
    </article>
    <article class="health-summary-card">
      <span>Looks good</span>
      <strong>${counts.ok || 0}</strong>
    </article>
  `;

  els.systemHealthList.innerHTML = checks
    .map(
      (check) => `
        <article class="health-check ${check.level}">
          <div>
            <strong>${escapeHtml(check.title)}</strong>
            <p>${escapeHtml(check.message)}</p>
          </div>
          <span>${healthLevelLabel(check.level)}</span>
        </article>
      `
    )
    .join("");
}



function renderMemberManagementPanel() {
  if (!els.memberManagementPanel) return;
  const canManage = canManageSettings();
  els.memberManagementPanel.classList.toggle("hidden", !canManage);
  if (!canManage) return;

  if (!memberManagementStatus.loaded && !memberManagementStatus.loading && supabaseClient && currentSession) {
    refreshMemberManagement().catch((error) => {
      memberManagementStatus.error = error.message || String(error);
      renderMemberManagementPanel();
    });
  }

  if (els.memberManagementMessage) {
    els.memberManagementMessage.textContent = memberManagementStatus.loading
      ? "Loading members..."
      : memberManagementStatus.error
        ? `Could not load members: ${memberManagementStatus.error}`
        : "Active members can use the app. Admins can manage settings, diagnostics, and data tools.";
  }

  if (!els.memberManagementList) return;
  const rows = memberManagementStatus.rows || [];
  if (!rows.length && !memberManagementStatus.loading) {
    els.memberManagementList.innerHTML = `<p class="empty-state">No members found in the normalized table.</p>`;
    return;
  }

  const activeAdmins = rows.filter((member) => member.is_active && member.role === "admin");
  const currentEmail = getLoggedInEmail();
  els.memberManagementList.innerHTML = `
    <div class="member-management-header">
      <span>Name</span>
      <span>Email</span>
      <span>MobilePay</span>
      <span>Role</span>
      <span>Status</span>
      <span>Actions</span>
    </div>
    ${rows.map((member) => renderManagedMemberRow(member, activeAdmins.length, currentEmail)).join("")}
  `;
}

function renderManagedMemberRow(member, activeAdminCount, currentEmail) {
  const isSelf = normalizeEmail(member.email || "") === currentEmail;
  const isLastAdmin = member.is_active && member.role === "admin" && activeAdminCount <= 1;
  const statusText = member.is_active ? "Active" : "Inactive";
  const statusClass = member.is_active ? "status-ok" : "status-warning";
  const disableDanger = isSelf || isLastAdmin;
  const dangerTitle = isSelf
    ? "You cannot deactivate or demote yourself here. Add another admin first."
    : isLastAdmin
      ? "At least one active admin is required."
      : "";
  return `
    <div class="member-management-row ${member.is_active ? "" : "inactive"}" data-member-id="${escapeHtml(member.id)}">
      <input class="member-row-name" type="text" value="${escapeHtml(member.name || "")}" />
      <input class="member-row-email" type="email" value="${escapeHtml(member.email || "")}" placeholder="login email" />
      <input class="member-row-mobilepay" type="tel" value="${escapeHtml(formatPhoneDisplay(member.mobilepay_phone || ""))}" placeholder="MobilePay phone" />
      <select class="member-row-role" ${disableDanger ? "data-protect-admin=\"true\"" : ""}>
        <option value="member" ${member.role === "admin" ? "" : "selected"}>Member</option>
        <option value="admin" ${member.role === "admin" ? "selected" : ""}>Admin</option>
      </select>
      <span class="status-pill ${statusClass}">${statusText}</span>
      <div class="button-row compact-actions">
        <button class="subtle-button" type="button" data-member-action="save">Save</button>
        ${member.is_active
          ? `<button class="danger-button" type="button" data-member-action="deactivate" ${disableDanger ? "disabled" : ""} title="${escapeHtml(dangerTitle)}">Deactivate</button>`
          : `<button class="subtle-button" type="button" data-member-action="reactivate">Reactivate</button>`}
      </div>
    </div>
  `;
}

async function refreshMemberManagement() {
  if (!supabaseClient || !currentSession) return;
  memberManagementStatus.loading = true;
  memberManagementStatus.error = "";
  renderMemberManagementPanel();
  const ledgerId = supabaseConfig.ledgerId || "main-car";
  const { data, error } = await supabaseClient
    .from("ledger_members")
    .select("id,ledger_id,name,email,role,is_active,mobilepay_phone,created_at,updated_at")
    .eq("ledger_id", ledgerId)
    .order("is_active", { ascending: false })
    .order("name", { ascending: true });
  memberManagementStatus.loading = false;
  if (error) {
    memberManagementStatus.error = error.message || String(error);
    memberManagementStatus.loaded = true;
    renderMemberManagementPanel();
    return;
  }
  memberManagementStatus.rows = data || [];
  memberManagementStatus.loaded = true;
  renderMemberManagementPanel();
}

function getManagedMemberPayloadFromRow(row) {
  return {
    id: row.dataset.memberId,
    name: row.querySelector(".member-row-name")?.value.trim() || "",
    email: normalizeEmail(row.querySelector(".member-row-email")?.value || "") || null,
    mobilepay_phone: normalizePhone(row.querySelector(".member-row-mobilepay")?.value || "") || null,
    role: row.querySelector(".member-row-role")?.value === "admin" ? "admin" : "member"
  };
}

function protectAgainstAdminLockout(payload, existingMember, nextActive = existingMember?.is_active !== false) {
  const currentEmail = getLoggedInEmail();
  const isSelf = normalizeEmail(existingMember?.email || "") === currentEmail;
  if (isSelf && (!nextActive || payload.role !== "admin")) {
    alert("You cannot deactivate or demote yourself. Add another admin first, then ask that admin to change your role if needed.");
    return false;
  }

  const rows = memberManagementStatus.rows || [];
  const activeAdminsAfter = rows.filter((member) => {
    if (member.id !== existingMember?.id) return member.is_active && member.role === "admin";
    return nextActive && payload.role === "admin";
  });
  if (activeAdminsAfter.length === 0) {
    alert("At least one active admin is required.");
    return false;
  }
  return true;
}

async function saveManagedMember(row) {
  const payload = getManagedMemberPayloadFromRow(row);
  if (!payload.name) {
    alert("Member name is required.");
    return;
  }
  const existing = (memberManagementStatus.rows || []).find((member) => member.id === payload.id);
  if (!protectAgainstAdminLockout(payload, existing, existing?.is_active !== false)) return;

  const { error } = await supabaseClient
    .from("ledger_members")
    .update({
      name: payload.name,
      email: payload.email,
      mobilepay_phone: payload.mobilepay_phone,
      role: payload.role,
      updated_at: new Date().toISOString()
    })
    .eq("id", payload.id);
  if (error) {
    alert(`Could not save member: ${error.message || error}`);
    return;
  }
  await afterMemberManagementChange("Member saved.");
}

async function setManagedMemberActive(row, isActive) {
  const payload = getManagedMemberPayloadFromRow(row);
  const existing = (memberManagementStatus.rows || []).find((member) => member.id === payload.id);
  if (!isActive && !confirm(`Deactivate ${existing?.name || "this member"}? They will no longer be able to access the app.`)) return;
  if (!protectAgainstAdminLockout(payload, existing, isActive)) return;

  const { error } = await supabaseClient
    .from("ledger_members")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", payload.id);
  if (error) {
    alert(`Could not update member: ${error.message || error}`);
    return;
  }
  await afterMemberManagementChange(isActive ? "Member reactivated." : "Member deactivated.");
}

async function addManagedMember() {
  const name = els.newMemberName?.value.trim() || "";
  const email = normalizeEmail(els.newMemberEmail?.value || "");
  const mobilepayPhone = normalizePhone(els.newMemberMobilePayPhone?.value || "");
  const role = els.newMemberRole?.value === "admin" ? "admin" : "member";
  if (!name) {
    alert("Member name is required.");
    return;
  }
  if (!email) {
    alert("Login email is required before inviting a member.");
    return;
  }

  const ledgerId = supabaseConfig.ledgerId || "main-car";
  const { error } = await supabaseClient
    .from("ledger_members")
    .upsert({
      ledger_id: ledgerId,
      name,
      email,
      mobilepay_phone: mobilepayPhone || null,
      role,
      is_active: true,
      updated_at: new Date().toISOString()
    }, { onConflict: "ledger_id,name" });
  if (error) {
    alert(`Could not add member: ${error.message || error}`);
    return;
  }
  if (els.newMemberName) els.newMemberName.value = "";
  if (els.newMemberEmail) els.newMemberEmail.value = "";
  if (els.newMemberMobilePayPhone) els.newMemberMobilePayPhone.value = "";
  if (els.newMemberRole) els.newMemberRole.value = "member";
  await afterMemberManagementChange("Member added.");
}

async function afterMemberManagementChange(message) {
  if (els.memberManagementMessage) els.memberManagementMessage.textContent = message;
  await refreshMemberManagement();
  memberManagementStatus.error = "";
  await loadSupabaseState();
  await refreshDatabaseDiagnostics().catch(() => {});
  await checkNormalizedTablesAgainstCurrentState().catch(() => {});
  render();
}


async function runProductionActivityReset() {
  if (!supabaseClient || !currentSession) {
    alert("Sign in as an admin before resetting production activity.");
    return;
  }
  if (!canManageSettings()) {
    alert("Only an admin can reset production activity.");
    return;
  }
  const warning = [
    "This will permanently delete/reset all activity tables for this ledger:",
    "- trips and trip participants",
    "- fuel logs",
    "- settlement requests",
    "- open and closed settlement periods",
    "",
    "Members, emails, roles, MobilePay phones, and ledger settings are kept.",
    "A JSON backup download will start before the reset."
  ].join("\n");
  if (!confirm(warning)) return;
  const typed = prompt("Type RESET PRODUCTION to delete all activity data and start one fresh empty period.");
  if (typed !== "RESET PRODUCTION") {
    alert("Reset cancelled. The confirmation text did not match.");
    return;
  }

  exportLedgerBackup();

  els.productionActivityReset.disabled = true;
  if (els.authMessage) els.authMessage.textContent = "Resetting production activity...";
  try {
    if (!(await hasFreshSupabaseSession())) throw new Error("Session is not fresh. Sign out and back in if this persists.");
    const ledgerId = supabaseConfig.ledgerId || "main-car";
    const { data, error } = await supabaseClient.rpc("production_activity_reset", { target_ledger_id: ledgerId });
    if (error) throw error;

    state.trips = [];
    state.fuel = [];
    state.closedPeriods = [];
    state.paymentStatuses = {};
    state.lastOdometer = "";
    editTripId = null;
    editFuelId = null;
    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: `Production activity reset complete. New open period ${shortId(data?.open_period_id || "")}.`
    };
    await loadSupabaseState();
    await saveJsonMirrorBackup({ force: true }).catch((error) => console.warn("JSON backup after reset failed", error));
    await refreshDatabaseDiagnostics().catch(() => {});
    await checkNormalizedTablesAgainstCurrentState().catch(() => {});
    setDefaultDates();
    setActiveSection("log");
    if (els.authMessage) els.authMessage.textContent = "Production activity reset complete. You are ready to enter real trips and fuel logs.";
  } catch (error) {
    console.error("Production activity reset failed", error);
    alert(`Production reset failed: ${error.message || error}`);
  } finally {
    els.productionActivityReset.disabled = false;
    render();
  }
}

function renderDatabaseDiagnosticsPanel(ledger) {
  if (!els.databaseDiagnosticsPanel || !els.databaseDiagnosticsList) return;

  if (!supabaseClient) {
    els.databaseDiagnosticsList.innerHTML = `<article class="diagnostic-card warning"><strong>Supabase</strong><p>Supabase is not configured in this build.</p></article>`;
    return;
  }

  if (!databaseDiagnosticsStatus.checked && !databaseDiagnosticsStatus.loading) {
    els.databaseDiagnosticsList.innerHTML = `<article class="diagnostic-card warning"><strong>Not checked yet</strong><p>Click Refresh diagnostics to read the live database tables.</p></article>`;
    return;
  }

  if (databaseDiagnosticsStatus.loading) {
    els.databaseDiagnosticsList.innerHTML = `<article class="diagnostic-card warning"><strong>Loading</strong><p>Reading normalized table counts from Supabase...</p></article>`;
    return;
  }

  if (databaseDiagnosticsStatus.error) {
    els.databaseDiagnosticsList.innerHTML = `<article class="diagnostic-card issue"><strong>Diagnostics failed</strong><p>${escapeHtml(databaseDiagnosticsStatus.error)}</p></article>`;
    return;
  }

  els.databaseDiagnosticsList.innerHTML = databaseDiagnosticsStatus.rows
    .map((row) => `
      <article class="diagnostic-card ${row.level || "ok"}">
        <strong>${escapeHtml(row.title)}</strong>
        <p>${escapeHtml(row.message)}</p>
      </article>
    `)
    .join("");
}


async function getCurrentSettlementRequestContext() {
  if (!supabaseClient || !currentSession) throw new Error("Sign in before checking settlement request rows.");
  if (!(await hasFreshSupabaseSession())) throw new Error("Session is not fresh. Sign out and back in if this persists.");

  const ledgerId = supabaseConfig.ledgerId || "main-car";
  const [membersResult, periodsResult, requestsResult] = await Promise.all([
    supabaseClient.from("ledger_members").select("id,name,email,role,is_active,mobilepay_phone").eq("ledger_id", ledgerId),
    supabaseClient.from("settlement_periods").select("id,status").eq("ledger_id", ledgerId),
    supabaseClient.from("settlement_requests").select("id,period_id,from_member_id,to_member_id,amount,currency,status,requested_at,paid_at,updated_at").eq("ledger_id", ledgerId)
  ]);

  const firstError = [membersResult, periodsResult, requestsResult].find((result) => result.error)?.error;
  if (firstError) throw firstError;

  const activeMembers = (membersResult.data || []).filter((member) => member.is_active !== false);
  const openPeriod = (periodsResult.data || []).find((period) => period.status === "open") || null;
  const activeRequests = (requestsResult.data || []).filter((request) =>
    normalizePaymentStatus(request.status) !== "cancelled" && (!openPeriod || request.period_id === openPeriod.id)
  );
  const currentSettlementPairs = new Set(calculateLedger().settlements.map((settlement) => settlementKey(settlement)));
  const currentRequests = activeRequests.filter((request) => {
    const fromName = activeMembers.find((member) => member.id === request.from_member_id)?.name;
    const toName = activeMembers.find((member) => member.id === request.to_member_id)?.name;
    return fromName && toName && currentSettlementPairs.has(settlementKey({ from: fromName, to: toName, currency: state.currency || "DKK" }));
  });
  const staleRequests = activeRequests.filter((request) => !currentRequests.some((current) => current.id === request.id));

  return { ledgerId, openPeriod, activeMembers, activeRequests, currentRequests, staleRequests };
}

async function cleanStaleSettlementRequests() {
  const { staleRequests } = await getCurrentSettlementRequestContext();
  if (!staleRequests.length) return 0;

  const { error } = await supabaseClient
    .from("settlement_requests")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .in("id", staleRequests.map((request) => request.id));

  if (error) throw error;
  return staleRequests.length;
}

async function refreshDatabaseDiagnostics() {
  if (!supabaseClient || !currentSession) {
    databaseDiagnosticsStatus = {
      checked: true,
      loading: false,
      error: "Sign in before running database diagnostics.",
      rows: []
    };
    render();
    return;
  }

  databaseDiagnosticsStatus = { checked: true, loading: true, error: "", rows: [] };
  render();

  try {
    if (!(await hasFreshSupabaseSession())) throw new Error("Session is not fresh. Sign out and back in if this persists.");
    const ledgerId = supabaseConfig.ledgerId || "main-car";
    const [legacyResult, membersResult, periodsResult, tripsResult, fuelResult, requestsResult] = await Promise.all([
      supabaseClient.from("car_share_ledgers").select("state,updated_at").eq("id", ledgerId).maybeSingle(),
      supabaseClient.from("ledger_members").select("id,name,email,role,is_active,mobilepay_phone,updated_at").eq("ledger_id", ledgerId),
      supabaseClient.from("settlement_periods").select("id,status,label,opened_at,closed_at,created_at,updated_at").eq("ledger_id", ledgerId),
      supabaseClient.from("trips").select("id,period_id,deleted_at,created_at,updated_at").eq("ledger_id", ledgerId),
      supabaseClient.from("fuel_payments").select("id,period_id,deleted_at,created_at,updated_at").eq("ledger_id", ledgerId),
      supabaseClient.from("settlement_requests").select("id,period_id,from_member_id,to_member_id,amount,currency,status,requested_at,paid_at,updated_at").eq("ledger_id", ledgerId)
    ]);

    const firstError = [legacyResult, membersResult, periodsResult, tripsResult, fuelResult, requestsResult].find((result) => result.error)?.error;
    if (firstError) throw firstError;

    const legacyState = normalizeState(legacyResult.data?.state || {});
    const members = membersResult.data || [];
    const activeMembers = members.filter((member) => member.is_active !== false);
    const admins = activeMembers.filter((member) => member.role === "admin");
    const missingEmail = activeMembers.filter((member) => !member.email);
    const periods = periodsResult.data || [];
    const openPeriods = periods.filter((period) => period.status === "open");
    const openPeriod = openPeriods[0] || null;
    const trips = tripsResult.data || [];
    const fuel = fuelResult.data || [];
    const openTrips = trips.filter((trip) => !trip.deleted_at && (!openPeriod || !trip.period_id || trip.period_id === openPeriod.id));
    const openFuel = fuel.filter((item) => !item.deleted_at && (!openPeriod || !item.period_id || item.period_id === openPeriod.id));
    const softDeletedTrips = trips.filter((trip) => trip.deleted_at).length;
    const softDeletedFuel = fuel.filter((item) => item.deleted_at).length;
    const requests = requestsResult.data || [];
    const activeRequests = requests.filter((request) => normalizePaymentStatus(request.status) !== "cancelled" && (!openPeriod || request.period_id === openPeriod.id));
    const currentSettlementPairs = new Set(calculateLedger().settlements.map((settlement) => settlementKey(settlement)));
    const currentRequests = activeRequests.filter((request) => {
      const fromName = activeMembers.find((member) => member.id === request.from_member_id)?.name;
      const toName = activeMembers.find((member) => member.id === request.to_member_id)?.name;
      return fromName && toName && currentSettlementPairs.has(settlementKey({ from: fromName, to: toName, currency: state.currency || "DKK" }));
    });
    const requestedCurrentRows = currentRequests.filter((request) => ["requested", "paid"].includes(normalizePaymentStatus(request.status))).length;
    const visibleRequested = calculateLedger().settlements.filter(
      (settlement) => ["requested", "paid"].includes(normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]))
    ).length;
    const staleRequestRows = activeRequests.length - currentRequests.length;
    const lastTableWrite = [
      ...members.map((row) => row.updated_at),
      ...periods.map((row) => row.updated_at),
      ...trips.map((row) => row.updated_at),
      ...fuel.map((row) => row.updated_at),
      ...requests.map((row) => row.updated_at)
    ].filter(Boolean).sort().pop() || "";

    const rows = [
      {
        level: normalizedReadModeActive ? "ok" : "warning",
        title: "Read mode",
        message: normalizedReadModeActive
          ? "The app is reading normalized tables first. JSON is fallback/backup."
          : "The app is not currently in normalized read-first mode."
      },
      {
        level: openPeriods.length === 1 ? "ok" : "warning",
        title: "Open period",
        message: openPeriod
          ? `${openPeriods.length} open period. Active ID ${shortId(openPeriod.id)} · ${openPeriod.label || "Current period"}.`
          : `${openPeriods.length} open periods found. The app needs exactly one.`
      },
      {
        level: activeMembers.length === state.members.length && admins.length && !missingEmail.length ? "ok" : "warning",
        title: "Members",
        message: `${activeMembers.length} active table members; ${state.members.length} visible in app; ${admins.length} admin; ${missingEmail.length} missing email.`
      },
      {
        level: openTrips.length === state.trips.length ? "ok" : "warning",
        title: "Trips",
        message: `${openTrips.length} open-period table trips; ${state.trips.length} visible in app; ${softDeletedTrips} soft-deleted rows kept for audit/history.`
      },
      {
        level: openFuel.length === state.fuel.length ? "ok" : "warning",
        title: "Fuel logs",
        message: `${openFuel.length} open-period table fuel logs; ${state.fuel.length} visible in app; ${softDeletedFuel} soft-deleted rows kept for audit/history.`
      },
      {
        level: requestedCurrentRows === visibleRequested && staleRequestRows === 0 ? "ok" : "warning",
        title: "Settlement requests",
        message: `${requestedCurrentRows} requested/paid current table rows; ${visibleRequested} visible requested/paid payments; ${staleRequestRows} stale active request row${staleRequestRows === 1 ? "" : "s"}${staleRequestRows ? " (safe to clean)" : ""}.`
      },
      {
        level: legacyState.trips.length === state.trips.length && legacyState.fuel.length === state.fuel.length ? "ok" : "warning",
        title: "JSON backup snapshot",
        message: `JSON snapshot has ${legacyState.members.length} members, ${legacyState.trips.length} trips, ${legacyState.fuel.length} fuel logs. Current app has ${state.members.length}, ${state.trips.length}, ${state.fuel.length}. It is now a manual/periodic safety backup, not the primary save target.`
      },
      {
        level: lastTableWrite ? "ok" : "warning",
        title: "Last table write",
        message: lastTableWrite
          ? `Latest normalized row update: ${new Date(lastTableWrite).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}. Last JSON backup snapshot: ${legacyResult.data?.updated_at ? new Date(legacyResult.data.updated_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "unknown"}.`
          : "No updated_at values found in normalized tables."
      }
    ];

    databaseDiagnosticsStatus = { checked: true, loading: false, error: "", rows };
  } catch (error) {
    console.warn("Database diagnostics failed", error);
    databaseDiagnosticsStatus = {
      checked: true,
      loading: false,
      error: error.message || String(error),
      rows: []
    };
  }

  render();
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 8 ? `${text.slice(0, 8)}...` : text || "none";
}

function buildSystemHealthChecks(ledger) {
  const checks = [];
  const profiles = getMemberNames().map(getMemberProfile);
  const membersWithoutEmail = profiles.filter((profile) => !profile.email);
  const nonAdminProfiles = profiles.filter((profile) => profile.role !== "admin");
  const adminProfiles = profiles.filter((profile) => profile.role === "admin");
  const fuelWithMissingLiters = state.fuel.filter((fuel) => Number(fuel.amount || 0) >= 300 && !Number(fuel.liters || 0));
  const suspiciousPriceLogs = state.fuel.filter((fuel) => {
    const amount = Number(fuel.amount || 0);
    const liters = Number(fuel.liters || 0);
    if (!amount || !liters) return false;
    const price = amount / liters;
    return price < 8 || price > 25;
  });
  const unusualTrips = state.trips.filter((trip) => {
    const km = Number(trip.endKm || 0) - Number(trip.startKm || 0);
    return km <= 0 || km > 1500;
  });
  const openFuelWarnings = getFuelValidationWarnings(ledger);
  const currentPeriodHasData = state.trips.length > 0 || state.fuel.length > 0;
  const pushSubscriptionHint = pushEnabled
    ? "Push notifications are enabled on this device."
    : pushSupported
      ? "Push is supported, but not enabled on this device yet."
      : "Push is not enabled or not supported on this device/browser.";

  checks.push({
    level: currentSession ? "ok" : "issue",
    title: "Authentication",
    message: currentSession ? `Signed in as ${getLoggedInEmail()}.` : "Nobody is signed in, so changes cannot be saved to cloud."
  });

  const syncStatus = els.syncStatus?.dataset.status || "";
  const databaseSaveOk = ["cloud", "tables", "shared"].includes(syncStatus);
  checks.push({
    level: databaseSaveOk ? "ok" : (syncStatus === "saving" || syncStatus === "syncing" ? "warning" : "issue"),
    title: "Database saving",
    message: lastCloudSaveAt
      ? `Last database save: ${new Date(lastCloudSaveAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}. ${normalizedReadModeActive ? "Normalized tables are the primary save target; JSON is only a backup snapshot." : "Cloud JSON is the current save target."}`
      : lastSyncError
        ? `Last save/load error: ${lastSyncError}.`
        : "No confirmed database save yet in this session."
  });

  checks.push({
    level: adminProfiles.length ? "ok" : "issue",
    title: "Admin users",
    message: adminProfiles.length
      ? `${adminProfiles.map((profile) => profile.name).join(", ")} can manage settings and data tools.`
      : "No admin user is configured. Add one in Group settings."
  });

  checks.push({
    level: membersWithoutEmail.length ? "warning" : "ok",
    title: "People with email",
    message: membersWithoutEmail.length
      ? `${membersWithoutEmail.map((profile) => profile.name).join(", ")} ${membersWithoutEmail.length === 1 ? "has" : "have"} no email attached.`
      : `${nonAdminProfiles.length + adminProfiles.length} people have email/profile data configured.`
  });

  checks.push({
    level: fuelWithMissingLiters.length ? "warning" : "ok",
    title: "Fuel logs with liters",
    message: fuelWithMissingLiters.length
      ? `${fuelWithMissingLiters.length} current fuel payment${fuelWithMissingLiters.length === 1 ? "" : "s"} over 300 DKK ${fuelWithMissingLiters.length === 1 ? "is" : "are"} missing liters.`
      : "Current fuel logs have liters where it matters, or there are no large fuel logs missing liters."
  });

  checks.push({
    level: suspiciousPriceLogs.length ? "warning" : "ok",
    title: "Receipt price checks",
    message: suspiciousPriceLogs.length
      ? `${suspiciousPriceLogs.length} fuel log${suspiciousPriceLogs.length === 1 ? "" : "s"} have unusual DKK/L values. Check amount and liters.`
      : "No current fuel logs have suspicious DKK/L values."
  });

  checks.push({
    level: unusualTrips.length ? "warning" : "ok",
    title: "Trip distance checks",
    message: unusualTrips.length
      ? `${unusualTrips.length} trip${unusualTrips.length === 1 ? "" : "s"} look unusual. Check odometer values and very long test trips.`
      : "Current trip distances look plausible."
  });

  checks.push({
    level: openFuelWarnings.length ? "warning" : "ok",
    title: "Open settlement fuel sanity",
    message: openFuelWarnings.length
      ? `${openFuelWarnings.length} fuel sanity warning${openFuelWarnings.length === 1 ? "" : "s"} in the current period. Review before requesting settlement.`
      : currentPeriodHasData
        ? "Current period fuel amount looks plausible against distance and settings."
        : "No current trips or fuel payments to validate."
  });

  checks.push({
    level: pushEnabled ? "ok" : (pushSupported ? "warning" : "warning"),
    title: "Push notifications on this device",
    message: pushSubscriptionHint
  });

  if (normalizedTableStatus.details && normalizedTableStatus.details.length) {
    normalizedTableStatus.details.forEach((detail) => checks.push(detail));
  } else {
    checks.push({
      level: normalizedTableStatus.checked ? (normalizedTableStatus.ok ? "ok" : "warning") : "warning",
      title: "Normalized database tables",
      message: normalizedTableStatus.message
    });
  }

  checks.push({
    level: state.closedPeriods.length ? "ok" : "warning",
    title: "Archive history",
    message: state.closedPeriods.length
      ? `${state.closedPeriods.length} closed settlement period${state.closedPeriods.length === 1 ? "" : "s"} archived.`
      : "No closed periods yet. Close periods regularly to keep settlements clean."
  });

  return checks;
}

function healthLevelLabel(level) {
  if (level === "issue") return "Fix";
  if (level === "warning") return "Check";
  return "OK";
}

function renderClosedPeriods() {
  if (state.closedPeriods.length === 0) {
    els.periodList.replaceChildren(emptyNode("No closed periods yet."));
    return;
  }

  els.periodList.innerHTML = state.closedPeriods
    .map((period) => renderClosedPeriodCard(period))
    .join("");
}

function renderClosedPeriodCard(period) {
  const currency = period.currency || state.currency;
  const trips = Array.isArray(period.trips) ? period.trips : [];
  const fuel = Array.isArray(period.fuel) ? period.fuel : [];
  const settlements = Array.isArray(period.settlements) ? period.settlements : [];
  const people = Array.isArray(period.people) ? period.people : [];
  const paidSettlements = settlements.filter((settlement) => normalizePaymentStatus(settlement.status) === "paid");
  const requestedSettlements = settlements.filter((settlement) => normalizePaymentStatus(settlement.status) === "requested");
  const openSettlements = settlements.filter((settlement) => normalizePaymentStatus(settlement.status) === "open");
  const paidAmount = paidSettlements.reduce((sum, settlement) => sum + Number(settlement.amount || 0), 0);
  const requestedAmount = requestedSettlements.reduce((sum, settlement) => sum + Number(settlement.amount || 0), 0);
  const openAmount = openSettlements.reduce((sum, settlement) => sum + Number(settlement.amount || 0), 0);
  const totalLiters = fuel.reduce((sum, item) => sum + Number(item.liters || 0), 0);
  const totalFuelPaid = Number(period.totalPaid || fuel.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const totalTripKm = Number(period.totalTripKm || trips.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0)), 0));
  const participantKm = Number(period.totalKm || 0);
  const closedDate = period.closedAt ? formatDate(String(period.closedAt).slice(0, 10)) : "Unknown date";

  return `
    <details class="period-card archived-period-card">
      <summary>
        <div>
          <strong>${escapeHtml(period.label || "Closed period")}</strong>
          <p>Closed ${closedDate} · ${trips.length} trip${trips.length === 1 ? "" : "s"} · ${fuel.length} fuel log${fuel.length === 1 ? "" : "s"}</p>
        </div>
        <span>${formatMoneyFor(totalFuelPaid, currency)} fuel</span>
      </summary>

      <div class="archive-actions button-row compact-actions">
        <button class="subtle-button compact-button" type="button" data-archive-report="${escapeHtml(period.id)}">Download report</button>
      </div>

      <div class="period-stats archive-period-stats">
        <div><span>Trip km</span><b>${formatNumber(totalTripKm)} km</b></div>
        <div><span>Participant km</span><b>${formatNumber(participantKm)} km</b></div>
        <div><span>Fuel rate</span><b>${formatMoneyFor(period.fuelRate || 0, currency)}/km</b></div>
        <div><span>Fuel paid</span><b>${formatMoneyFor(totalFuelPaid, currency)}</b></div>
        <div><span>Liters</span><b>${totalLiters > 0 ? `${formatNumber(totalLiters)} L` : "-"}</b></div>
        <div><span>Final payments</span><b>${settlements.length}</b></div>
      </div>

      <div class="archive-status-grid">
        <div class="archive-status-card paid"><span>Paid</span><b>${paidSettlements.length} · ${formatMoneyFor(paidAmount, currency)}</b></div>
        <div class="archive-status-card requested"><span>Requested</span><b>${requestedSettlements.length} · ${formatMoneyFor(requestedAmount, currency)}</b></div>
        <div class="archive-status-card open"><span>Open at close</span><b>${openSettlements.length} · ${formatMoneyFor(openAmount, currency)}</b></div>
      </div>

      <details class="archive-subsection" open>
        <summary>Final payments</summary>
        ${renderPeriodSettlements(period)}
      </details>

      <details class="archive-subsection">
        <summary>Activity by person</summary>
        ${renderClosedPeriodPeople(people, currency)}
      </details>

      <details class="archive-subsection">
        <summary>Trips (${trips.length})</summary>
        ${renderClosedPeriodTrips(trips)}
      </details>

      <details class="archive-subsection">
        <summary>Fuel logs (${fuel.length})</summary>
        ${renderClosedPeriodFuel(fuel, currency)}
      </details>
    </details>
  `;
}

function renderPeriodSettlements(period) {
  const settlements = Array.isArray(period.settlements) ? period.settlements : [];
  if (settlements.length === 0) {
    return `<p class="entry-meta">No payments were needed.</p>`;
  }

  return `
    <div class="period-settlements archive-payment-list">
      ${settlements
        .map(
          (settlement) => `
            <div>
              <span>${escapeHtml(settlement.from)} pays ${escapeHtml(settlement.to)}</span>
              <b>${formatMoneyFor(settlement.amount, period.currency || state.currency)}</b>
              <span class="status-chip ${normalizePaymentStatus(settlement.status)}">${statusLabel(settlement.status)}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderClosedPeriodPeople(people, currency) {
  if (!Array.isArray(people) || people.length === 0) {
    return `<p class="entry-meta">No per-person activity was saved for this period.</p>`;
  }

  return `
    <div class="archive-table-wrap">
      <table class="activity-table archive-activity-table">
        <thead><tr><th>Person</th><th>Distance share</th><th>Fuel share</th><th>Fuel paid</th></tr></thead>
        <tbody>
          ${people.map((person) => `
            <tr>
              <td><strong>${escapeHtml(person.name)}</strong></td>
              <td>${formatNumber(person.km || 0)} km</td>
              <td>${formatMoneyFor(person.fuelShare || 0, currency)}</td>
              <td>${formatMoneyFor(person.fuelPaid || 0, currency)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderClosedPeriodTrips(trips) {
  if (!Array.isArray(trips) || trips.length === 0) {
    return `<p class="entry-meta">No trips saved in this period.</p>`;
  }
  const grouped = groupBy([...trips].sort(byNewest), (trip) => trip.driver || "Unknown");
  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([driver, items]) => {
      const km = items.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0)), 0);
      return `
        <details class="history-group archive-entry-group">
          <summary><strong>${escapeHtml(driver)}</strong><span>${items.length} trip${items.length === 1 ? "" : "s"} · ${formatNumber(km)} km</span></summary>
          <div class="entry-list grouped-entry-list">
            ${items.map((trip) => {
              const tripKm = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
              return `
                <article class="entry-card archive-entry-card">
                  <strong>${escapeHtml(trip.driver || "Unknown")}</strong>
                  <p>${formatNumber(tripKm)} km · ${formatDate(trip.date)} · ${formatNumber(trip.startKm || 0)} to ${formatNumber(trip.endKm || 0)} km</p>
                  <p class="entry-meta">Split between ${getTripParticipants(trip).map(escapeHtml).join(", ")}</p>
                  ${trip.note ? `<p>${escapeHtml(trip.note)}</p>` : ""}
                </article>
              `;
            }).join("")}
          </div>
        </details>
      `;
    })
    .join("");
}

function renderClosedPeriodFuel(fuel, currency) {
  if (!Array.isArray(fuel) || fuel.length === 0) {
    return `<p class="entry-meta">No fuel logs saved in this period.</p>`;
  }
  const grouped = groupBy([...fuel].sort(byNewest), (item) => item.payer || "Unknown");
  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([payer, items]) => {
      const amount = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      const liters = items.reduce((sum, item) => sum + Number(item.liters || 0), 0);
      return `
        <details class="history-group archive-entry-group">
          <summary><strong>${escapeHtml(payer)}</strong><span>${items.length} fuel log${items.length === 1 ? "" : "s"} · ${formatMoneyFor(amount, currency)}${liters > 0 ? ` · ${formatNumber(liters)} L` : ""}</span></summary>
          <div class="entry-list grouped-entry-list">
            ${items.map((item) => {
              const itemLiters = Number(item.liters || 0);
              const price = itemLiters > 0 ? `${formatNumber(itemLiters)} L · ${formatMoneyFor(Number(item.amount || 0) / itemLiters, currency)}/L` : "No liters logged";
              return `
                <article class="entry-card archive-entry-card">
                  <strong>${escapeHtml(item.payer || "Unknown")}</strong>
                  <p>${formatMoneyFor(item.amount || 0, currency)} · ${price}</p>
                  <p class="entry-meta">${formatDate(item.date)}${item.odometer ? ` · ${formatNumber(item.odometer)} km` : ""}${item.station ? ` · ${escapeHtml(item.station)}` : ""}</p>
                </article>
              `;
            }).join("")}
          </div>
        </details>
      `;
    })
    .join("");
}

function buildSettlements(people) {
  const debtors = [];
  const creditors = [];

  for (const [name, person] of Object.entries(people)) {
    if (person.net < -0.005) debtors.push({ name, amount: Math.abs(person.net) });
    if (person.net > 0.005) creditors.push({ name, amount: person.net });
  }

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const settlements = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = roundMoney(Math.min(debtor.amount, creditor.amount));

    if (amount > 0) {
      settlements.push({ from: debtor.name, to: creditor.name, amount });
    }

    debtor.amount = roundMoney(debtor.amount - amount);
    creditor.amount = roundMoney(creditor.amount - amount);

    if (debtor.amount <= 0.005) debtorIndex += 1;
    if (creditor.amount <= 0.005) creditorIndex += 1;
  }

  return settlements;
}

function setDefaultDates() {
  const today = localDateString();
  els.tripDate.max = today;
  els.fuelDate.max = today;
  els.tripDate.value = today;
  els.fuelDate.value = today;
  syncStartOdometerDefault();
}

function getSelectedParticipants() {
  return Array.from(els.tripParticipants.querySelectorAll("input:checked")).map((input) => input.value);
}

function getTripParticipants(trip) {
  if (Array.isArray(trip.participants) && trip.participants.length > 0) {
    return [...new Set(trip.participants)];
  }

  return trip.driver ? [trip.driver] : [];
}

function getMemberNames() {
  return Array.isArray(state.members) ? state.members : [];
}

function normalizeMembers(members) {
  if (!Array.isArray(members) || members.length === 0) return structuredClone(defaults.members);
  return members
    .map((member) => (typeof member === "string" ? member : member?.name))
    .map((member) => String(member || "").trim())
    .filter(Boolean);
}

function normalizeMemberProfiles(members, profiles) {
  const names = normalizeMembers(members);
  const sourceProfiles = profiles && typeof profiles === "object" ? profiles : {};
  return Object.fromEntries(
    names.map((name, index) => {
      const inline = Array.isArray(members) ? members.find((member) => member?.name === name) : null;
      const saved = sourceProfiles[name] || inline || {};
      return [
        name,
        {
          email: normalizeEmail(saved.email || ""),
          role: saved.role === "admin" || (index === 0 && !profiles) ? "admin" : "member",
          mobilepayPhone: normalizePhone(saved.mobilepayPhone || saved.mobilepay_phone || "")
        }
      ];
    })
  );
}

function getMemberProfile(name) {
  const profile = state.memberProfiles?.[name] || {};
  return { name, email: normalizeEmail(profile.email || ""), role: profile.role === "admin" ? "admin" : "member", mobilepayPhone: normalizePhone(profile.mobilepayPhone || profile.mobilepay_phone || "") };
}

function getLoggedInEmail() {
  return normalizeEmail(currentSession?.user?.email || "");
}

function getCurrentMemberProfile() {
  const email = getLoggedInEmail();
  if (!email) return null;

  const match = getMemberNames()
    .map(getMemberProfile)
    .find((profile) => profile.email === email);
  if (match) return match;

  if (noMemberEmailsConfigured()) {
    const first = getMemberNames()[0];
    return first ? { ...getMemberProfile(first), role: "admin" } : null;
  }

  return null;
}

function canUseAppAsMember() {
  if (!supabaseClient) return true;
  return Boolean(currentSession && getCurrentMemberProfile());
}

function canManageSettings() {
  if (!supabaseClient) return true;
  if (!currentSession) return false;
  const profile = getCurrentMemberProfile();
  return profile?.role === "admin" || noMemberEmailsConfigured();
}

function canManageSettlementRequest(settlement) {
  if (!supabaseClient) return true;
  const profile = getCurrentMemberProfile();
  return Boolean(profile && settlement?.to === profile.name);
}

function canMarkSettlementPaid(settlement) {
  if (!supabaseClient) return true;
  const profile = getCurrentMemberProfile();
  return Boolean(profile && settlement?.from === profile.name);
}

function noMemberEmailsConfigured() {
  return getMemberNames().every((name) => !getMemberProfile(name).email);
}


function ensureMemberForLoggedInUser() {
  const email = getLoggedInEmail();
  if (!email) return false;

  const existing = getMemberNames()
    .map(getMemberProfile)
    .find((profile) => profile.email === email);
  if (existing) return false;

  const names = getMemberNames();
  const inferredName = inferMemberNameFromEmail(email);

  let targetName = "";
  if (noMemberEmailsConfigured() && names[0]) {
    targetName = names[0];
  } else {
    targetName = findBestUnassignedMemberName(inferredName, email);
  }

  if (!targetName) {
    targetName = makeUniqueMemberName(inferredName || email.split("@")[0] || "New member");
    state.members.push(targetName);
  }

  const current = getMemberProfile(targetName);
  const role = noMemberEmailsConfigured() && targetName === names[0] ? "admin" : current.role;
  state.memberProfiles[targetName] = {
    ...current,
    email,
    role: role === "admin" ? "admin" : "member",
    mobilepayPhone: normalizePhone(current.mobilepayPhone || "")
  };
  currentUser = targetName;
  localStorage.setItem(userKey, currentUser);
  els.authMessage.textContent = `Signed in as ${targetName}.`;
  return true;
}

function inferMemberNameFromEmail(email) {
  const local = email.split("@")[0] || "";
  const clean = local
    .replace(/[+].*$/, "")
    .replace(/[._-]+/g, " ")
    .replace(/\d+/g, " ")
    .trim();

  if (!clean) return "New member";

  return clean
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function findBestUnassignedMemberName(inferredName, email) {
  const localFirst = normalizeEmail(email.split("@")[0].split(/[._-]/)[0] || "");
  const inferredFirst = normalizeEmail((inferredName || "").split(/\s+/)[0] || "");

  return getMemberNames().find((name) => {
    const profile = getMemberProfile(name);
    if (profile.email) return false;
    const normalizedName = normalizeEmail(name);
    return normalizedName === normalizeEmail(inferredName) || normalizedName === localFirst || normalizedName === inferredFirst;
  }) || "";
}

function makeUniqueMemberName(baseName) {
  const existing = new Set(getMemberNames().map((name) => normalizeEmail(name)));
  let candidate = baseName.trim() || "New member";
  let counter = 2;
  while (existing.has(normalizeEmail(candidate))) {
    candidate = `${baseName} ${counter}`;
    counter += 1;
  }
  return candidate;
}

function parseMemberSettings(value) {
  return value
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      const name = parts[0];
      const email = normalizeEmail(parts.find((part, index) => index > 0 && part.includes("@")) || "");
      const role = parts.some((part) => part.toLowerCase() === "admin") ? "admin" : "member";
      return { name, email, role };
    })
    .filter((member) => member.name);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return normalizeState(saved);
  } catch {
    return structuredClone(defaults);
  }
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
  queueRemoteSave();
}

function makeClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeTripEntries(trips) {
  if (!Array.isArray(trips)) return [];

  return trips.map((trip) => ({
    ...trip,
    id: trip.id || makeClientId(),
    participants: Array.isArray(trip.participants) ? trip.participants : (trip.driver ? [trip.driver] : []),
    startKm: round(Number(trip.startKm || 0)),
    endKm: round(Number(trip.endKm || 0)),
    note: trip.note ? String(trip.note) : ""
  }));
}

function normalizeState(saved) {
  if (!saved) return structuredClone(defaults);

  return {
    ...structuredClone(defaults),
    ...saved,
    members: normalizeMembers(saved.members),
    memberProfiles: normalizeMemberProfiles(saved.members, saved.memberProfiles),
    trips: normalizeTripEntries(saved.trips),
    fuel: normalizeFuelEntries(saved.fuel),
    paymentStatuses: normalizePaymentStatuses(saved.paymentStatuses),
    currentPeriodId: saved.currentPeriodId || "",
    closedPeriods: Array.isArray(saved.closedPeriods)
      ? saved.closedPeriods.map((period) => ({
          ...period,
          settlements: Array.isArray(period.settlements)
            ? period.settlements.map((settlement) => ({
                ...settlement,
                status: normalizePaymentStatus(settlement.status)
              }))
            : []
        }))
      : [],
    lastOdometer: saved.lastOdometer ?? "",
    fuelType: getFuelTypeForState(saved),
    fuelConsumption: getFuelConsumptionForState(saved),
    fuelFallbackPrice: getFuelFallbackPriceForState(saved),
    fuelWarningThreshold: Number(saved.fuelWarningThreshold) || defaults.fuelWarningThreshold,
    carSettingsVersion: saved.carSettingsVersion || defaults.carSettingsVersion
  };
}

function normalizeFuelLocation(location) {
  if (!location || typeof location !== "object") return null;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function normalizeFuelEntries(fuelEntries) {
  if (!Array.isArray(fuelEntries)) return [];

  return fuelEntries.map((fuel) => {
    const amount = roundMoney(Number(fuel.amount || 0));
    const liters = Number(fuel.liters || 0) > 0 ? round(Number(fuel.liters || 0)) : "";
    return {
      ...fuel,
      id: fuel.id || makeClientId(),
      amount,
      liters,
      pricePerLiter: liters ? roundMoney(amount / liters) : (Number(fuel.pricePerLiter || 0) > 0 ? roundMoney(Number(fuel.pricePerLiter)) : ""),
      odometer: Number(fuel.odometer || 0) > 0 ? round(Number(fuel.odometer || 0)) : "",
      station: fuel.station ? String(fuel.station).trim() : "",
      location: normalizeFuelLocation(fuel.location),
      stationInfo: normalizeFuelLocation(fuel.stationInfo)
        ? {
            ...normalizeFuelLocation(fuel.stationInfo),
            name: fuel.stationInfo?.name ? String(fuel.stationInfo.name).trim() : (fuel.station ? String(fuel.station).trim() : ""),
            brand: fuel.stationInfo?.brand ? String(fuel.stationInfo.brand).trim() : ""
          }
        : null,
      fullTank: Boolean(fuel.fullTank)
    };
  });
}

function isOldDefaultFuelSetup(saved) {
  return (
    !saved.carSettingsVersion &&
    (!saved.fuelType || saved.fuelType === "95") &&
    (!saved.fuelConsumption || Number(saved.fuelConsumption) === 6) &&
    (!saved.fuelFallbackPrice || Number(saved.fuelFallbackPrice) === 16.5)
  );
}

function getFuelTypeForState(saved) {
  if (isOldDefaultFuelSetup(saved)) return defaults.fuelType;
  return saved.fuelType || defaults.fuelType;
}

function getFuelConsumptionForState(saved) {
  if (isOldDefaultFuelSetup(saved)) return defaults.fuelConsumption;
  return Number(saved.fuelConsumption) || defaults.fuelConsumption;
}

function getFuelFallbackPriceForState(saved) {
  if (isOldDefaultFuelSetup(saved)) return defaults.fuelFallbackPrice;
  return Number(saved.fuelFallbackPrice) || defaults.fuelFallbackPrice;
}


async function initializePwa() {
  pushSupported = Boolean("serviceWorker" in navigator && "PushManager" in window && "Notification" in window);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updatePwaUi();
  });

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("/service-worker.js");
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  }

  await refreshPushState();
  updatePwaUi();
}

async function refreshPushState() {
  if (!pushSupported) {
    pushEnabled = false;
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    pushEnabled = Boolean(subscription && Notification.permission === "granted");
  } catch {
    pushEnabled = false;
  }
}

function updatePwaUi() {
  if (!els.pwaPanel) return;

  if (!currentSession) {
    els.pwaPanel.classList.add("hidden");
    return;
  }

  els.pwaPanel.classList.remove("hidden");
  els.installApp?.classList.toggle("hidden", !deferredInstallPrompt);

  if (!pushSupported) {
    els.enablePush.disabled = true;
    els.enablePush.textContent = "Notifications unavailable";
    els.pwaMessage.textContent = "This browser does not support web push notifications. You can still use the app normally.";
    return;
  }

  if (pushEnabled) {
    els.enablePush.disabled = true;
    els.enablePush.textContent = "Notifications enabled";
    els.pwaMessage.textContent = "Payment request notifications are enabled on this device.";
    return;
  }

  if (Notification.permission === "denied") {
    els.enablePush.disabled = true;
    els.enablePush.textContent = "Notifications blocked";
    els.pwaMessage.textContent = "Notifications are blocked in this browser. Enable them in browser settings to receive payment alerts.";
    return;
  }

  els.enablePush.disabled = false;
  els.enablePush.textContent = "Enable notifications";
  els.pwaMessage.textContent = isIosDevice()
    ? "On iPhone, add Fuel Ledger to your Home Screen first, then open it from there and enable notifications."
    : "Enable notifications to get a phone alert when someone requests a payment from you.";
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent || "");
}

async function enablePushNotifications() {
  if (!supabaseClient) {
    alert("Cloud login is not configured yet.");
    return;
  }

  const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
  const session = sessionData?.session;
  const accessToken = session?.access_token;

  if (sessionError || !session || !accessToken) {
    currentSession = null;
    updateAuthUi();
    alert("Please sign in again before enabling notifications.");
    return;
  }

  currentSession = session;

  if (!pushSupported) {
    alert("This browser does not support web push notifications.");
    updatePwaUi();
    return;
  }

  try {
    const configResponse = await fetch(pushConfigUrl);
    const config = await configResponse.json();
    if (!config.enabled || !config.publicKey) {
      alert("Push notifications are not configured on the server yet.");
      updatePwaUi();
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      updatePwaUi();
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey)
      });
    }

    const response = await fetch(pushSubscriptionsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ subscription })
    });

    if (!response.ok) throw new Error(await response.text());
    pushEnabled = true;
    updatePwaUi();
  } catch (error) {
    console.error(error);
    alert("Could not enable notifications yet. Please sign in again and try once more. If it still fails, check the Render logs.");
    await refreshPushState();
    updatePwaUi();
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function sendSettlementPush(settlement) {
  if (!supabaseClient || !settlement) return;

  const { data: sessionData } = await supabaseClient.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) return;

  const targetEmail = getMemberProfile(settlement.from).email;
  if (!targetEmail) return;

  const title = "Fuel Ledger payment request";
  const body = `${settlement.to} requested ${formatMoney(settlement.amount)} from you for shared car fuel.`;

  try {
    await fetch(sendPushUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        targetEmail,
        title,
        body,
        url: `${window.location.origin}/`,
        tag: settlementKey(settlement)
      })
    });
  } catch (error) {
    console.warn("Push notification failed", error);
  }
}



async function hasFreshSupabaseSession() {
  if (!supabaseClient) return false;
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data?.session?.access_token) {
    currentSession = null;
    updateAuthUi();
    return false;
  }
  currentSession = data.session;
  return true;
}

function normalizedDate(value) {
  return String(value || localDateString()).slice(0, 10);
}

function nullableNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}



async function ensureOpenSettlementPeriod(ledgerId) {
  const existing = await supabaseClient
    .from("settlement_periods")
    .select("id")
    .eq("ledger_id", ledgerId)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.id) return existing.data.id;

  const created = await supabaseClient
    .from("settlement_periods")
    .insert({ ledger_id: ledgerId, status: "open", label: "Current period" })
    .select("id")
    .single();

  if (!created.error && created.data?.id) return created.data.id;

  // Another tab/device may have created the open period between our select and insert.
  // The database correctly rejects a second open period, so re-select and continue.
  if (created.error?.code === "23505") {
    const retry = await supabaseClient
      .from("settlement_periods")
      .select("id")
      .eq("ledger_id", ledgerId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (retry.error) throw retry.error;
    if (retry.data?.id) return retry.data.id;
  }

  throw created.error || new Error("Could not create an open settlement period");
}

async function getNormalizedWriteContext() {
  if (!supabaseClient || !currentSession) return null;
  if (!(await hasFreshSupabaseSession())) return null;

  const ledgerId = supabaseConfig.ledgerId || "main-car";

  // Important: regular members are allowed to write trips, fuel, and settlement
  // request rows, but they are not allowed to update ledger settings or the
  // member directory. Do not upsert ledgers/ledger_members here for every save,
  // otherwise non-admin trip/fuel saves fail before reaching the table they are
  // actually allowed to write.
  if (canManageSettings()) {
    await syncLedgerDirectoryForAdmin(ledgerId);
  }

  const membersResult = await supabaseClient
    .from("ledger_members")
    .select("id,name")
    .eq("ledger_id", ledgerId)
    .eq("is_active", true);
  if (membersResult.error) throw membersResult.error;

  const memberIdsByName = Object.fromEntries((membersResult.data || []).map((member) => [member.name, member.id]));

  const openPeriodId = await ensureOpenSettlementPeriod(ledgerId);

  return { ledgerId, openPeriodId, memberIdsByName };
}

async function syncLedgerDirectoryForAdmin(ledgerId) {
  const now = new Date().toISOString();
  const ledgerPayload = {
    id: ledgerId,
    name: "Fuel Ledger",
    currency: state.currency || "DKK",
    fuel_type: state.fuelType || defaults.fuelType,
    estimated_consumption_l_per_100km: Number(state.fuelConsumption) || defaults.fuelConsumption,
    fallback_fuel_price: Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice,
    low_fuel_threshold_percent: Number(state.fuelWarningThreshold) || defaults.fuelWarningThreshold,
    updated_at: now
  };

  const ledgerResult = await supabaseClient.from("ledgers").upsert(ledgerPayload).select("id").single();
  if (ledgerResult.error) throw ledgerResult.error;

  const memberPayloads = getMemberNames().map((name) => {
    const profile = getMemberProfile(name);
    return {
      ledger_id: ledgerId,
      name,
      email: profile.email || null,
      role: profile.role === "admin" ? "admin" : "member",
      is_active: true,
      updated_at: now
    };
  });

  if (memberPayloads.length) {
    const memberResult = await supabaseClient
      .from("ledger_members")
      .upsert(memberPayloads, { onConflict: "ledger_id,name" })
      .select("id,name");
    if (memberResult.error) throw memberResult.error;
  }
}

async function saveTripToNormalizedTablesFirst(trip) {
  if (!supabaseClient || !currentSession) return true;
  try {
    setSyncStatus("Saving");
    const context = await getNormalizedWriteContext();
    if (!context) return true;
    const payload = {
      legacy_id: trip.id,
      ledger_id: context.ledgerId,
      period_id: context.openPeriodId,
      driver_member_id: context.memberIdsByName[trip.driver] || null,
      trip_date: normalizedDate(trip.date),
      start_km: Number(trip.startKm || 0),
      end_km: Number(trip.endKm || 0),
      note: trip.note || null,
      deleted_at: null,
      updated_at: new Date().toISOString()
    };

    const tripResult = await supabaseClient
      .from("trips")
      .upsert(payload, { onConflict: "ledger_id,legacy_id" })
      .select("id")
      .single();
    if (tripResult.error) throw tripResult.error;

    const tripId = tripResult.data.id;
    const deleteParticipants = await supabaseClient.from("trip_participants").delete().eq("trip_id", tripId);
    if (deleteParticipants.error) throw deleteParticipants.error;

    const participantPayloads = [...new Set(getTripParticipants(trip).map((name) => context.memberIdsByName[name]).filter(Boolean))]
      .map((memberId) => ({ trip_id: tripId, member_id: memberId }));

    if (participantPayloads.length) {
      const participantResult = await supabaseClient
        .from("trip_participants")
        .upsert(participantPayloads, { onConflict: "trip_id,member_id" });
      if (participantResult.error) throw participantResult.error;
    }

    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Table-primary write saved the trip to normalized tables. JSON will be updated as backup."
    };
    return true;
  } catch (error) {
    console.warn("Table-primary trip write failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not save trip to normalized tables, so JSON was not changed: ${error.message || error}`
    };
    alert("Could not save this trip to the normalized database. The local JSON backup was not changed. Check the console for details.");
    render();
    return false;
  }
}

async function saveFuelToNormalizedTablesFirst(fuel) {
  if (!supabaseClient || !currentSession) return true;
  try {
    setSyncStatus("Saving");
    const context = await getNormalizedWriteContext();
    if (!context) return true;
    const liters = nullableNumber(fuel.liters);
    const amount = Number(fuel.amount || 0);
    const payload = {
      legacy_id: fuel.id,
      ledger_id: context.ledgerId,
      period_id: context.openPeriodId,
      payer_member_id: context.memberIdsByName[fuel.payer] || null,
      payment_date: normalizedDate(fuel.date),
      amount,
      currency: state.currency || "DKK",
      liters,
      price_per_liter: liters ? roundMoney(amount / liters) : nullableNumber(fuel.pricePerLiter),
      odometer: nullableNumber(fuel.odometer),
      station_name: fuel.station || fuel.stationInfo?.name || null,
      station_brand: fuel.stationInfo?.brand || null,
      station_lat: fuel.stationInfo?.latitude || null,
      station_lng: fuel.stationInfo?.longitude || null,
      user_lat: fuel.location?.latitude || null,
      user_lng: fuel.location?.longitude || null,
      full_tank: Boolean(fuel.fullTank),
      deleted_at: null,
      updated_at: new Date().toISOString()
    };

    const fuelResult = await supabaseClient
      .from("fuel_payments")
      .upsert(payload, { onConflict: "ledger_id,legacy_id" });
    if (fuelResult.error) throw fuelResult.error;

    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Table-primary write saved the fuel log to normalized tables. JSON will be updated as backup."
    };
    return true;
  } catch (error) {
    console.warn("Table-primary fuel write failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not save fuel log to normalized tables, so JSON was not changed: ${error.message || error}`
    };
    alert("Could not save this fuel log to the normalized database. The local JSON backup was not changed. Check the console for details.");
    render();
    return false;
  }
}

async function pruneStaleSettlementRequests(context) {
  if (!supabaseClient || !context?.openPeriodId) return;
  const currentPairIds = new Set(
    calculateLedger().settlements
      .map((settlement) => {
        const fromId = context.memberIdsByName[settlement.from];
        const toId = context.memberIdsByName[settlement.to];
        return fromId && toId ? `${fromId}->${toId}` : "";
      })
      .filter(Boolean)
  );

  const existing = await supabaseClient
    .from("settlement_requests")
    .select("id,from_member_id,to_member_id")
    .eq("ledger_id", context.ledgerId)
    .eq("period_id", context.openPeriodId);
  if (existing.error) throw existing.error;

  const staleIds = (existing.data || [])
    .filter((request) => !currentPairIds.has(`${request.from_member_id}->${request.to_member_id}`))
    .map((request) => request.id);
  if (!staleIds.length) return;

  // RLS allows ledger members to update settlement request rows, but not necessarily delete them.
  // Mark old payment-line rows as cancelled so they do not count in health checks or reload state.
  const cancellation = await supabaseClient
    .from("settlement_requests")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .in("id", staleIds);
  if (cancellation.error) throw cancellation.error;
}

async function saveSettlementRequestToNormalizedTableFirst(settlement, nextStatus) {
  if (!supabaseClient || !currentSession) return true;
  try {
    setSyncStatus("Saving");
    const context = await getNormalizedWriteContext();
    if (!context) return true;

    const fromMemberId = context.memberIdsByName[settlement.from] || null;
    const toMemberId = context.memberIdsByName[settlement.to] || null;
    if (!fromMemberId || !toMemberId) {
      throw new Error("Could not match settlement members in normalized ledger_members.");
    }

    const now = new Date().toISOString();
    const payload = {
      ledger_id: context.ledgerId,
      period_id: context.openPeriodId,
      from_member_id: fromMemberId,
      to_member_id: toMemberId,
      amount: roundMoney(settlement.amount),
      currency: state.currency || "DKK",
      status: nextStatus,
      updated_at: now
    };

    if (nextStatus === "requested") {
      payload.requested_at = now;
      payload.requested_by_member_id = toMemberId;
      payload.paid_at = null;
    } else if (nextStatus === "paid") {
      payload.paid_at = now;
    } else {
      payload.requested_at = null;
      payload.requested_by_member_id = null;
      payload.paid_at = null;
    }

    const result = await supabaseClient
      .from("settlement_requests")
      .upsert(payload, { onConflict: "period_id,from_member_id,to_member_id" });
    if (result.error) throw result.error;

    await pruneStaleSettlementRequests(context).catch((error) => {
      console.warn("Could not prune stale settlement request rows", error);
    });

    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Table-primary write saved the settlement request status to normalized tables. JSON will be updated as backup."
    };
    return true;
  } catch (error) {
    console.warn("Table-primary settlement request write failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not save settlement request to normalized tables, so JSON was not changed: ${error.message || error}`
    };
    alert("Could not save this settlement request to the normalized database. The local JSON backup was not changed. Check the console for details.");
    render();
    return false;
  }
}

async function softDeleteNormalizedEntryFirst(type, id) {
  if (!supabaseClient || !currentSession) return true;
  try {
    const context = await getNormalizedWriteContext();
    if (!context) return true;
    const table = type === "trips" ? "trips" : type === "fuel" ? "fuel_payments" : null;
    if (!table) return true;
    const result = await supabaseClient
      .from(table)
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("ledger_id", context.ledgerId)
      .eq("legacy_id", id);
    if (result.error) throw result.error;
    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Table-primary delete saved to normalized tables. JSON will be updated as backup."
    };
    return true;
  } catch (error) {
    console.warn("Table-primary delete failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not delete from normalized tables, so JSON was not changed: ${error.message || error}`
    };
    alert("Could not delete this entry from the normalized database. The local JSON backup was not changed. Check the console for details.");
    render();
    return false;
  }
}

async function syncNormalizedTablesFromJson() {
  if (!supabaseClient || !currentSession) return;
  if (!(await hasFreshSupabaseSession())) return;

  const ledgerId = supabaseConfig.ledgerId || "main-car";

  // Phase 2AA: table-primary writes already saved the specific trip/fuel/request row.
  // A full JSON-to-table reconciliation can touch admin-only tables and can also
  // soft-delete rows if a non-admin device has stale backup JSON. Only admins may
  // run the full reconciliation; regular members keep the table-primary write and
  // JSON backup snapshot paths separate.
  if (!canManageSettings()) {
    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Table-primary save complete. Full JSON-to-table reconciliation is admin-only."
    };
    return;
  }

  try {
    const ledgerPayload = {
      id: ledgerId,
      name: "Fuel Ledger",
      currency: state.currency || "DKK",
      fuel_type: state.fuelType || defaults.fuelType,
      estimated_consumption_l_per_100km: Number(state.fuelConsumption) || defaults.fuelConsumption,
      fallback_fuel_price: Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice,
      low_fuel_threshold_percent: Number(state.fuelWarningThreshold) || defaults.fuelWarningThreshold,
      updated_at: new Date().toISOString()
    };

    const ledgerResult = await supabaseClient.from("ledgers").upsert(ledgerPayload).select("id").single();
    if (ledgerResult.error) throw ledgerResult.error;

    const memberPayloads = getMemberNames().map((name) => {
      const profile = getMemberProfile(name);
      return {
        ledger_id: ledgerId,
        name,
        email: profile.email || null,
        role: profile.role === "admin" ? "admin" : "member",
        is_active: true,
        updated_at: new Date().toISOString()
      };
    });

    if (memberPayloads.length) {
      const upsertMembers = await supabaseClient
        .from("ledger_members")
        .upsert(memberPayloads, { onConflict: "ledger_id,name" })
        .select("id,name,email,role,is_active,mobilepay_phone");
      if (upsertMembers.error) throw upsertMembers.error;
    }

    const membersResult = await supabaseClient
      .from("ledger_members")
      .select("id,name")
      .eq("ledger_id", ledgerId)
      .eq("is_active", true);
    if (membersResult.error) throw membersResult.error;

    const memberIdsByName = Object.fromEntries((membersResult.data || []).map((member) => [member.name, member.id]));

    let openPeriodId = null;
    const openPeriodResult = await supabaseClient
      .from("settlement_periods")
      .select("id")
      .eq("ledger_id", ledgerId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (openPeriodResult.error) throw openPeriodResult.error;
    openPeriodId = openPeriodResult.data?.id || null;

    if (!openPeriodId) {
      const insertPeriod = await supabaseClient
        .from("settlement_periods")
        .insert({ ledger_id: ledgerId, status: "open", label: "Current period" })
        .select("id")
        .single();
      if (insertPeriod.error) throw insertPeriod.error;
      openPeriodId = insertPeriod.data.id;
    }

    const tripPayloads = state.trips.map((trip) => ({
      legacy_id: trip.id,
      ledger_id: ledgerId,
      period_id: openPeriodId,
      driver_member_id: memberIdsByName[trip.driver] || null,
      trip_date: normalizedDate(trip.date),
      start_km: Number(trip.startKm || 0),
      end_km: Number(trip.endKm || 0),
      note: trip.note || null,
      deleted_at: null,
      updated_at: new Date().toISOString()
    })).filter((trip) => trip.legacy_id && trip.end_km > trip.start_km);

    let tableTrips = [];
    if (tripPayloads.length) {
      const upsertTrips = await supabaseClient
        .from("trips")
        .upsert(tripPayloads, { onConflict: "ledger_id,legacy_id" })
        .select("id,legacy_id");
      if (upsertTrips.error) throw upsertTrips.error;
      tableTrips = upsertTrips.data || [];
    }

    const existingTripsResult = await supabaseClient
      .from("trips")
      .select("id,legacy_id")
      .eq("ledger_id", ledgerId)
      .eq("period_id", openPeriodId)
      .is("deleted_at", null);
    if (existingTripsResult.error) throw existingTripsResult.error;

    const activeTripIds = new Set(state.trips.map((trip) => trip.id));
    const tripsToSoftDelete = (existingTripsResult.data || []).filter((trip) => trip.legacy_id && !activeTripIds.has(trip.legacy_id));
    for (const trip of tripsToSoftDelete) {
      const deleted = await supabaseClient
        .from("trips")
        .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", trip.id);
      if (deleted.error) throw deleted.error;
    }

    const tripIdsByLegacyId = Object.fromEntries([...(existingTripsResult.data || []), ...tableTrips].map((trip) => [trip.legacy_id, trip.id]));
    for (const trip of state.trips) {
      const normalizedTripId = tripIdsByLegacyId[trip.id];
      if (!normalizedTripId) continue;

      const deleteParticipants = await supabaseClient
        .from("trip_participants")
        .delete()
        .eq("trip_id", normalizedTripId);
      if (deleteParticipants.error) throw deleteParticipants.error;

      const uniqueParticipantIds = [...new Set(
        getTripParticipants(trip)
          .map((name) => memberIdsByName[name])
          .filter(Boolean)
      )];

      const participantPayloads = uniqueParticipantIds
        .map((memberId) => ({ trip_id: normalizedTripId, member_id: memberId }));

      if (participantPayloads.length) {
        const upsertParticipants = await supabaseClient
          .from("trip_participants")
          .upsert(participantPayloads, { onConflict: "trip_id,member_id" });
        if (upsertParticipants.error) throw upsertParticipants.error;
      }
    }

    const fuelPayloads = state.fuel.map((fuel) => {
      const liters = nullableNumber(fuel.liters);
      const amount = Number(fuel.amount || 0);
      return {
        legacy_id: fuel.id,
        ledger_id: ledgerId,
        period_id: openPeriodId,
        payer_member_id: memberIdsByName[fuel.payer] || null,
        payment_date: normalizedDate(fuel.date),
        amount,
        currency: state.currency || "DKK",
        liters,
        price_per_liter: liters ? roundMoney(amount / liters) : nullableNumber(fuel.pricePerLiter),
        odometer: nullableNumber(fuel.odometer),
        station_name: fuel.station || fuel.stationInfo?.name || null,
        station_brand: fuel.stationInfo?.brand || null,
        station_lat: fuel.stationInfo?.latitude || null,
        station_lng: fuel.stationInfo?.longitude || null,
        user_lat: fuel.location?.latitude || null,
        user_lng: fuel.location?.longitude || null,
        full_tank: Boolean(fuel.fullTank),
        deleted_at: null,
        updated_at: new Date().toISOString()
      };
    }).filter((fuel) => fuel.legacy_id && fuel.amount > 0);

    if (fuelPayloads.length) {
      const upsertFuel = await supabaseClient
        .from("fuel_payments")
        .upsert(fuelPayloads, { onConflict: "ledger_id,legacy_id" });
      if (upsertFuel.error) throw upsertFuel.error;
    }

    const existingFuelResult = await supabaseClient
      .from("fuel_payments")
      .select("id,legacy_id")
      .eq("ledger_id", ledgerId)
      .eq("period_id", openPeriodId)
      .is("deleted_at", null);
    if (existingFuelResult.error) throw existingFuelResult.error;

    const activeFuelIds = new Set(state.fuel.map((fuel) => fuel.id));
    const fuelToSoftDelete = (existingFuelResult.data || []).filter((fuel) => fuel.legacy_id && !activeFuelIds.has(fuel.legacy_id));
    for (const fuel of fuelToSoftDelete) {
      const deleted = await supabaseClient
        .from("fuel_payments")
        .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", fuel.id);
      if (deleted.error) throw deleted.error;
    }

    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: `Dual-write sync is active. Normalized tables were updated from JSON (${getMemberNames().length} members, ${state.trips.length} trips, ${state.fuel.length} fuel logs).`
    };
  } catch (error) {
    console.warn("Normalized table dual-write failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `JSON was saved, but normalized table dual-write failed: ${error.message || error}`
    };
  }

  render();
}



async function loadStateFromNormalizedTables(jsonFallbackState) {
  if (!supabaseClient || !currentSession) return null;
  if (!(await hasFreshSupabaseSession())) return null;

  const ledgerId = supabaseConfig.ledgerId || "main-car";

  const [ledgerResult, membersResult, periodsResult, tripsResult, fuelResult, requestsResult] = await Promise.all([
    supabaseClient.from("ledgers").select("*").eq("id", ledgerId).maybeSingle(),
    supabaseClient.from("ledger_members").select("id,name,email,role,is_active,mobilepay_phone").eq("ledger_id", ledgerId).eq("is_active", true).order("created_at", { ascending: true }),
    supabaseClient.from("settlement_periods").select("id,status,label,closed_at,snapshot_json,created_at").eq("ledger_id", ledgerId).order("created_at", { ascending: true }),
    supabaseClient.from("trips").select("id,legacy_id,period_id,driver_member_id,trip_date,start_km,end_km,note,deleted_at,created_at").eq("ledger_id", ledgerId).is("deleted_at", null).order("trip_date", { ascending: true }),
    supabaseClient.from("fuel_payments").select("id,legacy_id,period_id,payer_member_id,payment_date,amount,currency,liters,price_per_liter,odometer,station_name,station_brand,station_lat,station_lng,user_lat,user_lng,full_tank,deleted_at,created_at").eq("ledger_id", ledgerId).is("deleted_at", null).order("payment_date", { ascending: true }),
    supabaseClient.from("settlement_requests").select("id,period_id,from_member_id,to_member_id,amount,currency,status").eq("ledger_id", ledgerId)
  ]);

  const firstError = [ledgerResult, membersResult, periodsResult, tripsResult, fuelResult, requestsResult].find((result) => result.error)?.error;
  if (firstError) throw firstError;

  const ledger = ledgerResult.data;
  const members = membersResult.data || [];
  const periods = periodsResult.data || [];
  const tableTrips = tripsResult.data || [];
  const tableFuel = fuelResult.data || [];
  const tableRequests = requestsResult.data || [];
  const openPeriod = periods.find((period) => period.status === "open") || null;

  if (!ledger || members.length === 0 || !openPeriod) return null;

  const memberById = Object.fromEntries(members.map((member) => [member.id, member]));
  const memberNames = members.map((member) => member.name).filter(Boolean);
  const memberProfiles = Object.fromEntries(
    members.map((member) => [
      member.name,
      {
        email: normalizeEmail(member.email || ""),
        role: member.role === "admin" ? "admin" : "member",
        mobilepayPhone: normalizePhone(member.mobilepay_phone || "")
      }
    ])
  );

  const participantResult = tableTrips.length
    ? await supabaseClient
        .from("trip_participants")
        .select("trip_id,member_id")
        .in("trip_id", tableTrips.map((trip) => trip.id))
    : { data: [], error: null };
  if (participantResult.error) throw participantResult.error;

  const participantNamesByTripId = {};
  for (const participant of participantResult.data || []) {
    const memberName = memberById[participant.member_id]?.name;
    if (!memberName) continue;
    if (!participantNamesByTripId[participant.trip_id]) participantNamesByTripId[participant.trip_id] = [];
    participantNamesByTripId[participant.trip_id].push(memberName);
  }

  const activeTrips = tableTrips.filter((trip) => !openPeriod || !trip.period_id || trip.period_id === openPeriod.id);
  const activeFuel = tableFuel.filter((fuel) => !openPeriod || !fuel.period_id || fuel.period_id === openPeriod.id);

  const trips = activeTrips.map((trip) => {
    const driver = memberById[trip.driver_member_id]?.name || memberNames[0] || "";
    const participants = participantNamesByTripId[trip.id]?.length ? [...new Set(participantNamesByTripId[trip.id])] : (driver ? [driver] : []);
    return {
      id: trip.legacy_id || trip.id,
      driver,
      date: normalizedDate(trip.trip_date),
      startKm: round(Number(trip.start_km || 0)),
      endKm: round(Number(trip.end_km || 0)),
      participants,
      note: trip.note || ""
    };
  });

  const fuel = activeFuel.map((item) => {
    const payer = memberById[item.payer_member_id]?.name || memberNames[0] || "";
    const liters = Number(item.liters || 0) > 0 ? round(Number(item.liters)) : "";
    const amount = roundMoney(Number(item.amount || 0));
    const stationName = item.station_name || "";
    const hasUserLocation = Number.isFinite(Number(item.user_lat)) && Number.isFinite(Number(item.user_lng));
    const hasStationLocation = Number.isFinite(Number(item.station_lat)) && Number.isFinite(Number(item.station_lng));
    return {
      id: item.legacy_id || item.id,
      payer,
      date: normalizedDate(item.payment_date),
      amount,
      liters,
      pricePerLiter: liters ? roundMoney(amount / liters) : (Number(item.price_per_liter || 0) > 0 ? roundMoney(Number(item.price_per_liter)) : ""),
      odometer: Number(item.odometer || 0) > 0 ? round(Number(item.odometer)) : "",
      station: stationName,
      location: hasUserLocation ? { latitude: Number(item.user_lat), longitude: Number(item.user_lng) } : null,
      stationInfo: hasStationLocation
        ? {
            name: stationName,
            brand: item.station_brand || "",
            latitude: Number(item.station_lat),
            longitude: Number(item.station_lng)
          }
        : null,
      fullTank: Boolean(item.full_tank)
    };
  });

  const closedPeriodsFromTables = periods
    .filter((period) => period.status === "closed" && period.snapshot_json)
    .map((period) => period.snapshot_json);

  const paymentStatusesFromTables = {};
  const activeRequests = tableRequests.filter((request) => normalizePaymentStatus(request.status) !== "cancelled" && (!openPeriod || request.period_id === openPeriod.id));
  for (const request of activeRequests) {
    const fromName = memberById[request.from_member_id]?.name;
    const toName = memberById[request.to_member_id]?.name;
    if (!fromName || !toName) continue;
    const key = settlementKeyForPeriod({
      from: fromName,
      to: toName,
      currency: request.currency || ledger.currency || jsonFallbackState.currency || "DKK"
    }, openPeriod.id);
    paymentStatusesFromTables[key] = normalizePaymentStatus(request.status);
  }

  return normalizeState({
    ...jsonFallbackState,
    currency: ledger.currency || jsonFallbackState.currency,
    fuelType: ledger.fuel_type || jsonFallbackState.fuelType,
    fuelConsumption: Number(ledger.estimated_consumption_l_per_100km) || jsonFallbackState.fuelConsumption,
    fuelFallbackPrice: Number(ledger.fallback_fuel_price) || jsonFallbackState.fuelFallbackPrice,
    fuelWarningThreshold: Number(ledger.low_fuel_threshold_percent) || jsonFallbackState.fuelWarningThreshold,
    members: memberNames,
    memberProfiles,
    trips,
    fuel,
    currentPeriodId: openPeriod.id,
    paymentStatuses: paymentStatusesFromTables,
    closedPeriods: closedPeriodsFromTables.length ? closedPeriodsFromTables : jsonFallbackState.closedPeriods
  });
}

async function checkNormalizedTablesAgainstCurrentState() {
  if (!supabaseClient || !currentSession) return;
  if (!(await hasFreshSupabaseSession())) return;

  const ledgerId = supabaseConfig.ledgerId || "main-car";
  const [membersResult, tripsResult, fuelResult, periodsResult, requestsResult] = await Promise.all([
    supabaseClient.from("ledger_members").select("id,name,email,role,is_active,mobilepay_phone").eq("ledger_id", ledgerId),
    supabaseClient.from("trips").select("id,period_id,deleted_at").eq("ledger_id", ledgerId).is("deleted_at", null),
    supabaseClient.from("fuel_payments").select("id,period_id,deleted_at").eq("ledger_id", ledgerId).is("deleted_at", null),
    supabaseClient.from("settlement_periods").select("id,status").eq("ledger_id", ledgerId),
    supabaseClient.from("settlement_requests").select("id,period_id,from_member_id,to_member_id,currency,status,paid_at").eq("ledger_id", ledgerId)
  ]);

  const firstError = [membersResult, tripsResult, fuelResult, periodsResult, requestsResult].find((result) => result.error)?.error;
  if (firstError) throw firstError;

  const tableMembers = membersResult.data || [];
  const tableTrips = tripsResult.data || [];
  const tableFuel = fuelResult.data || [];
  const tablePeriods = periodsResult.data || [];
  const tableRequests = requestsResult.data || [];
  const activeMembers = tableMembers.filter((member) => member.is_active !== false);
  const openPeriod = tablePeriods.find((period) => period.status === "open") || null;
  const activeTableTrips = tableTrips.filter((trip) => !openPeriod || !trip.period_id || trip.period_id === openPeriod.id);
  const activeTableFuel = tableFuel.filter((fuel) => !openPeriod || !fuel.period_id || fuel.period_id === openPeriod.id);
  const admins = activeMembers.filter((member) => member.role === "admin");
  const membersWithoutEmail = activeMembers.filter((member) => !member.email);
  const mismatchParts = [];

  if (activeMembers.length !== getMemberNames().length) {
    mismatchParts.push(`members ${activeMembers.length} in tables vs ${getMemberNames().length} in app`);
  }

  if (activeTableTrips.length !== state.trips.length) {
    mismatchParts.push(`trips ${activeTableTrips.length} in the open table period vs ${state.trips.length} in app`);
  }

  if (activeTableFuel.length !== state.fuel.length) {
    mismatchParts.push(`fuel logs ${activeTableFuel.length} in the open table period vs ${state.fuel.length} in app`);
  }

  const openPeriods = tablePeriods.filter((period) => period.status === "open").length;
  if (openPeriods !== 1) {
    mismatchParts.push(`${openPeriods} open normalized periods`);
  }

  const activeTableRequests = tableRequests.filter((request) => normalizePaymentStatus(request.status) !== "cancelled" && (!openPeriod || request.period_id === openPeriod.id));
  const currentSettlementPairs = new Set(calculateLedger().settlements.map((settlement) => settlementKey(settlement)));
  const currentActiveRequests = activeTableRequests.filter((request) => {
    const fromName = activeMembers.find((member) => member.id === request.from_member_id)?.name;
    const toName = activeMembers.find((member) => member.id === request.to_member_id)?.name;
    if (!fromName || !toName) return false;
    return currentSettlementPairs.has(settlementKey({ from: fromName, to: toName, currency: state.currency || "DKK" }));
  });
  const staleActiveRequests = activeTableRequests.length - currentActiveRequests.length;
  const requestedStatuses = calculateLedger().settlements.filter(
    (settlement) => ["requested", "paid"].includes(normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]))
  ).length;
  const requestedTableStatuses = currentActiveRequests.filter((request) => ["requested", "paid"].includes(normalizePaymentStatus(request.status))).length;
  if (requestedTableStatuses !== requestedStatuses) {
    mismatchParts.push(`requested payments ${requestedTableStatuses} current table rows vs ${requestedStatuses} visible in app`);
  }
  if (staleActiveRequests > 0) {
    mismatchParts.push(`${staleActiveRequests} stale settlement request row${staleActiveRequests === 1 ? "" : "s"} from old payment lines`);
  }

  if (!admins.length) {
    mismatchParts.push("no normalized admin user");
  }

  const normalizedDetails = [
    {
      level: activeMembers.length === getMemberNames().length && admins.length ? "ok" : "warning",
      title: "Normalized members",
      message: `${activeMembers.length} active table member${activeMembers.length === 1 ? "" : "s"}; ${getMemberNames().length} in the app; ${admins.length} admin${admins.length === 1 ? "" : "s"}.`
    },
    {
      level: activeTableTrips.length === state.trips.length ? "ok" : "warning",
      title: "Normalized trips",
      message: `${activeTableTrips.length} open-period table trip${activeTableTrips.length === 1 ? "" : "s"}; ${state.trips.length} visible requested/paid in the app.`
    },
    {
      level: activeTableFuel.length === state.fuel.length ? "ok" : "warning",
      title: "Normalized fuel logs",
      message: `${activeTableFuel.length} open-period table fuel log${activeTableFuel.length === 1 ? "" : "s"}; ${state.fuel.length} visible requested/paid in the app.`
    },
    {
      level: openPeriods === 1 ? "ok" : "warning",
      title: "Normalized open period",
      message: openPeriods === 1 ? "Exactly one open settlement period exists." : `${openPeriods} open settlement periods found.`
    },
    {
      level: requestedTableStatuses === requestedStatuses && staleActiveRequests === 0 ? "ok" : "warning",
      title: "Normalized payment requests",
      message: staleActiveRequests
        ? `${requestedTableStatuses} requested/paid current payment${requestedTableStatuses === 1 ? "" : "s"}; ${requestedStatuses} visible requested/paid in the app; ${staleActiveRequests} stale request row${staleActiveRequests === 1 ? "" : "s"} ignored.`
        : `${requestedTableStatuses} requested/paid current payment${requestedTableStatuses === 1 ? "" : "s"}; ${requestedStatuses} visible requested/paid in the app.`
    }
  ];

  normalizedTableStatus = {
    checked: true,
    ok: mismatchParts.length === 0,
    message: mismatchParts.length
      ? `Normalized table check found: ${mismatchParts.join("; ")}. JSON remains available as fallback until this is resolved.`
      : normalizedReadModeActive
        ? `Reading from normalized tables first; open period tables match the app state.`
        : `Normalized tables match the current JSON counts.`,
    details: normalizedDetails,
    membersWithoutEmail: membersWithoutEmail.length,
    admins: admins.length
  };

  render();
}

async function loadRemoteState() {
  if (supabaseClient) {
    await loadSupabaseState();
    return;
  }

  try {
    setSyncStatus("Syncing");
    const response = await fetch(apiStateUrl);
    if (!response.ok) throw new Error("State request failed");
    const remoteState = normalizeState(await response.json());
    const localState = loadState();
    state = !hasLedgerData(remoteState) && hasLedgerData(localState) ? localState : remoteState;
    state.lastOdometer = getLatestOdometer();
    localStorage.setItem(storageKey, JSON.stringify(state));
    setDefaultDates();
    render();
    if (state === localState) queueRemoteSave();
    setSyncStatus("Shared");
  } catch {
    setSyncStatus("Local");
  }
}

function queueRemoteSave() {
  window.clearTimeout(remoteSaveTimer);
  remoteSaveTimer = window.setTimeout(saveRemoteState, 250);
}

async function saveRemoteState() {
  if (supabaseClient) {
    await saveSupabaseState();
    return;
  }

  try {
    setSyncStatus("Saving");
    const response = await fetch(apiStateUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
    if (!response.ok) throw new Error("State save failed");
    state = normalizeState(await response.json());
    localStorage.setItem(storageKey, JSON.stringify(state));
    setSyncStatus("Shared");
  } catch {
    setSyncStatus("Local");
  }
}

async function loadSupabaseState() {
  if (!currentSession) {
    setSyncStatus("Login");
    return;
  }

  try {
    setSyncStatus("Syncing");
    const { data, error } = await supabaseClient
      .from("car_share_ledgers")
      .select("state,updated_at")
      .eq("id", supabaseConfig.ledgerId || "main-car")
      .single();

    if (error) throw error;

    lastCloudSaveAt = data.updated_at || new Date().toISOString();
    lastJsonMirrorSaveAt = data.updated_at || "";
    lastSyncError = "";
    const jsonState = normalizeState(data.state);
    let loadedFromTables = false;

    try {
      const normalizedState = await loadStateFromNormalizedTables(jsonState);
      if (normalizedState) {
        normalizedReadModeActive = true;
        applyIncomingState(normalizedState, "Tables");
        loadedFromTables = true;
        normalizedTableStatus = {
          checked: true,
          ok: true,
          message: `Reading from normalized tables first; trips/fuel write to tables first (${normalizedState.members.length} members, ${normalizedState.trips.length} trips, ${normalizedState.fuel.length} fuel logs). JSON remains available as fallback.`
        };
      }
    } catch (tableError) {
      normalizedTableStatus = {
        checked: true,
        ok: false,
        message: `Could not read normalized tables, so JSON was used as fallback: ${tableError.message || tableError}`
      };
    }

    if (!loadedFromTables) {
      normalizedReadModeActive = false;
      applyIncomingState(jsonState, "Cloud");
      await syncNormalizedTablesFromJson();
    }

    checkNormalizedTablesAgainstCurrentState().catch((error) => {
      normalizedTableStatus = {
        checked: true,
        ok: false,
        message: `Could not read normalized tables: ${error.message || error}`
      };
      render();
    });
    if (ensureMemberForLoggedInUser()) await saveSupabaseState();
  } catch (error) {
    lastSyncError = error.message || "Could not load cloud data.";
    els.authMessage.textContent = `${lastSyncError} The app could not load the shared cloud data.`;
    setSyncStatus("Local");
  }
}

async function saveSupabaseState() {
  if (!currentSession) {
    setSyncStatus("Login");
    return;
  }

  try {
    setSyncStatus("Saving");
    ignoreRealtimeUntil = Date.now() + 1500;

    // Phase 2I: normalized tables are primary. Keep them aligned from the
    // current app state, but do not overwrite the legacy JSON blob on every
    // save. The JSON mirror is now only a periodic/manual safety snapshot.
    await syncNormalizedTablesFromJson();
    await maybeSaveJsonMirrorBackup();

    lastCloudSaveAt = new Date().toISOString();
    lastSyncError = "";
    setSyncStatus("Tables");
    checkNormalizedTablesAgainstCurrentState().catch((error) => {
      normalizedTableStatus = {
        checked: true,
        ok: false,
        message: `Could not read normalized tables: ${error.message || error}`
      };
      render();
    });
    if (ensureMemberForLoggedInUser()) await saveSupabaseState();
  } catch (error) {
    lastSyncError = error.message || "Could not save table data.";
    els.authMessage.textContent = `${lastSyncError} Changes on this device may not be saved to the cloud.`;
    setSyncStatus("Local");
  }
}

async function maybeSaveJsonMirrorBackup() {
  const lastSaved = Number(localStorage.getItem(`${storageKey}:jsonMirrorSavedAt`) || 0);
  if (Date.now() - lastSaved < jsonMirrorBackupIntervalMs) return;
  await saveJsonMirrorBackup({ force: false });
}

async function saveJsonMirrorBackup({ force = false } = {}) {
  if (!supabaseClient || !currentSession) return false;
  if (!force && normalizedReadModeActive && !hasLedgerData(state)) return false;

  const savedAt = new Date().toISOString();
  const { error } = await supabaseClient
    .from("car_share_ledgers")
    .upsert({
      id: supabaseConfig.ledgerId || "main-car",
      state,
      updated_at: savedAt
    });

  if (error) throw error;

  lastJsonMirrorSaveAt = savedAt;
  localStorage.setItem(`${storageKey}:jsonMirrorSavedAt`, String(Date.now()));
  lastCloudSaveAt = savedAt;
  return true;
}

function applyIncomingState(nextState, status = "Live") {
  state = normalizeState(nextState);
  state.lastOdometer = getLatestOdometer();
  localStorage.setItem(storageKey, JSON.stringify(state));
  setDefaultDates();
  render();
  setSyncStatus(status);
  updateAuthUi();
}

function subscribeToSupabaseState() {
  if (!supabaseClient || supabaseStateChannel) return;

  const ledgerId = supabaseConfig.ledgerId || "main-car";
  supabaseStateChannel = supabaseClient
    .channel(`ledger:${ledgerId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "car_share_ledgers", filter: `id=eq.${ledgerId}` },
      (payload) => {
        if (Date.now() < ignoreRealtimeUntil) return;
        if (payload.new?.state) applyIncomingState(payload.new.state);
      }
    )
    .subscribe();
}

function unsubscribeFromSupabaseState() {
  if (!supabaseClient || !supabaseStateChannel) return;
  supabaseClient.removeChannel(supabaseStateChannel);
  supabaseStateChannel = null;
}

function setSyncStatus(label) {
  els.syncStatus.textContent = label === "Tables" ? "Database" : label;
  els.syncStatus.dataset.status = label.toLowerCase();

  if (!els.syncDetail) return;

  if (label === "Tables") {
    els.syncDetail.textContent = lastCloudSaveAt
      ? `Saved to database ${new Date(lastCloudSaveAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Saved/read through normalized database tables";
    return;
  }

  if (label === "Cloud") {
    els.syncDetail.textContent = lastCloudSaveAt
      ? `Saved to cloud ${new Date(lastCloudSaveAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Saved to Supabase";
    return;
  }

  if (label === "Saving") {
    els.syncDetail.textContent = "Saving changes...";
    return;
  }

  if (label === "Syncing") {
    els.syncDetail.textContent = "Loading shared data...";
    return;
  }

  if (label === "Login") {
    els.syncDetail.textContent = "Sign in to save changes";
    return;
  }

  if (label === "Local") {
    els.syncDetail.textContent = lastSyncError
      ? `Not saved: ${lastSyncError}`
      : "Not saved to cloud";
    return;
  }

  els.syncDetail.textContent = "";
}

function hasLedgerData(candidate) {
  return (
    candidate.trips.length > 0 ||
    candidate.fuel.length > 0 ||
    candidate.closedPeriods.length > 0 ||
    Object.keys(candidate.paymentStatuses).length > 0
  );
}

function emptyNode(text = "Nothing logged yet.") {
  const node = els.emptyTemplate.content.firstElementChild.cloneNode(true);
  node.textContent = text;
  return node;
}

function byNewest(a, b) {
  return b.date.localeCompare(a.date);
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-DK", { maximumFractionDigits: 1 }).format(value);
}

function formatMoney(value) {
  return formatMoneyFor(value, state.currency);
}

function formatMoneyFor(value, currency) {
  return `${new Intl.NumberFormat("en-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(roundMoney(value))} ${currency}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-DK", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(`${value}T12:00:00`));
}

function getLedgerPeriod() {
  const dates = [...state.trips.map((trip) => trip.date), ...state.fuel.map((fuel) => fuel.date)]
    .filter(Boolean)
    .sort();

  if (dates.length === 0) {
    return { start: "", end: "", label: "Current ledger" };
  }

  const start = dates[0];
  const end = dates[dates.length - 1];

  return {
    start,
    end,
    label: start === end ? formatDate(start) : `${formatDate(start)} - ${formatDate(end)}`
  };
}

function getLatestOdometer() {
  const activeLatest = state.trips.reduce((latest, trip) => Math.max(latest, trip.endKm), 0);
  const archivedLatest = state.closedPeriods.reduce((latest, period) => {
    const periodLatest = (period.trips || []).reduce(
      (tripLatest, trip) => Math.max(tripLatest, trip.endKm),
      0
    );
    return Math.max(latest, periodLatest);
  }, 0);
  const latest = Math.max(activeLatest, archivedLatest, Number(state.lastOdometer) || 0);
  return latest > 0 ? round(latest) : "";
}

function syncStartOdometerDefault() {
  if (state.lastOdometer !== "" && document.activeElement !== els.startKm) {
    els.startKm.value = state.lastOdometer;
  }
  if (els.fuelOdometer && state.lastOdometer !== "" && document.activeElement !== els.fuelOdometer && !els.fuelOdometer.value) {
    els.fuelOdometer.value = state.lastOdometer;
  }
}

function settlementKeyForPeriod(item, periodId = state.currentPeriodId || "") {
  // Settlement request status is tied to the payer/recipient pair inside one settlement period.
  // Do not include the amount: fuel/trip edits can slightly change the amount, and then
  // a requested payment would appear to reset after refresh even though the database row exists.
  const currency = item.currency || state.currency || "DKK";
  const periodPart = periodId || "current";
  return `${periodPart}:${item.from}->${item.to}:${currency}`;
}

function settlementKey(item) {
  return settlementKeyForPeriod(item);
}

function getSettlementStatus(settlement) {
  return normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]);
}

function statusLabel(status) {
  const normalized = normalizePaymentStatus(status);
  if (normalized === "paid") return "Paid";
  if (normalized === "requested") return "Requested";
  return "Not requested";
}

function normalizePaymentStatuses(statuses) {
  if (!statuses || typeof statuses !== "object") return {};

  return Object.fromEntries(
    Object.entries(statuses).map(([key, status]) => [key, normalizePaymentStatus(status)])
  );
}

function normalizePaymentStatus(status) {
  if (status === "cancelled") return "cancelled";
  if (status === "paid") return "paid";
  return status === "requested" ? "requested" : "open";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replaceAll('"', '\\"');
}
