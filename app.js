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

const defaults = {
  currency: "DKK",
  members: ["Christian", "Alex", "Sam"],
  memberProfiles: {},
  trips: [],
  fuel: [],
  paymentStatuses: {},
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
let lastSyncError = "";
let normalizedTableStatus = { checked: false, ok: false, message: "Normalized tables have not been checked yet." };
let normalizedReadModeActive = false;

const els = {
  totalKm: document.querySelector("#totalKm"),
  fuelRate: document.querySelector("#fuelRate"),
  totalCost: document.querySelector("#totalCost"),
  totalPaid: document.querySelector("#totalPaid"),
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
  settingsForm: document.querySelector("#settingsForm"),
  settingsPanel: document.querySelector(".settings-panel"),
  settlementWarning: document.querySelector("#settlementWarning"),
  paymentOverview: document.querySelector("#paymentOverview"),
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
  exportLedger: document.querySelector("#exportLedger"),
  importLedger: document.querySelector("#importLedger"),
  importLedgerFile: document.querySelector("#importLedgerFile"),
  downloadCsv: document.querySelector("#downloadCsv"),
  removeTestUsers: document.querySelector("#removeTestUsers"),
  addTestTrip: document.querySelector("#addTestTrip"),
  addTestFuel: document.querySelector("#addTestFuel"),
  removeTestData: document.querySelector("#removeTestData"),
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
        role: member.role || (index === 0 && noMemberEmailsConfigured() ? "admin" : "member")
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


function getTestActorName() {
  return currentUser || getMemberNames()[0] || "Christian";
}

function getTestParticipantNames(actor) {
  const members = getMemberNames();
  const ordered = [actor, ...members.filter((name) => name !== actor)];
  return Array.from(new Set(ordered)).slice(0, Math.min(2, Math.max(1, ordered.length)));
}

function addGeneratedTestTrip() {
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
    date: new Date().toISOString().slice(0, 10),
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
    date: new Date().toISOString().slice(0, 10),
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

  const editButton = event.target.closest("[data-edit]");
  if (editButton) {
    editEntry(editButton.dataset.edit);
    return;
  }

  const button = event.target.closest("[data-delete]");
  if (!button) return;

  if (!canManageSettings()) {
    alert("Only an admin can delete entries.");
    return;
  }

  const [type, id] = button.dataset.delete.split(":");
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
  renderSummary(ledger);
  renderBalances(ledger);
  renderSettlements(ledger);
  renderHistory();
  renderClosedPeriods();
  renderTripEstimate();
  renderSystemHealth(ledger);
  els.resetPeriod.disabled = !canManageSettings() || (state.trips.length === 0 && state.fuel.length === 0);
  els.resetPeriod.classList.toggle("hidden", !canManageSettings());
  els.resetData.disabled = !canManageSettings();
  els.resetData.classList.toggle("hidden", !canManageSettings());
  if (els.dataToolsPanel) els.dataToolsPanel.classList.toggle("hidden", !canManageSettings());
  if (els.systemHealthPanel) els.systemHealthPanel.classList.toggle("hidden", !canManageSettings());
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
    setSyncStatus("Cloud");
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
  const lockToLoggedInUser = authRequired || loggedIn;
  els.currentUser.disabled = lockToLoggedInUser;
  els.tripDriver.disabled = lockToLoggedInUser;
  els.fuelPayer.disabled = lockToLoggedInUser;

  setFormDisabled(els.tripForm, !canUse);
  setFormDisabled(els.fuelForm, !canUse);

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

function calculateTripCostEstimate(distanceKm, participantCount) {
  const historical = calculateHistoricalFuelStats({ currentTrips: state.trips, currentFuel: state.fuel });
  const fallbackConsumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const fallbackPrice = Math.max(0.1, Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  const livePrice = latestFuelPrice && latestFuelPrice.price > 0 ? Number(latestFuelPrice.price) : 0;
  const pricePerLiter = historical.pricePerLiter > 0 ? historical.pricePerLiter : livePrice || fallbackPrice;

  let totalCost = 0;
  let explanation = "";

  if (historical.costPerKm > 0 && historical.totalTripKm >= 50) {
    totalCost = distanceKm * historical.costPerKm;
    explanation = `${formatNumber(distanceKm)} km × historical ${formatMoneyFor(historical.costPerKm, state.currency)}/km, based on ${formatNumber(historical.totalTripKm)} logged km.`;
  } else {
    const consumption = historical.litersPer100Km > 0 ? historical.litersPer100Km : fallbackConsumption;
    totalCost = (distanceKm * consumption / 100) * pricePerLiter;
    const priceSource = historical.pricePerLiter > 0 ? "historical receipt average" : livePrice ? "live diesel reference price" : "fallback fuel price";
    const consumptionSource = historical.litersPer100Km > 0 ? "historical consumption" : "car setting";
    explanation = `${formatNumber(distanceKm)} km × ${formatNumber(consumption)} L/100 km (${consumptionSource}) × ${formatMoneyFor(pricePerLiter, state.currency)}/L (${priceSource}).`;
  }

  return {
    totalCost: roundMoney(totalCost),
    perPerson: roundMoney(totalCost / participantCount),
    explanation
  };
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

function renderSettlements(ledger) {
  els.closePeriod.disabled = !canManageSettings() || (state.trips.length === 0 && state.fuel.length === 0);

  renderSettlementWarning(ledger);
  renderPeriodBreakdown(ledger);

  if (ledger.settlements.length === 0) {
    els.paymentOverview.replaceChildren();
    els.settlements.replaceChildren(emptyNode("All even."));
    return;
  }

  const activeKeys = new Set(ledger.settlements.map(settlementKey));
  let prunedPaymentStatuses = false;
  for (const key of Object.keys(state.paymentStatuses)) {
    if (!activeKeys.has(key)) {
      delete state.paymentStatuses[key];
      prunedPaymentStatuses = true;
    }
  }
  if (prunedPaymentStatuses) saveState();
  renderPaymentOverview(ledger);

  els.settlements.innerHTML = ledger.settlements
    .map(
      (item) => {
        const key = settlementKey(item);
        const status = normalizePaymentStatus(state.paymentStatuses[key]);
        const fromPerson = ledger.people[item.from];
        const toPerson = ledger.people[item.to];
        const message = `${item.from} pays ${item.to} ${formatMoney(item.amount)} for shared car fuel`;
        const canRequest = canManageSettlementRequest(item);
        const requestControls = canRequest
          ? `
            <button class="subtle-button compact-button" type="button" data-copy="${escapeHtml(message)}">Copy</button>
            ${status === "open" ? `<button class="subtle-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="requested">Requested</button>` : ""}
            ${status !== "open" ? `<button class="text-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="open">Reopen</button>` : ""}
          `
          : `<span class="request-note">Only ${escapeHtml(item.to)} can request this payment.</span>`;
        return `
        <article class="settlement-card ${status === "requested" ? "is-requested" : ""}">
          <div class="settlement-main">
            <div>
              <strong>${escapeHtml(item.from)}</strong>
              <span> pays </span>
              <strong>${escapeHtml(item.to)}</strong>
              <span class="status-chip ${status}">${statusLabel(status)}</span>
            </div>
            <p>${escapeHtml(ledger.period.label)} · ${formatNumber(fromPerson.km)} km distance share at ${formatMoney(ledger.fuelRate)}/km · ${escapeHtml(item.to)} paid ${formatMoney(toPerson.fuelPaid)}</p>
            <details class="settlement-details" open>
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
  if (!options.skipFuelValidation && isFuelEstimateWarningActive(ledger)) {
    if (!confirm(buildFuelValidationMessage(ledger, "close this period anyway"))) return;
  }

  if (
    !options.skipConfirm &&
    !confirm(
      `Close ${ledger.period.label}? This archives ${formatNumber(ledger.totalKm)} km and ${formatMoney(ledger.totalPaid)} in fuel, then starts a fresh period.`
    )
  ) {
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

    const newPeriodResult = await supabaseClient
      .from("settlement_periods")
      .insert({
        ledger_id: context.ledgerId,
        status: "open",
        label: "Current period"
      });
    if (newPeriodResult.error) throw newPeriodResult.error;

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
  const peopleWithKm = Object.entries(ledger.people)
    .filter(([, person]) => person.km > 0 || person.fuelPaid > 0)
    .map(([name, person]) => `<li><span>${escapeHtml(name)}</span><b>${formatNumber(person.km)} km distance share · ${formatMoney(person.fuelPaid)} fuel paid</b></li>`)
    .join("");

  const fuelByPerson = Object.entries(ledger.fuelByPerson || {})
    .filter(([, amount]) => amount > 0)
    .map(([name, amount]) => {
      const liters = Number(ledger.fuelLitersByPerson?.[name] || 0);
      const detail = liters > 0 ? `${formatMoney(amount)} · ${formatNumber(liters)} L` : formatMoney(amount);
      return `<li><span>${escapeHtml(name)}</span><b>${detail}</b></li>`;
    })
    .join("") || `<li><span>Fuel payments</span><b>None yet</b></li>`;

  els.periodBreakdown.innerHTML = `
    <div class="period-breakdown-card">
      <span>Total trip km</span>
      <strong>${formatNumber(ledger.totalTripKm)} km</strong>
      <small>Odometer distance logged in this open period.</small>
    </div>
    <div class="period-breakdown-card">
      <span>Total participant km</span>
      <strong>${formatNumber(ledger.totalShareKm)} km</strong>
      <small>Trip distance after splitting each trip among the people who joined. This is what fuel cost is divided by.</small>
    </div>
    <div class="period-breakdown-card">
      <span>This period fuel cost per km</span>
      <strong>${ledger.totalTripKm > 0 && ledger.totalPaid > 0 ? `${formatMoney(ledger.totalPaid / ledger.totalTripKm)}/km` : "Not enough data"}</strong>
      <small>Based on receipts logged in this open period only.</small>
    </div>
    <div class="period-breakdown-card">
      <span>This period fuel consumption</span>
      <strong>${ledger.receiptConsumption > 0 ? `${formatNumber(ledger.receiptConsumption)} L/100 km` : "Not enough data"}</strong>
      <small>${ledger.receiptKmPerLiter > 0 ? `${formatNumber(ledger.receiptKmPerLiter)} km/L · ${formatNumber(ledger.totalFuelLiters)} L logged.` : "Add liters on fuel receipts to build consumption statistics."}</small>
    </div>
    ${renderHistoricalFuelStatsCard(ledger.historicalFuelStats)}
    ${renderFuelEstimateCard(ledger)}
    <div class="period-breakdown-card wide-breakdown">
      <span>Fuel payments included</span>
      <ul>${fuelByPerson}</ul>
    </div>
    <div class="period-breakdown-card wide-breakdown">
      <span>People included</span>
      <ul>${peopleWithKm || `<li><span>People</span><b>No active period data yet</b></li>`}</ul>
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

function renderPaymentOverview(ledger) {
  const totals = ledger.settlements.reduce(
    (acc, item) => {
      const status = normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]);
      if (status !== "requested") {
        acc.unrequestedCount += 1;
        acc.unrequestedAmount += item.amount;
      }
      if (status === "requested") acc.requestedCount += 1;
      return acc;
    },
    { unrequestedCount: 0, unrequestedAmount: 0, requestedCount: 0 }
  );

  els.paymentOverview.innerHTML = `
    <div>
      <span>Not requested</span>
      <strong>${formatMoney(totals.unrequestedAmount)}</strong>
    </div>
    <div>
      <span>Requests</span>
      <strong>${totals.requestedCount}</strong>
    </div>
    <div>
      <span>Remaining</span>
      <strong>${totals.unrequestedCount}</strong>
    </div>
  `;
}

async function updatePaymentStatus(button) {
  const ledger = calculateLedger();
  const settlement = ledger.settlements.find((item) => settlementKey(item) === button.dataset.paymentKey);

  if (!settlement || !canManageSettlementRequest(settlement)) {
    alert("Only the person who paid for fuel in this settlement can request or reopen that payment.");
    render();
    return;
  }

  if (button.dataset.paymentStatus === "requested" && isFuelEstimateWarningActive(ledger)) {
    if (!confirm(buildFuelValidationMessage(ledger, "request this payment anyway"))) {
      render();
      return;
    }
  }

  state.paymentStatuses[button.dataset.paymentKey] = button.dataset.paymentStatus;
  saveState();

  if (button.dataset.paymentStatus === "requested") {
    await sendSettlementPush(settlement);
  }

  const refreshedLedger = calculateLedger();
  const allRequested =
    refreshedLedger.settlements.length > 0 &&
    refreshedLedger.settlements.every(
      (item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "requested"
    );

  if (
    button.dataset.paymentStatus === "requested" &&
    allRequested &&
    confirm(
      "All current settlements have been requested. Close and archive this period now so new trips start fresh?"
    )
  ) {
    await closeCurrentPeriod({ skipConfirm: true, allowMemberClose: true, skipFuelValidation: true });
    return;
  }

  render();
}

async function copySettlement(button) {
  const text = button.dataset.copy;

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
    button.textContent = "Copy";
  }, 1600);
}


function exportLedgerBackup() {
  const filename = `fuel-ledger-backup-${new Date().toISOString().slice(0, 10)}.json`;
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
  const date = new Date().toISOString().slice(0, 10);
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


function editEntry(value) {
  if (!canManageSettings()) {
    alert("Only an admin can edit entries.");
    return;
  }

  const [type, id] = String(value || "").split(":");
  if (type === "trips") {
    startTripEdit(id);
    return;
  }
  if (type === "fuel") {
    startFuelEdit(id);
  }
}

function startTripEdit(id) {
  const trip = state.trips.find((entry) => entry.id === id);
  if (!trip) return;

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
    els.tripList.innerHTML = [...state.trips]
      .sort(byNewest)
      .map((trip) => {
        const km = round(trip.endKm - trip.startKm);
        const participants = getTripParticipants(trip);
        return `
          <article class="entry-card">
            <header>
              <strong>${escapeHtml(trip.driver)}</strong>
              ${canManageSettings() ? `<div class="entry-actions"><button class="subtle-button compact-button" type="button" data-edit="trips:${trip.id}">Edit</button><button class="text-button compact-button" type="button" data-delete="trips:${trip.id}">Delete</button></div>` : ""}
            </header>
            <p>${formatNumber(km)} km · Total ${formatNumber(trip.endKm)} km</p>
            <p class="entry-meta">${formatDate(trip.date)} · ${formatNumber(trip.startKm)} to ${formatNumber(trip.endKm)} km</p>
            <p class="entry-meta">Split between ${participants.map(escapeHtml).join(", ")}</p>
            ${trip.note ? `<p>${escapeHtml(trip.note)}</p>` : ""}
          </article>
        `;
      })
      .join("");
  }

  if (state.fuel.length === 0) {
    els.fuelList.replaceChildren(emptyNode());
  } else {
    els.fuelList.innerHTML = [...state.fuel]
      .sort(byNewest)
      .map(
        (fuel) => `
          <article class="entry-card">
            <header>
              <strong>${escapeHtml(fuel.payer)}</strong>
              ${canManageSettings() ? `<div class="entry-actions"><button class="subtle-button compact-button" type="button" data-edit="fuel:${fuel.id}">Edit</button><button class="text-button compact-button" type="button" data-delete="fuel:${fuel.id}">Delete</button></div>` : ""}
            </header>
            <p>${formatMoney(fuel.amount)}${Number(fuel.liters || 0) > 0 ? ` · ${formatNumber(fuel.liters)} L` : ""}</p>
            <p class="entry-meta">${formatDate(fuel.date)}${Number(fuel.liters || 0) > 0 ? ` · ${formatMoneyFor(Number(fuel.amount || 0) / Number(fuel.liters || 1), state.currency)}/L` : ""}${fuel.odometer ? ` · ${formatNumber(fuel.odometer)} km` : ""}${fuel.station ? ` · ${escapeHtml(fuel.station)}` : ""}${fuel.location?.latitude && fuel.location?.longitude ? ` · GPS saved` : ""}${fuel.fullTank ? " · full tank" : ""}</p>
          </article>
        `
      )
      .join("");
  }
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

  checks.push({
    level: (els.syncStatus?.dataset.status || "") === "cloud" ? "ok" : ((els.syncStatus?.dataset.status || "") === "saving" ? "warning" : "issue"),
    title: "Cloud saving",
    message: lastCloudSaveAt
      ? `Last cloud save: ${new Date(lastCloudSaveAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}.`
      : lastSyncError
        ? `Last save/load error: ${lastSyncError}.`
        : "No confirmed cloud save yet in this session."
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

  checks.push({
    level: normalizedTableStatus.checked ? (normalizedTableStatus.ok ? "ok" : "warning") : "warning",
    title: "Normalized database tables",
    message: normalizedTableStatus.message
  });

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
    .map((period) => {
      const unrequested = period.settlements
        .filter((settlement) => settlement.status !== "requested")
        .reduce((sum, settlement) => sum + settlement.amount, 0);
      const requestedCount = period.settlements.filter(
        (settlement) => normalizePaymentStatus(settlement.status) === "requested"
      ).length;
      return `
        <article class="period-card">
          <header>
            <div>
              <strong>${escapeHtml(period.label)}</strong>
              <p>Closed ${formatDate(period.closedAt.slice(0, 10))}</p>
            </div>
            <span>${formatMoneyFor(period.totalPaid, period.currency)} fuel</span>
          </header>
          <div class="period-stats">
            <div><span>Kilometers</span><b>${formatNumber(period.totalKm)} km</b></div>
            <div><span>Fuel rate</span><b>${formatMoneyFor(period.fuelRate, period.currency)}/km</b></div>
            <div><span>Not requested</span><b>${formatMoneyFor(unrequested, period.currency)}</b></div>
            <div><span>Requested</span><b>${requestedCount}/${period.settlements.length}</b></div>
          </div>
          ${renderPeriodSettlements(period)}
        </article>
      `;
    })
    .join("");
}

function renderPeriodSettlements(period) {
  if (period.settlements.length === 0) {
    return `<p class="entry-meta">No payments were needed.</p>`;
  }

  return `
    <div class="period-settlements">
      ${period.settlements
        .map(
          (settlement) => `
            <div>
              <span>${escapeHtml(settlement.from)} pays ${escapeHtml(settlement.to)}</span>
              <b>${formatMoneyFor(settlement.amount, period.currency)}</b>
              <span class="status-chip ${normalizePaymentStatus(settlement.status)}">${statusLabel(settlement.status)}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
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
  const today = new Date().toISOString().slice(0, 10);
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
          role: saved.role === "admin" || (index === 0 && !profiles) ? "admin" : "member"
        }
      ];
    })
  );
}

function getMemberProfile(name) {
  const profile = state.memberProfiles?.[name] || {};
  return { name, email: normalizeEmail(profile.email || ""), role: profile.role === "admin" ? "admin" : "member" };
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
    email,
    role: role === "admin" ? "admin" : "member"
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
  return String(value || new Date().toISOString().slice(0, 10)).slice(0, 10);
}

function nullableNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}


async function getNormalizedWriteContext() {
  if (!supabaseClient || !currentSession) return null;
  if (!(await hasFreshSupabaseSession())) return null;

  const ledgerId = supabaseConfig.ledgerId || "main-car";
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

  return { ledgerId, openPeriodId, memberIdsByName };
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
        .select("id,name,email,role,is_active");
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

  const [ledgerResult, membersResult, periodsResult, tripsResult, fuelResult] = await Promise.all([
    supabaseClient.from("ledgers").select("*").eq("id", ledgerId).maybeSingle(),
    supabaseClient.from("ledger_members").select("id,name,email,role,is_active").eq("ledger_id", ledgerId).eq("is_active", true).order("created_at", { ascending: true }),
    supabaseClient.from("settlement_periods").select("id,status,label,closed_at,snapshot_json,created_at").eq("ledger_id", ledgerId).order("created_at", { ascending: true }),
    supabaseClient.from("trips").select("id,legacy_id,period_id,driver_member_id,trip_date,start_km,end_km,note,deleted_at,created_at").eq("ledger_id", ledgerId).is("deleted_at", null).order("trip_date", { ascending: true }),
    supabaseClient.from("fuel_payments").select("id,legacy_id,period_id,payer_member_id,payment_date,amount,currency,liters,price_per_liter,odometer,station_name,station_brand,station_lat,station_lng,user_lat,user_lng,full_tank,deleted_at,created_at").eq("ledger_id", ledgerId).is("deleted_at", null).order("payment_date", { ascending: true })
  ]);

  const firstError = [ledgerResult, membersResult, periodsResult, tripsResult, fuelResult].find((result) => result.error)?.error;
  if (firstError) throw firstError;

  const ledger = ledgerResult.data;
  const members = membersResult.data || [];
  const periods = periodsResult.data || [];
  const tableTrips = tripsResult.data || [];
  const tableFuel = fuelResult.data || [];
  const openPeriod = periods.find((period) => period.status === "open") || null;

  if (!ledger || members.length === 0 || !openPeriod) return null;

  const memberById = Object.fromEntries(members.map((member) => [member.id, member]));
  const memberNames = members.map((member) => member.name).filter(Boolean);
  const memberProfiles = Object.fromEntries(
    members.map((member) => [
      member.name,
      {
        email: normalizeEmail(member.email || ""),
        role: member.role === "admin" ? "admin" : "member"
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
    closedPeriods: closedPeriodsFromTables.length ? closedPeriodsFromTables : jsonFallbackState.closedPeriods
  });
}

async function checkNormalizedTablesAgainstCurrentState() {
  if (!supabaseClient || !currentSession) return;
  if (!(await hasFreshSupabaseSession())) return;

  const ledgerId = supabaseConfig.ledgerId || "main-car";
  const [membersResult, tripsResult, fuelResult, periodsResult] = await Promise.all([
    supabaseClient.from("ledger_members").select("id,name,email,role,is_active").eq("ledger_id", ledgerId),
    supabaseClient.from("trips").select("id,period_id,deleted_at").eq("ledger_id", ledgerId).is("deleted_at", null),
    supabaseClient.from("fuel_payments").select("id,period_id,deleted_at").eq("ledger_id", ledgerId).is("deleted_at", null),
    supabaseClient.from("settlement_periods").select("id,status").eq("ledger_id", ledgerId)
  ]);

  const firstError = [membersResult, tripsResult, fuelResult, periodsResult].find((result) => result.error)?.error;
  if (firstError) throw firstError;

  const tableMembers = membersResult.data || [];
  const tableTrips = tripsResult.data || [];
  const tableFuel = fuelResult.data || [];
  const tablePeriods = periodsResult.data || [];
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

  if (!admins.length) {
    mismatchParts.push("no normalized admin user");
  }

  normalizedTableStatus = {
    checked: true,
    ok: mismatchParts.length === 0,
    message: mismatchParts.length
      ? `Normalized table check found: ${mismatchParts.join("; ")}. JSON remains available as fallback until this is resolved.`
      : normalizedReadModeActive
        ? `Reading from normalized tables first; trips/fuel write to tables first. Open period tables match JSON counts (${activeMembers.length} members, ${activeTableTrips.length} trips, ${activeTableFuel.length} fuel logs).`
        : `Normalized tables match the current JSON counts (${activeMembers.length} members, ${activeTableTrips.length} trips, ${activeTableFuel.length} fuel logs).`,
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
      .select("state")
      .eq("id", supabaseConfig.ledgerId || "main-car")
      .single();

    if (error) throw error;

    lastCloudSaveAt = new Date().toISOString();
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
    const { data, error } = await supabaseClient
      .from("car_share_ledgers")
      .upsert({
        id: supabaseConfig.ledgerId || "main-car",
        state,
        updated_at: new Date().toISOString()
      })
      .select("state")
      .single();

    if (error) throw error;

    lastCloudSaveAt = new Date().toISOString();
    lastSyncError = "";
    applyIncomingState(data.state, "Cloud");
    await syncNormalizedTablesFromJson();
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
    lastSyncError = error.message || "Could not save cloud data.";
    els.authMessage.textContent = `${lastSyncError} Changes on this device may not be saved to the cloud.`;
    setSyncStatus("Local");
  }
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
  els.syncStatus.textContent = label;
  els.syncStatus.dataset.status = label.toLowerCase();

  if (!els.syncDetail) return;

  if (label === "Tables") {
    els.syncDetail.textContent = "Loaded from normalized database tables";
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

function settlementKey(item) {
  return `${item.from}->${item.to}:${roundMoney(item.amount).toFixed(2)}:${state.currency}`;
}

function statusLabel(status) {
  if (normalizePaymentStatus(status) === "requested") return "Requested";
  return "Not requested";
}

function normalizePaymentStatuses(statuses) {
  if (!statuses || typeof statuses !== "object") return {};

  return Object.fromEntries(
    Object.entries(statuses).map(([key, status]) => [key, normalizePaymentStatus(status)])
  );
}

function normalizePaymentStatus(status) {
  return status === "requested" || status === "paid" ? "requested" : "open";
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
