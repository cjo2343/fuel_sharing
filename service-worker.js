const CACHE_NAME = "fuel-ledger-v241";
const BUILD_LABEL = "sync-diagnostics-banner";
const BUILD_UPDATED_AT = "2026-06-16T16:45:00.000Z";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/vendor/supabase-js-2.43.4/supabase.js",
  "/vendor/supabase-js-2.43.4/26.supabase.js",
  "/supabase-config.js",
  "/utils.js",
  "/supabase-helpers.js",
  "/ledger-model.js",
  "/data-store.js",
  "/settlement-calculations.js",
  "/period-closing-helpers.js",
  "/stress-test-helpers.js",
  "/security-health-helpers.js",
  "/ui-messages.js",
  "/sync-status-helpers.js",
  "/location-privacy-helpers.js",
  "/audit-log.js",
  "/notifications.js",
  "/admin-tools.js",
  "/permission-helpers.js",
  "/build-info.js",
  "/booking-calendar.js",
  "/trip-actions.js",
  "/trip-rendering.js",
  "/fuel-rendering.js",
  "/planner-booking-bridge.js",
  "/app.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch((error) => {
        console.warn("core-asset-cache-failure", error);
      })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (event.data?.type === "GET_BUILD_INFO") {
    event.ports?.[0]?.postMessage({
      cacheName: CACHE_NAME,
      buildLabel: BUILD_LABEL,
      updatedAt: BUILD_UPDATED_AT
    });
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(request).catch(() => caches.match(request).then((response) => {
      if (response) return response;
      if (request.mode === "navigate") return caches.match("/");
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }))
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "Fuel Ledger", body: "You have a new payment request.", url: "/" };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch (error) {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "Fuel Ledger", {
      body: payload.body || "You have a new payment request.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: payload.tag || "fuel-ledger",
      data: { url: payload.url || "/" }
    })
  );
});

function sanitizeNotificationUrl(value) {
  try {
    const candidate = new URL(value || "/", self.location.origin);
    if (candidate.origin !== self.location.origin) return "/";
    return `${candidate.pathname}${candidate.search}${candidate.hash}` || "/";
  } catch (error) {
    return "/";
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = sanitizeNotificationUrl(event.notification.data?.url);
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
