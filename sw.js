/* Service worker for the Devon Boundaries app. Caches the app shell (HTML/
   CSS/JS/icons) so the app itself opens offline, and caches data files
   (GeoJSON/CSV/JSON) network-first so a connection always gets the latest
   copy but a lost connection still falls back to whatever was last loaded.
   Map tiles (OpenStreetMap) are NOT cached here - that would need
   pre-fetching a specific area/zoom range, which is a bigger job; without
   a connection the boundaries, labels, popups, pinned data and postcode
   lookups all still work, just the base map tiles won't load. */

const SHELL_CACHE = "devon-map-shell-v1";
const DATA_CACHE = "devon-map-data-v1";

const SHELL_FILES = [
  "./",
  "index.html",
  "ward-postcodes.html",
  "style.css",
  "app.js",
  "ward-postcodes.js",
  "manifest.json",
  "icons/icon-120.png",
  "icons/icon-152.png",
  "icons/icon-167.png",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isDataRequest(url) {
  return url.pathname.includes("/data/") || url.pathname.endsWith(".geojson")
    || url.pathname.endsWith(".csv") || url.pathname.endsWith(".json");
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // leave map tiles/CDN scripts to the network as normal

  if (isDataRequest(url)) {
    // network-first, falling back to cache when offline
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA_CACHE).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // app shell: cache-first, falling back to network
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
