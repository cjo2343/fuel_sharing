(function () {
  "use strict";

  function createBookingCalendarController(deps) {
    const {
      els,
      getState,
      getBookingCalendarView,
      setBookingCalendarViewValue,
      bookingCalendarViewStorageKey,
      escapeHtml,
      localDateString,
      renderPermissionNote,
      canManageBookingEntry,
      canCreateTripFromBooking,
      describeCurrentActor
    } = deps;

    function renderBookings() {
      if (!els.bookingCalendar) return;
      renderBookingConflictNotice(null);
      renderBookingCalendarViewControls();

      const bookings = [...getState().bookings].sort((a, b) => String(a.start).localeCompare(String(b.start)));
      if (bookings.length === 0) {
        els.bookingCalendar.className = "booking-calendar empty-state";
        els.bookingCalendar.textContent = "No bookings yet.";
        return;
      }

      const now = Date.now();
      const today = localDateString();
      const todayBookings = bookings.filter((booking) => String(booking.start).slice(0, 10) <= today && String(booking.end).slice(0, 10) >= today);
      const upcomingBookings = bookings.filter((booking) => bookingStartMs(booking) >= now && !todayBookings.some((item) => item.id === booking.id));
      const pastBookings = bookings.filter((booking) => bookingEndMs(booking) < now && !todayBookings.some((item) => item.id === booking.id)).slice(-8).reverse();

      const view = getBookingCalendarView();
      els.bookingCalendar.className = `booking-calendar ${escapeHtml(view)}-view`;
      if (view === "week") {
        els.bookingCalendar.innerHTML = renderBookingDayGrid(bookings, 7);
        return;
      }

      if (view === "month") {
        els.bookingCalendar.innerHTML = renderBookingDayGrid(bookings, 30);
        return;
      }

      els.bookingCalendar.innerHTML = `
        ${renderBookingGroup("Today", todayBookings, "No booking today.")}
        ${renderBookingGroup("Upcoming", upcomingBookings, "No upcoming bookings.")}
        ${renderBookingGroup("Past", pastBookings, "No past bookings.")}
      `;
    }

    function setBookingCalendarView(view) {
      const nextView = ["list", "week", "month"].includes(view) ? view : "list";
      setBookingCalendarViewValue(nextView);
      localStorage.setItem(bookingCalendarViewStorageKey, nextView);
      renderBookings();
    }

    function renderBookingCalendarViewControls() {
      document.querySelectorAll("[data-booking-calendar-view]").forEach((button) => {
        const active = button.dataset.bookingCalendarView === getBookingCalendarView();
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }

    function renderBookingDayGrid(bookings, days) {
      const start = new Date(localDateString());
      const dayBuckets = Array.from({ length: days }, (_, index) => {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        const key = localDateString(date);
        const items = bookings.filter((booking) => bookingTouchesDate(booking, key));
        return { date, key, items };
      });

      return `
        <div class="booking-day-grid" data-booking-grid="${days === 7 ? "week" : "month"}">
          ${dayBuckets.map(({ date, key, items }) => `
            <section class="booking-day-column ${key === localDateString() ? "today" : ""}" aria-label="${escapeHtml(formatBookingDayHeading(date))}">
              <h3><span>${escapeHtml(formatBookingDayHeading(date))}</span><small>${items.length || "Free"}</small></h3>
              <div class="booking-card-list compact-booking-list">
                ${items.length ? items.map(renderBookingCard).join("") : `<p class="empty-state compact-empty">Free</p>`}
              </div>
            </section>
          `).join("")}
        </div>
      `;
    }

    function bookingTouchesDate(booking, dateKey) {
      return String(booking.start).slice(0, 10) <= dateKey && String(booking.end).slice(0, 10) >= dateKey;
    }

    function formatBookingDayHeading(date) {
      return date.toLocaleDateString("en-DK", { weekday: "short", day: "2-digit", month: "short" });
    }

    function renderBookingGroup(title, bookings, emptyText) {
      return `
        <section class="booking-group" aria-label="${escapeHtml(title)} bookings">
          <h3>${escapeHtml(title)}</h3>
          <div class="booking-card-list">
            ${bookings.length ? bookings.map(renderBookingCard).join("") : `<p class="empty-state compact-empty">${escapeHtml(emptyText)}</p>`}
          </div>
        </section>
      `;
    }

    function renderBookingCard(booking) {
      const status = getBookingStatus(booking);
      const actionButtons = [
        canCreateTripFromBooking(booking) ? `<button class="subtle-button compact-button" type="button" data-convert-booking-to-trip="${escapeHtml(booking.id)}">Log trip</button>` : "",
        canManageBookingEntry(booking) ? `<button class="subtle-button compact-button" type="button" data-edit="bookings:${escapeHtml(booking.id)}">Edit</button>` : "",
        canManageBookingEntry(booking) ? `<button class="text-button compact-button" type="button" data-delete="bookings:${escapeHtml(booking.id)}">Delete</button>` : ""
      ].filter(Boolean).join("");
      return `
        <article class="entry-card booking-card ${escapeHtml(status)}">
          <header>
            <strong>${escapeHtml(booking.member)}</strong>
            <div class="entry-actions">${actionButtons}</div>
          </header>
          ${!canManageBookingEntry(booking) ? renderPermissionNote(describeBookingPermissionMessage(booking, "edit or delete")) : ""}
          <p>${escapeHtml(formatBookingRange(booking))} <span class="category-chip">${escapeHtml(statusLabelForBooking(status))}</span></p>
          ${booking.purpose ? `<p>${escapeHtml(booking.purpose)}</p>` : ""}
        </article>
      `;
    }


    function renderBookingDateHints(days = 21) {
      if (!els.bookingDateHints) return;
      const start = new Date(localDateString());
      const selectedStart = String(els.bookingStart?.value || "").slice(0, 10);
      const selectedEnd = String(els.bookingEnd?.value || "").slice(0, 10);
      const hintDays = Array.from({ length: days }, (_, index) => {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        const key = localDateString(date);
        const items = getState().bookings.filter((booking) => bookingTouchesDate(booking, key));
        const status = items.length ? "booked" : "free";
        const selected = key === selectedStart || key === selectedEnd || (selectedStart && selectedEnd && key > selectedStart && key < selectedEnd);
        const label = items.length
          ? `${formatBookingDayHeading(date)}: ${items.length} booking${items.length === 1 ? "" : "s"}`
          : `${formatBookingDayHeading(date)}: free`;
        return `
          <button class="booking-date-hint ${status}${selected ? " selected" : ""}" type="button" data-booking-date-hint="${escapeHtml(key)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
            <span>${escapeHtml(date.toLocaleDateString("en-DK", { weekday: "short" }))}</span>
            <strong>${escapeHtml(date.toLocaleDateString("en-DK", { day: "2-digit" }))}</strong>
          </button>
        `;
      });
      els.bookingDateHints.innerHTML = `
        <div class="booking-date-hint-header">
          <span>Date availability</span>
          <small><span class="availability-dot free"></span> Free <span class="availability-dot booked"></span> Booked</small>
        </div>
        <div class="booking-date-hint-list">${hintDays.join("")}</div>
        <p class="section-note compact-note">Native date pickers cannot be colored reliably across browsers, so this overview shows taken dates before you open the picker.</p>
      `;
    }

    function renderBookingConflictNotice(conflict, candidate = null) {
      if (!els.bookingConflictNotice) return;
      if (!conflict) {
        els.bookingConflictNotice.classList.add("hidden");
        els.bookingConflictNotice.textContent = "";
        return;
      }
      els.bookingConflictNotice.classList.remove("hidden");
      els.bookingConflictNotice.innerHTML = renderBookingConflictMessage(conflict, candidate);
    }

    function renderBookingConflictMessage(conflict, candidate = null) {
      const nextSlot = candidate ? findNextAvailableSlot(candidate) : null;
      const purpose = conflict.purpose ? ` · ${escapeHtml(conflict.purpose)}` : "";
      return `
        <strong>Conflicts with ${escapeHtml(conflict.member)}'s booking.</strong>
        <span>${escapeHtml(formatBookingRange(conflict))}${purpose}</span>
        ${nextSlot ? `<span>Same length looks free from ${escapeHtml(formatBookingRange(nextSlot))}.</span>` : ""}
      `;
    }

    function renderBookingAvailabilityPreview(candidate, editingId = null) {
      renderBookingDateHints();
      if (!els.bookingAvailabilityPreview) {
        renderBookingConflictNotice(candidate ? findBookingConflict(candidate, editingId) : null, candidate);
        return;
      }

      const preview = els.bookingAvailabilityPreview;
      const startMs = Date.parse(candidate?.start || "");
      const endMs = Date.parse(candidate?.end || "");
      preview.classList.remove("available", "conflict", "invalid");
      els.bookingStart?.removeAttribute("aria-invalid");
      els.bookingEnd?.removeAttribute("aria-invalid");

      if (!candidate || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        renderBookingConflictNotice(null);
        preview.classList.add("invalid");
        preview.textContent = "Choose a valid start and end time to check availability.";
        return;
      }

      if (endMs <= startMs) {
        renderBookingConflictNotice(null);
        preview.classList.add("invalid");
        preview.textContent = "End time must be after the start time.";
        els.bookingStart?.setAttribute("aria-invalid", "true");
        els.bookingEnd?.setAttribute("aria-invalid", "true");
        return;
      }

      const conflict = findBookingConflict(candidate, editingId);
      if (conflict) {
        renderBookingConflictNotice(conflict, candidate);
        preview.classList.add("conflict");
        preview.innerHTML = renderBookingConflictMessage(conflict, candidate);
        els.bookingStart?.setAttribute("aria-invalid", "true");
        els.bookingEnd?.setAttribute("aria-invalid", "true");
        return;
      }

      renderBookingConflictNotice(null);
      preview.classList.add("available");
      preview.textContent = `Available: ${formatBookingRange(candidate)}.`;
    }

    function validateBookingInput(booking, editingId = null) {
      if (!booking.member) return { ok: false, message: "Choose who is booking the car." };
      const start = Date.parse(booking.start);
      const end = Date.parse(booking.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, message: "Choose a valid start and end time." };
      if (end <= start) return { ok: false, message: "Booking end must be after the start time." };
      const conflict = findBookingConflict(booking, editingId);
      if (conflict) {
        return {
          ok: false,
          message: `The car is already booked by ${conflict.member} for ${formatBookingRange(conflict)}.`,
          conflict
        };
      }
      return { ok: true };
    }

    function findBookingConflict(candidate, editingId = null) {
      const candidateStart = Date.parse(candidate.start);
      const candidateEnd = Date.parse(candidate.end);
      return getState().bookings.find((booking) => {
        if (booking.id === editingId) return false;
        const start = bookingStartMs(booking);
        const end = bookingEndMs(booking);
        return Number.isFinite(start) && Number.isFinite(end) && candidateStart < end && candidateEnd > start;
      }) || null;
    }

    function findNextAvailableSlot(candidate, editingId = null) {
      const candidateStart = Date.parse(candidate?.start || "");
      const candidateEnd = Date.parse(candidate?.end || "");
      if (!Number.isFinite(candidateStart) || !Number.isFinite(candidateEnd) || candidateEnd <= candidateStart) return null;

      const duration = candidateEnd - candidateStart;
      let nextStart = candidateStart;
      const sortedBookings = [...getState().bookings]
        .filter((booking) => booking.id !== editingId && booking.id !== candidate.id)
        .sort((a, b) => bookingStartMs(a) - bookingStartMs(b));

      let moved = false;
      let changed = true;
      while (changed) {
        changed = false;
        const nextEnd = nextStart + duration;
        for (const booking of sortedBookings) {
          const bookingStart = bookingStartMs(booking);
          const bookingEnd = bookingEndMs(booking);
          if (!Number.isFinite(bookingStart) || !Number.isFinite(bookingEnd)) continue;
          if (bookingStart >= nextEnd) break;
          if (nextStart < bookingEnd && nextEnd > bookingStart) {
            nextStart = bookingEnd;
            moved = true;
            changed = true;
            break;
          }
        }
      }

      if (!moved) return null;
      return {
        ...candidate,
        start: toDateTimeLocalInputValue(new Date(nextStart)),
        end: toDateTimeLocalInputValue(new Date(nextStart + duration))
      };
    }

    function describeBookingPermissionMessage(booking, action) {
      const actor = describeCurrentActor();
      if (!booking) return `This booking no longer exists. Refresh and try again.`;
      return `Only ${booking.member}, the person who booked the car, or an admin can ${action} this booking. You are signed in as ${actor}.`;
    }

    return {
      renderBookings,
      setBookingCalendarView,
      renderBookingConflictNotice,
      renderBookingAvailabilityPreview,
      validateBookingInput,
      findBookingConflict,
      getBookingStatus,
      statusLabelForBooking,
      bookingStartMs,
      bookingEndMs,
      normalizeBookingDateTime,
      bookingDateTimeToIso,
      isBookingOverlapError,
      isMissingBookingTableError,
      toDateTimeLocalInputValue,
      formatBookingRange,
      parseBookingDate,
      describeBookingAuditChanges,
      describeBookingPermissionMessage
    };
  }

  function getBookingStatus(booking) {
    const now = Date.now();
    if (bookingEndMs(booking) < now) return "past";
    if (bookingStartMs(booking) <= now && bookingEndMs(booking) >= now) return "active";
    return "upcoming";
  }

  function statusLabelForBooking(status) {
    if (status === "active") return "In use";
    if (status === "past") return "Past";
    return "Upcoming";
  }

  function bookingStartMs(booking) {
    return Date.parse(booking?.start || "");
  }

  function bookingEndMs(booking) {
    return Date.parse(booking?.end || "");
  }

  function normalizeBookingDateTime(value) {
    return String(value || "").slice(0, 16);
  }

  function bookingDateTimeToIso(value) {
    const date = new Date(String(value || ""));
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  function isBookingOverlapError(error) {
    const message = String(error?.message || error?.details || error || "").toLowerCase();
    return error?.code === "23P01" || message.includes("already booked") || message.includes("overlap");
  }

  function isMissingBookingTableError(error) {
    const message = String(error?.message || error?.details || error || "").toLowerCase();
    return message.includes("car_bookings") && (error?.code === "42P01" || message.includes("does not exist") || message.includes("not found"));
  }

  function toDateTimeLocalInputValue(date) {
    const local = new Date(date);
    local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
    return local.toISOString().slice(0, 16);
  }

  function formatBookingRange(booking) {
    const start = parseBookingDate(booking?.start);
    const end = parseBookingDate(booking?.end);
    if (!start || !end) return "Time missing";
    const sameDay = start.toLocaleDateString("en-CA") === end.toLocaleDateString("en-CA");
    const dateText = start.toLocaleDateString("en-DK", { day: "2-digit", month: "short", year: "numeric" });
    const startTime = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const endTime = end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return `${dateText} · ${startTime}-${endTime}`;
    const endDateText = end.toLocaleDateString("en-DK", { day: "2-digit", month: "short", year: "numeric" });
    return `${dateText} ${startTime} - ${endDateText} ${endTime}`;
  }

  function parseBookingDate(value) {
    const date = new Date(String(value || ""));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function describeBookingAuditChanges(previousBooking, nextBooking) {
    if (!previousBooking) return nextBooking?.purpose || "";
    const changes = [];
    if (previousBooking.member !== nextBooking.member) changes.push(`Driver: ${previousBooking.member || "-"} -> ${nextBooking.member || "-"}`);
    if (previousBooking.start !== nextBooking.start || previousBooking.end !== nextBooking.end) changes.push(`Time: ${formatBookingRange(previousBooking)} -> ${formatBookingRange(nextBooking)}`);
    if ((previousBooking.purpose || "") !== (nextBooking.purpose || "")) changes.push(`Purpose: ${previousBooking.purpose || "-"} -> ${nextBooking.purpose || "-"}`);
    return changes.join("; ");
  }

  window.FuelBookingCalendar = { createBookingCalendarController };
}());
