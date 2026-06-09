const storageKey = "car-share-ledger-v1";
const userKey = "car-share-current-user";
const apiStateUrl = "/api/state";
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
  trips: [],
  fuel: [],
  paymentStatuses: {},
  closedPeriods: [],
  lastOdometer: ""
};

let state = loadState();
let currentUser = localStorage.getItem(userKey) || "";
let remoteSaveTimer;
let currentSession = null;

const els = {
  totalKm: document.querySelector("#totalKm"),
  fuelRate: document.querySelector("#fuelRate"),
  totalCost: document.querySelector("#totalCost"),
  totalPaid: document.querySelector("#totalPaid"),
  authPanel: document.querySelector("#authPanel"),
  loginForm: document.querySelector("#loginForm"),
  loginEmail: document.querySelector("#loginEmail"),
  authMessage: document.querySelector("#authMessage"),
  signOut: document.querySelector("#signOut"),
  currentUser: document.querySelector("#currentUser"),
  syncStatus: document.querySelector("#syncStatus"),
  tripDriver: document.querySelector("#tripDriver"),
  fuelPayer: document.querySelector("#fuelPayer"),
  tripDate: document.querySelector("#tripDate"),
  tripParticipants: document.querySelector("#tripParticipants"),
  fuelDate: document.querySelector("#fuelDate"),
  startKm: document.querySelector("#startKm"),
  endKm: document.querySelector("#endKm"),
  tripNote: document.querySelector("#tripNote"),
  fuelAmount: document.querySelector("#fuelAmount"),
  currency: document.querySelector("#currency"),
  members: document.querySelector("#members"),
  tripForm: document.querySelector("#tripForm"),
  fuelForm: document.querySelector("#fuelForm"),
  settingsForm: document.querySelector("#settingsForm"),
  paymentOverview: document.querySelector("#paymentOverview"),
  settlements: document.querySelector("#settlements"),
  peopleBalances: document.querySelector("#peopleBalances"),
  tripList: document.querySelector("#tripList"),
  fuelList: document.querySelector("#fuelList"),
  closePeriod: document.querySelector("#closePeriod"),
  periodList: document.querySelector("#periodList"),
  resetData: document.querySelector("#resetData"),
  emptyTemplate: document.querySelector("#emptyTemplate")
};

state.lastOdometer = getLatestOdometer();
setDefaultDates();
render();
initializeSync();

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendLoginLink();
});

els.signOut.addEventListener("click", async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentSession = null;
  updateAuthUi();
});

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

els.tripForm.addEventListener("submit", (event) => {
  event.preventDefault();
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

  state.trips.push({
    id: crypto.randomUUID(),
    driver: els.tripDriver.value,
    participants,
    date: els.tripDate.value,
    startKm: round(start),
    endKm: round(end),
    note: els.tripNote.value.trim()
  });
  state.lastOdometer = getLatestOdometer();

  saveState();
  els.tripForm.reset();
  setDefaultDates();
  render();
});

els.fuelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const amount = Number(els.fuelAmount.value);

  if (amount <= 0) {
    alert("Fuel amount must be higher than zero.");
    return;
  }

  state.fuel.push({
    id: crypto.randomUUID(),
    payer: els.fuelPayer.value,
    date: els.fuelDate.value,
    amount: roundMoney(amount)
  });

  saveState();
  els.fuelForm.reset();
  setDefaultDates();
  render();
});

els.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const members = els.members.value
    .split(/\n|,/)
    .map((member) => member.trim())
    .filter(Boolean);

  if (members.length < 2) {
    alert("Add at least two people.");
    return;
  }

  state.currency = els.currency.value.trim() || defaults.currency;
  state.members = [...new Set(members)];
  state.trips = state.trips.filter((trip) => state.members.includes(trip.driver));
  state.trips = state.trips.map((trip) => ({
    ...trip,
    participants: getTripParticipants(trip).filter((member) => state.members.includes(member))
  }));
  state.fuel = state.fuel.filter((fuel) => state.members.includes(fuel.payer));

  saveState();
  render();
});

