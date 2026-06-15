(function () {
  function normalizeTripParticipantSelection(availableMembers = [], selectedMembers = [], fallbackMembers = []) {
    const available = new Set((availableMembers || []).map((member) => String(member || "")).filter(Boolean));
    const selected = (selectedMembers || [])
      .map((member) => String(member || ""))
      .filter((member, index, list) => member && available.has(member) && list.indexOf(member) === index);
    if (selected.length) return selected;
    return (fallbackMembers || [])
      .map((member) => String(member || ""))
      .filter((member, index, list) => member && available.has(member) && list.indexOf(member) === index);
  }

  function getCheckedCheckboxValues(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value);
  }

  function setCheckboxSelection(container, selectedValues = []) {
    if (!container) return [];
    const selected = new Set((selectedValues || []).map((value) => String(value || "")));
    const applied = [];
    for (const input of container.querySelectorAll('input[type="checkbox"]')) {
      const shouldCheck = selected.has(input.value);
      input.checked = shouldCheck;
      if (shouldCheck) applied.push(input.value);
    }
    container.dispatchEvent(new Event("change", { bubbles: true }));
    return applied;
  }

  function readPlannerRoute(startValue = "", destinationValue = "") {
    const start = String(startValue || "").trim();
    const destination = String(destinationValue || "").trim();
    return { start, destination, hasRoute: Boolean(start && destination) };
  }

  function buildRouteMapUrl(route) {
    if (!route?.hasRoute) return "";
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(route.start)}&destination=${encodeURIComponent(route.destination)}&travelmode=driving`;
  }

  window.TripActions = Object.freeze({
    normalizeTripParticipantSelection,
    getCheckedCheckboxValues,
    setCheckboxSelection,
    readPlannerRoute,
    buildRouteMapUrl
  });
}());
