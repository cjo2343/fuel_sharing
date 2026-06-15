(function () {
  "use strict";

  function stripBookingPrefix(value) {
    return String(value || "").replace(/^Booking:\s*/i, "");
  }

  function getBookingLinkedTripContext({ pendingContext = null, editingTripId = null, trips = [], bookings = [], createLogRef, extractEstimatedDistanceFromText }) {
    if (pendingContext) return pendingContext;
    if (!editingTripId) return null;
    const trip = trips.find((entry) => entry.id === editingTripId);
    const isBookingLinkedTrip = Boolean(trip?.sourceBookingId || trip?.bookingStart || trip?.bookingEnd);
    if (!isBookingLinkedTrip) return null;
    const booking = bookings.find((entry) => entry.id === trip.sourceBookingId);
    return {
      bookingId: trip.sourceBookingId || "",
      logRef: trip.logRef || createLogRef(trip.id),
      bookingStart: trip.bookingStart || null,
      bookingEnd: trip.bookingEnd || null,
      plannedDistanceKm: Number(booking?.plannedDistanceKm || extractEstimatedDistanceFromText(trip.note || "") || 0),
      member: trip.driver || "",
      purpose: stripBookingPrefix(trip.note)
    };
  }

  function buildTripContextFromBooking(booking, { createLogRef, extractEstimatedDistanceFromText }) {
    if (!booking) return null;
    return {
      bookingId: booking.id,
      logRef: booking.logRef || createLogRef(booking.id),
      bookingStart: booking.start || null,
      bookingEnd: booking.end || null,
      plannedDistanceKm: Number(booking.plannedDistanceKm || extractEstimatedDistanceFromText(booking.purpose || "") || 0),
      member: booking.member || "",
      purpose: booking.purpose || ""
    };
  }

  function plannedTripParticipantsFromBooking(booking) {
    if (!booking) return [];
    const plannedParticipants = Array.isArray(booking.plannedParticipants) ? booking.plannedParticipants : [];
    return [...new Set([booking.member, ...plannedParticipants].filter(Boolean))];
  }

  function renderTripBookingContextHtml(context, { driver = "", period = "", escapeHtml, formatTypedLogRef }) {
    const purpose = context.purpose ? `<span>${escapeHtml(context.purpose)}</span>` : `<span>No purpose added</span>`;
    return `
    <div class="booking-log-context-header">
      <div>
        <p class="eyebrow">Booking ${escapeHtml(formatTypedLogRef(context, "booking"))}</p>
        <h3>${escapeHtml(formatTypedLogRef(context, "trip"))}</h3>
      </div>
      <span class="status-pill">Ready to complete</span>
    </div>
    <dl class="booking-log-summary">
      <div><dt>Booking</dt><dd>${escapeHtml(formatTypedLogRef(context, "booking"))}</dd></div>
      <div><dt>Driver</dt><dd>${escapeHtml(context.member || driver || "Driver")}</dd></div>
      <div><dt>Period</dt><dd>${escapeHtml(period)}</dd></div>
      <div><dt>Purpose</dt><dd>${purpose}</dd></div>
    </dl>
    <p class="section-note">Enter the final odometer. The trip date is set to the booking end date.</p>
  `;
  }

  function buildFuelContextFromTrip(trip, { bookings = [], createLogRef, isTripFromMultiDayBooking, round }) {
    if (!trip) return null;
    const booking = trip.sourceBookingId ? bookings.find((entry) => entry.id === trip.sourceBookingId) : null;
    return {
      tripId: trip.id,
      bookingId: trip.sourceBookingId || null,
      logRef: trip.logRef || createLogRef(trip.id),
      bookingStart: trip.bookingStart || null,
      bookingEnd: trip.bookingEnd || null,
      member: trip.driver || "",
      purpose: stripBookingPrefix(trip.note),
      distanceKm: round(Number(trip.endKm || 0) - Number(trip.startKm || 0)),
      requiredFuel: isTripFromMultiDayBooking(trip, booking),
      date: trip.date || "",
      odometer: trip.endKm || ""
    };
  }

  function renderFuelTripContextHtml(context, { period = "", escapeHtml, formatNumber, formatTypedLogRef }) {
    const purpose = context.purpose ? escapeHtml(context.purpose) : "No purpose added";
    const requirement = context.requiredFuel ? "Required for multi-day booking" : "Suggested for this trip";
    return `
    <div class="booking-log-context-header">
      <div>
        <p class="eyebrow">Fuel for trip</p>
        <h3>${escapeHtml(formatTypedLogRef(context, "fuel"))}</h3>
      </div>
      <span class="status-pill">${escapeHtml(requirement)}</span>
    </div>
    <dl class="booking-log-summary">
      <div><dt>Driver</dt><dd>${escapeHtml(context.member || "Driver")}</dd></div>
      <div><dt>Period</dt><dd>${escapeHtml(period)}</dd></div>
      <div><dt>Distance</dt><dd>${escapeHtml(formatNumber(context.distanceKm || 0))} km</dd></div>
      <div><dt>Purpose</dt><dd>${purpose}</dd></div>
    </dl>
    <p class="section-note">${context.requiredFuel ? "Add the full-tank refuel receipt before closing this settlement period. Paid by, date and odometer are prefilled from the trip." : "Add the refuel receipt for this booking if fuel was bought. Paid by, date and odometer are prefilled from the trip."}</p>
  `;
  }

  window.PlannerBookingBridge = Object.freeze({
    stripBookingPrefix,
    getBookingLinkedTripContext,
    buildTripContextFromBooking,
    plannedTripParticipantsFromBooking,
    renderTripBookingContextHtml,
    buildFuelContextFromTrip,
    renderFuelTripContextHtml
  });
})();