els.resetData.addEventListener("click", () => {
  if (!confirm("Reset all trips, fuel payments, and settings?")) return;
  state = structuredClone(defaults);
  saveState();
  setDefaultDates();
  render();
});

els.closePeriod.addEventListener("click", () => {
  closeCurrentPeriod();
});

document.addEventListener("click", (event) => {
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

  const button = event.target.closest("[data-delete]");
  if (!button) return;

  const [type, id] = button.dataset.delete.split(":");
  state[type] = state[type].filter((entry) => entry.id !== id);
  if (type === "trips") state.lastOdometer = getLatestOdometer();
  saveState();
  render();
});

function render() {
  renderSettings();
  renderPeopleSelectors();
  syncStartOdometerDefault();
  const ledger = calculateLedger();
  renderSummary(ledger);
  renderBalances(ledger);
  renderSettlements(ledger);
  renderHistory();
  renderClosedPeriods();
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
  updateAuthUi();

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentSession = session;
    updateAuthUi();
    if (session) await loadSupabaseState();
  });

  if (currentSession) await loadSupabaseState();
}

function updateAuthUi() {
  if (!supabaseClient) {
    els.authPanel.classList.add("hidden");
    return;
  }

  els.authPanel.classList.remove("hidden");
  els.loginForm.classList.toggle("hidden", Boolean(currentSession));
  els.signOut.classList.toggle("hidden", !currentSession);
  els.authMessage.textContent = currentSession
    ? `Signed in as ${currentSession.user.email}`
    : "Use an email login link to sync from any phone.";
  setSyncStatus(currentSession ? "Cloud" : "Login");
}

async function sendLoginLink() {
  if (!supabaseClient) return;

  const email = els.loginEmail.value.trim();
  if (!email) return;

  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split("#")[0] }
  });

  els.authMessage.textContent = error
    ? error.message
    : "Check your email and open the login link on this device.";
}

function renderSettings() {
  els.currency.value = state.currency;
  els.members.value = state.members.join("\n");
}

function renderPeopleSelectors() {
  if (!state.members.includes(currentUser)) {
    currentUser = state.members[0] || "";
    localStorage.setItem(userKey, currentUser);
  }

  const options = state.members
    .map((member) => `<option value="${escapeHtml(member)}">${escapeHtml(member)}</option>`)
    .join("");
  els.tripDriver.innerHTML = options;
  els.fuelPayer.innerHTML = options;
  els.currentUser.innerHTML = options;
  els.currentUser.value = currentUser;
  els.tripDriver.value = currentUser;
  els.fuelPayer.value = currentUser;
  renderParticipantOptions();
}

