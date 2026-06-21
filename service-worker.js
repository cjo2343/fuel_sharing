const CACHE_NAME = "fuel-ledger-v401";
const BUILD_LABEL = "multi-workspace-authority-lane";
const BUILD_UPDATED_AT = "2026-06-22T01:15:00.000Z";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/vendor/supabase-js-2.43.4/supabase.js",
  "/vendor/supabase-js-2.43.4/26.supabase.js",
  "/vendor/localforage-1.10.0/localforage.min.js",
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
  "/fuel-price-helpers.js",
  "/location-privacy-helpers.js",
  "/audit-log.js",
  "/notifications.js",
  "/admin-tools.js",
  "/permission-helpers.js",
  "/booking-calendar.js",
  "/trip-actions.js",
  "/trip-rendering.js",
  "/fuel-rendering.js",
  "/planner-booking-bridge.js",
  "/app.js",
  "/manifest.json",
  "/favicon.ico",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch((error) => {
        console.warn("core-asset-cache-failure", error);
      })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (event.data?.type === "GET_BUILD_INFO") {
    try {
      event.ports?.[0]?.postMessage({
        cacheName: CACHE_NAME,
        buildLabel: BUILD_LABEL,
        updatedAt: BUILD_UPDATED_AT
      });
    } catch (error) {
      // The page may have navigated away during an automatic cache-status poll.
    }
  }
});

function cacheKeyForRequest(request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function pathKeyForRequest(request) {
  const url = new URL(request.url);
  return url.pathname || "/";
}

function isCoreAssetRequest(request) {
  const key = cacheKeyForRequest(request);
  const pathKey = pathKeyForRequest(request);
  return CORE_ASSETS.includes(key) || CORE_ASSETS.includes(pathKey) || request.mode === "navigate";
}

async function matchNavigationShell(cache) {
  return (await cache.match("/index.html")) || (await cache.match("/"));
}

async function cacheFirstCoreAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  if (request.mode === "navigate") {
    const shell = await matchNavigationShell(cache);
    if (shell) return shell;
  }
  const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirstBuildInfo(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const networkRequest = new Request(request, { cache: "no-store" });
    const response = await fetch(networkRequest);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      return response;
    }
  } catch (error) {
    console.warn("build-info-network-failure", error);
  }
  const cached = await cache.match(request);
  if (cached) return cached;
  return new Response("Build info unavailable", { status: 503, statusText: "Offline" });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname === "/favicon.ico") {
    event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
      return (await cache.match("/favicon.ico")) || (await cache.match("/icon-192.png")) || fetch(request);
    }));
    return;
  }
  if (url.pathname === "/build-info.js") {
    event.respondWith(networkFirstBuildInfo(request));
    return;
  }
  if (isCoreAssetRequest(request)) {
    event.respondWith(
      cacheFirstCoreAsset(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const response = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
        if (response) return response;
        if (request.mode === "navigate") {
          const shell = await matchNavigationShell(cache);
          if (shell) return shell;
        }
        return new Response("Offline", { status: 503, statusText: "Offline" });
      })
    );
    return;
  }
  event.respondWith(
    fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      const response = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
      if (response) return response;
      if (request.mode === "navigate") {
        const shell = await matchNavigationShell(cache);
        if (shell) return shell;
      }
      return new Response("Offline", { status: 503, statusText: "Offline" });
    })
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
