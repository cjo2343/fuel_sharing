(function () {
  const PRIVACY_MODES = Object.freeze({
    STATION_ONLY: "station-only",
    NO_COORDINATES: "no-coordinates",
    FULL: "full"
  });

  function normalizeLocationPrivacyMode(mode) {
    const value = String(mode || "").trim().toLowerCase();
    if (Object.values(PRIVACY_MODES).includes(value)) return value;
    return PRIVACY_MODES.STATION_ONLY;
  }

  function safeCoordinate(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number === 0) return null;
    return Number(number.toFixed(6));
  }

  function coordinatePair(latitude, longitude) {
    const lat = safeCoordinate(latitude);
    const lon = safeCoordinate(longitude);
    if (lat === null || lon === null) return null;
    return { latitude: lat, longitude: lon };
  }

  function buildFuelLocationPayload(input = {}) {
    const mode = normalizeLocationPrivacyMode(input.mode);
    const stationName = String(input.stationName || "").trim();
    const stationBrand = String(input.stationBrand || "").trim();
    const userLocation = coordinatePair(input.userLatitude, input.userLongitude);
    const stationLocation = coordinatePair(input.stationLatitude, input.stationLongitude);

    const stationInfo = mode === PRIVACY_MODES.NO_COORDINATES || !stationLocation
      ? null
      : {
          name: stationName,
          brand: stationBrand,
          ...stationLocation
        };

    return {
      mode,
      location: mode === PRIVACY_MODES.FULL ? userLocation : null,
      stationInfo
    };
  }

  function inferFuelLocationPrivacyMode(fuel = {}) {
    if (fuel.location?.latitude && fuel.location?.longitude) return PRIVACY_MODES.FULL;
    if (fuel.stationInfo?.latitude && fuel.stationInfo?.longitude) return PRIVACY_MODES.STATION_ONLY;
    return PRIVACY_MODES.NO_COORDINATES;
  }

  window.FuelLocationPrivacy = {
    PRIVACY_MODES,
    normalizeLocationPrivacyMode,
    safeCoordinate,
    coordinatePair,
    buildFuelLocationPayload,
    inferFuelLocationPrivacyMode
  };
})();