function renderParticipantOptions() {
  els.tripParticipants.innerHTML = state.members
    .map(
      (member) => `
        <label class="participant-option">
          <input type="checkbox" value="${escapeHtml(member)}" data-participant="${escapeHtml(member)}" checked />
          <span>${escapeHtml(member)}</span>
        </label>
      `
    )
    .join("");
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

  return {
    people,
    totalKm: round(totalKm),
    fuelRate,
    totalCost: roundMoney(totalCost),
    totalPaid: roundMoney(totalPaid),
    period: getLedgerPeriod(),
    settlements: buildSettlements(people)
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
          <div class="stat-row"><span>Share kilometers</span><b>${formatNumber(person.km)} km</b></div>
          <div class="stat-row"><span>Fuel share</span><b>${formatMoney(person.tripCost)}</b></div>
          <div class="stat-row"><span>Fuel paid</span><b>${formatMoney(person.fuelPaid)}</b></div>
        </article>
      `;
    })
    .join("");
}

function renderSettlements(ledger) {
  els.closePeriod.disabled = state.trips.length === 0 && state.fuel.length === 0;

  if (ledger.settlements.length === 0) {
    els.paymentOverview.replaceChildren();
    els.settlements.replaceChildren(emptyNode("All even."));
    return;
  }

  const activeKeys = new Set(ledger.settlements.map(settlementKey));
  for (const key of Object.keys(state.paymentStatuses)) {
    if (!activeKeys.has(key)) delete state.paymentStatuses[key];
  }
  saveState();
  renderPaymentOverview(ledger);

  els.settlements.innerHTML = ledger.settlements
    .map(
      (item) => {
        const key = settlementKey(item);
        const status = normalizePaymentStatus(state.paymentStatuses[key]);
        const fromPerson = ledger.people[item.from];
        const toPerson = ledger.people[item.to];
        const message = `${item.from} pays ${item.to} ${formatMoney(item.amount)} for shared car fuel`;
        return `
        <article class="settlement-card ${status === "requested" ? "is-requested" : ""}">
          <div class="settlement-main">
            <div>
              <strong>${escapeHtml(item.from)}</strong>
              <span> pays </span>
              <strong>${escapeHtml(item.to)}</strong>
              <span class="status-chip ${status}">${statusLabel(status)}</span>
            </div>
            <p>${escapeHtml(ledger.period.label)} · ${formatNumber(fromPerson.km)} share-km at ${formatMoney(ledger.fuelRate)}/km · ${escapeHtml(item.to)} paid ${formatMoney(toPerson.fuelPaid)}</p>
          </div>
          <div class="settlement-actions">
            <strong>${formatMoney(item.amount)}</strong>
            <button class="subtle-button compact-button" type="button" data-copy="${escapeHtml(message)}">Copy</button>
            ${status === "open" ? `<button class="subtle-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="requested">Requested</button>` : ""}
            ${status !== "open" ? `<button class="text-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="open">Reopen</button>` : ""}
          </div>
        </article>
      `;
      }
    )
    .join("");
}

function closeCurrentPeriod(options = {}) {
  if (state.trips.length === 0 && state.fuel.length === 0) {
    alert("Add trips or fuel before closing a period.");
    return;
  }

  const ledger = calculateLedger();
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

  state.closedPeriods.unshift(period);
  state.trips = [];
  state.fuel = [];
  state.paymentStatuses = {};
  state.lastOdometer = getLatestOdometer();
  saveState();
  setDefaultDates();
  render();
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

function updatePaymentStatus(button) {
  state.paymentStatuses[button.dataset.paymentKey] = button.dataset.paymentStatus;
  saveState();

  const ledger = calculateLedger();
  const allRequested =
    ledger.settlements.length > 0 &&
    ledger.settlements.every(
      (settlement) => normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]) === "requested"
    );

  if (
    button.dataset.paymentStatus === "requested" &&
    allRequested &&
    confirm(
      "All current settlements have been requested. Close and archive this period now so new trips start fresh?"
    )
  ) {
    closeCurrentPeriod({ skipConfirm: true });
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
              <button class="text-button" type="button" data-delete="trips:${trip.id}">Delete</button>
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
              <button class="text-button" type="button" data-delete="fuel:${fuel.id}">Delete</button>
            </header>
            <p>${formatMoney(fuel.amount)}</p>
            <p class="entry-meta">${formatDate(fuel.date)}</p>
          </article>
        `
      )
      .join("");
  }
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

function normalizeState(saved) {
  if (!saved) return structuredClone(defaults);

  return {
    ...structuredClone(defaults),
    ...saved,
    members: Array.isArray(saved.members) && saved.members.length ? saved.members : defaults.members,
    trips: Array.isArray(saved.trips) ? saved.trips : [],
    fuel: Array.isArray(saved.fuel) ? saved.fuel : [],
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
    lastOdometer: saved.lastOdometer ?? ""
  };
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

    state = normalizeState(data.state);
    state.lastOdometer = getLatestOdometer();
    localStorage.setItem(storageKey, JSON.stringify(state));
    setDefaultDates();
    render();
    setSyncStatus("Cloud");
  } catch (error) {
    els.authMessage.textContent = error.message || "Could not load cloud data.";
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

    state = normalizeState(data.state);
    localStorage.setItem(storageKey, JSON.stringify(state));
    setSyncStatus("Cloud");
  } catch (error) {
    els.authMessage.textContent = error.message || "Could not save cloud data.";
    setSyncStatus("Local");
  }
}

function setSyncStatus(label) {
  els.syncStatus.textContent = label;
  els.syncStatus.dataset.status = label.toLowerCase();
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
