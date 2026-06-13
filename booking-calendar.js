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

    let forcedCalendarAnchorDateKey = null;

    function setBookingCalendarAnchor(value) {
      const dateKey = String(value || "").slice(0, 10);
      forcedCalendarAnchorDateKey = isDateKey(dateKey) ? dateKey : null;
    }

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
        els.bookingCalendar.innerHTML = renderBookingMonthGrid(bookings);
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
      const start = getBookingCalendarAnchorDate(bookings, days);
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

    function renderBookingMonthGrid(bookings) {
      const todayKey = localDateString();
      const monthAnchor = getBookingMonthAnchorDate(bookings);
      monthAnchor.setDate(1);
      const month = monthAnchor.getMonth();
      const year = monthAnchor.getFullYear();
      const monthTitle = monthAnchor.toLocaleDateString("en-DK", { month: "long", year: "numeric" });
      const firstWeekday = (monthAnchor.getDay() + 6) % 7;
      const gridStart = new Date(monthAnchor);
      gridStart.setDate(monthAnchor.getDate() - firstWeekday);
      const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const dayBuckets = Array.from({ length: 42 }, (_, index) => {
        const date = new Date(gridStart);
        date.setDate(gridStart.getDate() + index);
        const key = localDateString(date);
        const items = bookings.filter((booking) => bookingTouchesDate(booking, key));
        return { date, key, items, outsideMonth: date.getMonth() !== month };
      });

      return `
        <section class="booking-month" aria-label="${escapeHtml(monthTitle)} bookings">
          <header class="booking-month-header">
            <h3>${escapeHtml(monthTitle)}</h3>
            <p class="section-note compact-note">Use the Start and End fields above this calendar to choose a booking range while checking availability.</p>
          </header>
          <div class="booking-month-weekdays" aria-hidden="true">
            ${weekdayLabels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}
          </div>
          <div class="booking-month-grid">
            ${dayBuckets.map(({ date, key, items, outsideMonth }) => renderBookingMonthDay(date, key, items, outsideMonth, key === todayKey, year, month)).join("")}
          </div>
        </section>
      `;
    }


    function getBookingCalendarAnchorDate(bookings, days) {
      const todayKey = localDateString();
      const today = new Date(todayKey);
      if (forcedCalendarAnchorDateKey && isDateKey(forcedCalendarAnchorDateKey)) {
        const forcedEnd = new Date(forcedCalendarAnchorDateKey);
        forcedEnd.setDate(forcedEnd.getDate() + Math.max(0, days - 1));
        const forcedEndKey = localDateString(forcedEnd);
        const forcedWindowHasBooking = bookings.some((booking) => {
          const startKey = String(booking.start || "").slice(0, 10);
          const endKey = String(booking.end || "").slice(0, 10);
          return startKey <= forcedEndKey && endKey >= forcedCalendarAnchorDateKey;
        });
        if (bookings.length === 0 || forcedWindowHasBooking) {
          return new Date(forcedCalendarAnchorDateKey);
        }
      }
      const selectedStart = String(els.bookingStart?.value || "").slice(0, 10);
      if (selectedStart && isDateKey(selectedStart)) {
        const selectedEnd = new Date(selectedStart);
        selectedEnd.setDate(selectedEnd.getDate() + Math.max(0, days - 1));
        const selectedEndKey = localDateString(selectedEnd);
        const selectedWindowHasBooking = bookings.some((booking) => {
          const startKey = String(booking.start || "").slice(0, 10);
          const endKey = String(booking.end || "").slice(0, 10);
          return startKey <= selectedEndKey && endKey >= selectedStart;
        });
        if (bookings.length === 0 || selectedWindowHasBooking) {
          return new Date(selectedStart);
        }
      }

      const visibleEnd = new Date(today);
      visibleEnd.setDate(today.getDate() + Math.max(0, days - 1));
      const visibleEndKey = localDateString(visibleEnd);
      const hasVisibleBooking = bookings.some((booking) => {
        const startKey = String(booking.start || "").slice(0, 10);
        const endKey = String(booking.end || "").slice(0, 10);
        return startKey <= visibleEndKey && endKey >= todayKey;
      });
      if (hasVisibleBooking) return today;

      const futureBooking = bookings
        .filter((booking) => String(booking.end || "").slice(0, 10) >= todayKey)
        .sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")))[0];
      if (futureBooking && isDateKey(String(futureBooking.start || "").slice(0, 10))) {
        return new Date(String(futureBooking.start).slice(0, 10));
      }

      const pastBooking = [...bookings]
        .filter((booking) => String(booking.start || "").slice(0, 10) < todayKey)
        .sort((a, b) => String(b.start || "").localeCompare(String(a.start || "")))[0];
      if (pastBooking && isDateKey(String(pastBooking.start || "").slice(0, 10))) {
        return new Date(String(pastBooking.start).slice(0, 10));
      }

      return today;
    }

    function getBookingMonthAnchorDate(bookings) {
      const today = new Date(localDateString());
      if (forcedCalendarAnchorDateKey && isDateKey(forcedCalendarAnchorDateKey)) {
        const forcedDate = new Date(forcedCalendarAnchorDateKey);
        const forcedYear = forcedDate.getFullYear();
        const forcedMonth = forcedDate.getMonth();
        const forcedMonthHasBooking = bookings.some((booking) => {
          const start = parseBookingDate(booking.start);
          const end = parseBookingDate(booking.end);
          return (start && start.getFullYear() === forcedYear && start.getMonth() === forcedMonth)
            || (end && end.getFullYear() === forcedYear && end.getMonth() === forcedMonth);
        });
        if (bookings.length === 0 || forcedMonthHasBooking) {
          return forcedDate;
        }
      }
      const selectedStart = String(els.bookingStart?.value || "").slice(0, 10);
      if (selectedStart && isDateKey(selectedStart)) {
        const selectedDate = new Date(selectedStart);
        const selectedYear = selectedDate.getFullYear();
        const selectedMonth = selectedDate.getMonth();
        const selectedMonthHasBooking = bookings.some((booking) => {
          const start = parseBookingDate(booking.start);
          const end = parseBookingDate(booking.end);
          return (start && start.getFullYear() === selectedYear && start.getMonth() === selectedMonth)
            || (end && end.getFullYear() === selectedYear && end.getMonth() === selectedMonth);
        });
        if (bookings.length === 0 || selectedMonthHasBooking) {
          return selectedDate;
        }
      }

      const year = today.getFullYear();
      const month = today.getMonth();
      const hasThisMonthBooking = bookings.some((booking) => {
        const start = parseBookingDate(booking.start);
        const end = parseBookingDate(booking.end);
        return (start && start.getFullYear() === year && start.getMonth() === month)
          || (end && end.getFullYear() === year && end.getMonth() === month);
      });
      if (hasThisMonthBooking) return today;

      return getBookingCalendarAnchorDate(bookings, 31);
    }

    function isDateKey(value) {
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
    }

    function renderBookingMonthDay(date, key, items, outsideMonth, isToday, year, month) {
      const status = items.length ? "booked" : "free";
      const label = date.toLocaleDateString("en-DK", { weekday: "long", day: "2-digit", month: "long" });
      const bookingText = items.length ? `${items.length} booking${items.length === 1 ? "" : "s"}` : "Free";
      return `
        <article class="booking-month-day ${status}${outsideMonth ? " outside-month" : ""}${isToday ? " today" : ""}" aria-label="${escapeHtml(`${label}: ${bookingText}`)}">
          <header>
            <strong>${escapeHtml(date.toLocaleDateString("en-DK", { day: "2-digit" }))}</strong>
            <small>${escapeHtml(bookingText)}</small>
          </header>
          <div class="booking-month-day-body">
            ${items.length ? items.slice(0, 2).map((booking) => renderBookingMonthChip(booking, key)).join("") : `<p class="empty-state compact-empty">Free</p>`}
            ${items.length > 2 ? `<p class="section-note compact-note">+${items.length - 2} more</p>` : ""}
          </div>
        </article>
      `;
    }

    function renderBookingMonthChip(booking, dateKey) {
      const start = parseBookingDate(booking.start);
      const end = parseBookingDate(booking.end);
      const time = start && end
        ? `${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}-${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "Time missing";
      const isFinalBookingDay = String(booking.end || "").slice(0, 10) === dateKey;
      const logTripButton = isFinalBookingDay && canCreateTripFromBooking(booking)
        ? `<button class="subtle-button compact-button booking-month-log-button" type="button" data-convert-booking-to-trip="${escapeHtml(booking.id)}">Log trip</button>`
        : "";
      return `
        <div class="booking-month-chip ${escapeHtml(getBookingStatus(booking))}">
          <strong>${escapeHtml(booking.member || "Booked")}</strong>
          <span>${escapeHtml(time)}</span>
          ${booking.purpose ? `<span class="booking-month-chip-purpose">${escapeHtml(booking.purpose)}</span>` : ""}
          ${logTripButton}
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

    function clearBookingAvailabilityPreview(message = "Choose a time to check availability.") {
      renderBookingConflictNotice(null);
      if (!els.bookingAvailabilityPreview) return;
      els.bookingAvailabilityPreview.classList.remove("available", "conflict", "invalid");
      els.bookingAvailabilityPreview.classList.add("empty-state");
      els.bookingAvailabilityPreview.textContent = message;
      els.bookingStart?.removeAttribute("aria-invalid");
      els.bookingEnd?.removeAttribute("aria-invalid");
    }

    function renderBookingAvailabilityPreview(candidate, editingId = null) {
      renderBookingDateHints();
      if (!candidate) {
        clearBookingAvailabilityPreview();
        return;
      }
      if (!els.bookingAvailabilityPreview) {
        renderBookingConflictNotice(candidate ? findBookingConflict(candidate, editingId) : null, candidate);
        return;
      }

      const preview = els.bookingAvailabilityPreview;
      const startMs = Date.parse(candidate?.start || "");
      const endMs = Date.parse(candidate?.end || "");
      preview.classList.remove("available", "conflict", "invalid", "empty-state");
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
      setBookingCalendarAnchor,
      renderBookingConflictNotice,
      renderBookingAvailabilityPreview,
      clearBookingAvailabilityPreview,
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
