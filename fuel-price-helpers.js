(function () {
  const defaultWarningRange = Object.freeze({
    minDkkPerLiter: 8,
    maxDkkPerLiter: 25
  });

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function getFallbackRange(options = {}) {
    return options.fallbackRange || defaultWarningRange;
  }

  function getFuelPriceWarningRange(source = {}, options = {}) {
    const fallbackRange = getFallbackRange(options);
    const min = Number(source?.fuelPriceWarningMinDkkPerLiter);
    const max = Number(source?.fuelPriceWarningMaxDkkPerLiter);
    const fallbackMin = fallbackRange.minDkkPerLiter;
    const fallbackMax = fallbackRange.maxDkkPerLiter;
    const normalizedMin = Number.isFinite(min) && min > 0 ? min : fallbackMin;
    const normalizedMax = Number.isFinite(max) && max > normalizedMin ? max : Math.max(fallbackMax, normalizedMin + 1);
    return { minDkkPerLiter: normalizedMin, maxDkkPerLiter: normalizedMax };
  }

  function isFuelPriceOutsideWarningRange(pricePerLiter, source = {}, options = {}) {
    const price = Number(pricePerLiter);
    const range = getFuelPriceWarningRange(source, options);
    return Number.isFinite(price)
      && (price < range.minDkkPerLiter || price > range.maxDkkPerLiter);
  }

  function formatFuelPriceWarningRange(source = {}, deps = {}) {
    const range = getFuelPriceWarningRange(source, deps);
    const formatNumber = deps.formatNumber || String;
    return `${formatNumber(range.minDkkPerLiter)}-${formatNumber(range.maxDkkPerLiter)} DKK/L`;
  }

  function formatFuelAmountLitersAndPrice(fuel, deps = {}) {
    const formatNumber = deps.formatNumber || String;
    const formatMoneyFor = deps.formatMoneyFor || ((amount) => String(amount));
    const currency = deps.currency || "DKK";
    const amount = Number(fuel?.amount || 0);
    const liters = Number(fuel?.liters || 0);
    const parts = [formatMoneyFor(amount, currency)];
    if (liters > 0) {
      parts.push(`${formatNumber(liters)} L`);
      if (amount > 0) parts.push(`${formatMoneyFor(amount / liters, currency)}/L`);
    }
    return parts.join(" · ");
  }

  function getFuelReceiptTimestamp(fuel = {}) {
    const dateValue = fuel.date || fuel.payment_date || fuel.createdAt || fuel.created_at || "";
    const time = new Date(dateValue).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function getSuggestedFuelPricePerLiter(input = {}, deps = {}) {
    const state = deps.state || {};
    const fuel = Array.isArray(state.fuel) ? state.fuel : [];
    const latestFuelPrice = deps.latestFuelPrice || null;
    const formatDate = deps.formatDate || ((value) => String(value || ""));
    const formatMoneyFor = deps.formatMoneyFor || ((amount) => String(amount));
    const escapeHtml = deps.escapeHtml || ((value) => String(value || ""));
    const roundMoney = deps.roundMoney || ((value) => Math.round(safeNumber(value) * 100) / 100);
    const amount = safeNumber(input.amount);
    const liters = safeNumber(input.liters);
    const excludeFuelId = String(input.excludeFuelId || "");
    const range = getFuelPriceWarningRange(state, deps);
    const currentPrice = amount > 0 && liters > 0 ? amount / liters : 0;
    if (currentPrice > 0 && !isFuelPriceOutsideWarningRange(currentPrice, state, deps)) {
      return {
        price: roundMoney(currentPrice),
        source: "current-form",
        label: "current form price",
        detail: "The current amount and liters already create a valid DKK/L value."
      };
    }

    const historical = fuel
      .filter((entry) => !excludeFuelId || entry.id !== excludeFuelId)
      .map((entry) => {
        const fuelAmount = Number(entry.amount || 0);
        const fuelLiters = Number(entry.liters || 0);
        const price = fuelLiters > 0 ? fuelAmount / fuelLiters : Number(entry.pricePerLiter || 0);
        return { fuel: entry, price, timestamp: getFuelReceiptTimestamp(entry) };
      })
      .filter((item) => Number.isFinite(item.price) && item.price > 0 && !isFuelPriceOutsideWarningRange(item.price, state, deps))
      .sort((a, b) => b.timestamp - a.timestamp);

    if (historical[0]) {
      const item = historical[0];
      return {
        price: roundMoney(item.price),
        source: "historical",
        label: "latest valid historical receipt",
        detail: `${formatDate(item.fuel.date || item.fuel.payment_date || "")} fuel log used ${formatMoneyFor(item.price, state.currency)}/L.`
      };
    }

    const livePrice = Number(latestFuelPrice?.price || 0);
    if (livePrice > 0 && !isFuelPriceOutsideWarningRange(livePrice, state, deps)) {
      return {
        price: roundMoney(livePrice),
        source: "live",
        label: "live fuel price estimate",
        detail: `Latest ${escapeHtml(latestFuelPrice?.source || "fuel price")} estimate is ${formatMoneyFor(livePrice, state.currency)}/L.`
      };
    }

    const midpoint = (range.minDkkPerLiter + range.maxDkkPerLiter) / 2;
    return {
      price: roundMoney(midpoint),
      source: "range-midpoint",
      label: "configured warning-range midpoint",
      detail: `Using midpoint of configured range ${formatFuelPriceWarningRange(state, deps)}.`
    };
  }

  function buildFuelPriceCorrection(input = {}, deps = {}) {
    const amount = safeNumber(input.amount);
    const liters = safeNumber(input.liters);
    const pricePerLiter = amount > 0 && liters > 0 ? amount / liters : 0;
    const suggestedPrice = getSuggestedFuelPricePerLiter({ amount, liters, excludeFuelId: input.excludeFuelId }, deps);
    const roundMoney = deps.roundMoney || ((value) => Math.round(safeNumber(value) * 100) / 100);
    const suggestedAmount = liters > 0 && suggestedPrice.price > 0 ? roundMoney(liters * suggestedPrice.price) : 0;
    return {
      amount,
      liters,
      pricePerLiter,
      suggestedPricePerLiter: suggestedPrice.price,
      suggestedPriceSource: suggestedPrice.source,
      suggestedPriceLabel: suggestedPrice.label,
      suggestedPriceDetail: suggestedPrice.detail,
      suggestedAmount,
      range: getFuelPriceWarningRange(deps.state || {}, deps)
    };
  }

  function validateFuelLogInput(input = {}, deps = {}) {
    const amount = safeNumber(input.amount);
    const liters = safeNumber(input.liters);
    const state = deps.state || {};
    const formatMoneyFor = deps.formatMoneyFor || ((value) => String(value));
    if (!(amount > 0)) {
      return { ok: false, message: "Fuel amount must be higher than zero." };
    }
    if (!(liters > 0)) {
      return {
        ok: false,
        message: "Add liters from the receipt before saving this fuel log. The app needs liters to verify DKK/L and prevent settlement mistakes."
      };
    }
    const pricePerLiter = amount / liters;
    if (isFuelPriceOutsideWarningRange(pricePerLiter, state, deps)) {
      return {
        ok: false,
        message: `${formatMoneyFor(pricePerLiter, state.currency)}/L is outside the configured fuel price range (${formatFuelPriceWarningRange(state, deps)}). Check the amount/liters or ask an admin to adjust the warning range in Group settings.`,
        correction: buildFuelPriceCorrection({ amount, liters, excludeFuelId: input.excludeFuelId }, deps)
      };
    }
    return { ok: true, pricePerLiter };
  }

  window.FuelPriceHelpers = Object.freeze({
    defaultWarningRange,
    getFuelPriceWarningRange,
    isFuelPriceOutsideWarningRange,
    formatFuelPriceWarningRange,
    formatFuelAmountLitersAndPrice,
    getFuelReceiptTimestamp,
    getSuggestedFuelPricePerLiter,
    buildFuelPriceCorrection,
    validateFuelLogInput
  });
})();
