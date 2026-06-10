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

  function showSaveMessage(label, isEdit = false) {
    showAppMessage(`${label} ${isEdit ? "updated" : "saved"}.`);
  }

  window.FuelUiMessages = {
    showAppMessage,
    showSaveMessage
  };

  window.showAppMessage = showAppMessage;
  window.showSaveMessage = showSaveMessage;
})();
