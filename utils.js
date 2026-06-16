// Shared pure helper functions for the Fuel Sharing app.
// Keep this file free of DOM, Supabase, and application state dependencies.

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


function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
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

function normalizedDate(value) {
  return String(value || localDateString()).slice(0, 10);
}

function nullableNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : null;
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

function formatMoneyFor(value, currency) {
  return `${new Intl.NumberFormat("en-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(roundMoney(value))} ${currency}`;
}

function formatMoney(value, currency = (typeof state !== "undefined" && state?.currency) || "DKK") {
  return formatMoneyFor(value, currency);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-DK", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(`${value}T12:00:00`));
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


const PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  open: Object.freeze(["requested"]),
  requested: Object.freeze(["paid", "open", "cancelled"]),
  paid: Object.freeze(["open"]),
  cancelled: Object.freeze(["requested", "open"])
});

function isValidPaymentStatusTransition(previousStatus, nextStatus) {
  const previous = normalizePaymentStatus(previousStatus);
  const next = normalizePaymentStatus(nextStatus);
  if (previous === next) return true;
  return PAYMENT_STATUS_TRANSITIONS[previous]?.includes(next) || false;
}

function paymentStatusTransitionMessage(previousStatus, nextStatus) {
  const previous = normalizePaymentStatus(previousStatus);
  const next = normalizePaymentStatus(nextStatus);
  if (isValidPaymentStatusTransition(previous, next)) return "";
  if (previous === "open" && next === "paid") return "Request the payment before marking it paid.";
  if (previous === "paid" && next === "requested") return "Reopen the paid payment before sending a new request.";
  return `Payment status cannot change from ${statusLabel(previous).toLowerCase()} to ${statusLabel(next).toLowerCase()}.`;
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
