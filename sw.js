/* Service worker mínimo: cache-first para o shell da app.
   No produto final, os dados vêm sempre da rede (Supabase);
   apenas o shell (HTML/CSS/JS/ícones) é servido do cache. */

const CACHE = "bet4fun-v7";
const SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/config.js",
  "./js/supabase.js",
  "./js/api.js",
  "./js/espn.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Só o shell (mesma origem) é servido do cache. Tudo o que é
  // cross-origin — Supabase (API/Auth) e o esm.sh do supabase-js —
  // vai sempre à rede, nunca é cacheado (SPECS §8).
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
