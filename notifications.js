(function () {
  function isPushSupported() {
    return Boolean("serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
  }

  function isIosDevice() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent || "");
  }

  async function refreshPushState(pushSupported) {
    if (!pushSupported) return false;

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      return Boolean(subscription && Notification.permission === "granted");
    } catch {
      return false;
    }
  }

  function updatePwaUi({ els, currentSession, deferredInstallPrompt, pushSupported, pushEnabled }) {
    if (!els.pwaPanel) return;

    if (!currentSession) {
      els.pwaPanel.classList.add("hidden");
      return;
    }

    els.pwaPanel.classList.remove("hidden");
    els.installApp?.classList.toggle("hidden", !deferredInstallPrompt);

    if (!pushSupported) {
      els.enablePush.disabled = true;
      els.enablePush.textContent = "Notifications unavailable";
      els.pwaMessage.textContent = "This browser does not support web push notifications. You can still use the app normally.";
      return;
    }

    if (pushEnabled) {
      els.enablePush.disabled = true;
      els.enablePush.textContent = "Notifications enabled";
      els.pwaMessage.textContent = "Payment request notifications are enabled on this device.";
      return;
    }

    if (Notification.permission === "denied") {
      els.enablePush.disabled = true;
      els.enablePush.textContent = "Notifications blocked";
      els.pwaMessage.textContent = "Notifications are blocked in this browser. Enable them in browser settings to receive payment alerts.";
      return;
    }

    els.enablePush.disabled = false;
    els.enablePush.textContent = "Enable notifications";
    els.pwaMessage.textContent = isIosDevice()
      ? "On iPhone, add Fuel Ledger to your Home Screen first, then open it from there and enable notifications."
      : "Enable notifications to get a phone alert when someone requests a payment from you.";
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function enablePushNotifications({
    supabaseClient,
    pushSupported,
    pushConfigUrl,
    pushSubscriptionsUrl,
    setCurrentSession,
    updateAuthUi,
    updatePwaUi,
    refreshPushState,
    showMessage
  }) {
    const notify = typeof showMessage === "function" ? showMessage : alert;

    if (!supabaseClient) {
      notify("Cloud login is not configured yet.", "error");
      return false;
    }

    const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
    const session = sessionData?.session;
    const accessToken = session?.access_token;

    if (sessionError || !session || !accessToken) {
      setCurrentSession(null);
      updateAuthUi();
      notify("Please sign in again before enabling notifications.", "error");
      return false;
    }

    setCurrentSession(session);

    if (!pushSupported) {
      notify("This browser does not support web push notifications.", "error");
      updatePwaUi();
      return false;
    }

    try {
      const configResponse = await fetch(pushConfigUrl);
      const config = await configResponse.json();
      if (!config.enabled || !config.publicKey) {
        notify("Push notifications are not configured on the server yet.", "error");
        updatePwaUi();
        return false;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        updatePwaUi();
        return false;
      }

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.publicKey)
        });
      }

      const response = await fetch(pushSubscriptionsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({ subscription })
      });

      if (!response.ok) throw new Error(await response.text());
      updatePwaUi();
      return true;
    } catch (error) {
      console.error(error);
      notify("Could not enable notifications yet. Please sign in again and try once more. If it still fails, check the Render logs.", "error");
      await refreshPushState();
      updatePwaUi();
      return false;
    }
  }

  async function sendSettlementPush({
    supabaseClient,
    sendPushUrl,
    settlement,
    getMemberProfile,
    formatMoney,
    settlementKey
  }) {
    if (!supabaseClient || !settlement) return;

    const { data: sessionData } = await supabaseClient.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (!accessToken) return;

    const targetEmail = getMemberProfile(settlement.from).email;
    if (!targetEmail) return;

    const title = "Fuel Ledger payment request";
    const body = `${settlement.to} requested ${formatMoney(settlement.amount)} from you for shared car fuel.`;

    try {
      await fetch(sendPushUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          targetEmail,
          title,
          body,
          url: `${window.location.origin}/`,
          tag: settlementKey(settlement)
        })
      });
    } catch (error) {
      console.warn("Push notification failed", error);
    }
  }

  window.FuelNotifications = {
    isPushSupported,
    refreshPushState,
    updatePwaUi,
    enablePushNotifications,
    sendSettlementPush
  };
}());
