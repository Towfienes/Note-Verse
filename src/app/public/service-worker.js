const STATIC_CACHE = "noteverse-static-v8";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/reset.html",
  "/styles.css?v=8",
  "/app.js?v=8",
  "/markdown.js?v=8",
  "/reset.js?v=8",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "PURGE_PRIVATE") {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))),
        ),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/ws"
  )
    return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html")));
    return;
  }

  const isStatic = STATIC_ASSETS.some((asset) => {
    const assetUrl = new URL(asset, self.location.origin);
    return assetUrl.pathname === url.pathname;
  });
  if (!isStatic) return;
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok)
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, response.clone()));
          return response;
        }),
    ),
  );
});
