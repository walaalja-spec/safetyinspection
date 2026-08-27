// ---------------------------------------------------------------------
// sw.js
// Network-first, falling back to cache. We deliberately do NOT use a
// pure cache-first strategy here: this project has already run into
// confusing "stale file" bugs from browser/CDN caching, so freshness
// wins whenever there's a connection — the cache only kicks in when a
// request genuinely fails (i.e., actually offline).
//
// Bump CACHE_NAME on every deploy that changes app files, so old
// cached versions get cleared out automatically on activate.
// ---------------------------------------------------------------------

const CACHE_NAME = "walaa-safety-v9";

const CORE_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/storage.js",
  "/sync.js",
  "/media.js",
  "/photodoc.js",
  "/pdf.js",
  "/monthly.js",
  "/manifest.json",
  "/icon.png",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch((err) => console.warn("SW precache failed (app still works online):", err))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept POST /analyze

  const url = new URL(req.url);
  if (url.pathname === "/analyze") return; // AI calls always go live, never cached
  // Never cache the cloud API. These responses carry inspection data and
  // photo bytes, and caching them would (a) persist that data outside
  // IndexedDB in the Cache API with no expiry, and (b) risk serving a
  // stale or cross-session response. IndexedDB is the offline story for
  // this data -- the HTTP cache has no role to play here.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("/index.html")))
  );
});
