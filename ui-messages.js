(function () {
  let appMessageTimer;

  function ensureAppMessageContainer() {
    let container = document.querySelector("#appMessageToast");
    if (container) return container;
    container = document.createElement("div");
    container.id = "appMessageToast";
    container.className = "app-message-toast hidden";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
    document.body.append(container);
    return container;
  }

  function showAppMessage(message, type = "success", options = {}) {
    if (!message) return;
    const container = ensureAppMessageContainer();
    clearTimeout(appMessageTimer);
    container.textContent = message;
    container.dataset.type = type;
    container.classList.remove("hidden");
    const timeoutMs = Number(options.timeoutMs || 3200);
    appMessageTimer = setTimeout(() => {
      container.classList.add("hidden");
    }, timeoutMs);
  }

  function normalizeMessageType(type) {
    const normalized = String(type || "info").toLowerCase();
    return ["success", "info", "warning", "error"].includes(normalized) ? normalized : "info";
  }

  function showSaveMessage(label, isEdit = false) {
    showAppMessage(`${label} ${isEdit ? "updated" : "saved"}.`);
  }

  function showUserMessage(message, type = "info", options = {}) {
    if (!message) return;
    const messageType = normalizeMessageType(type);
    showAppMessage(message, messageType, options);
  }

  function showUserError(message, options = {}) {
    showUserMessage(message, "error", { timeoutMs: 5200, ...options });
  }

  function showUserWarning(message, options = {}) {
    showUserMessage(message, "warning", { timeoutMs: 5200, ...options });
  }

  function confirmUserAction(message, options = {}) {
    if (!message) return true;
    const title = options.title ? `${options.title}\n\n` : "";
    return window.confirm(`${title}${message}`);
  }

  window.FuelUiMessages = {
    confirmUserAction,
    normalizeMessageType,
    showAppMessage,
    showSaveMessage,
    showUserError,
    showUserMessage,
    showUserWarning
  };

  window.confirmUserAction = confirmUserAction;
  window.showAppMessage = showAppMessage;
  window.showSaveMessage = showSaveMessage;
  window.showUserError = showUserError;
  window.showUserMessage = showUserMessage;
  window.showUserWarning = showUserWarning;
})();
