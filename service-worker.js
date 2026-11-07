const CACHE = "monostudy-v4";
// Only files that really exist. cache.addAll() rejects if ANY url 404s, which used to kill the whole install.
const CORE = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json",
  "./chapter-data.js", "./pyq-data.js", "./firebase-config.js", "./firebase-layer.js", "./chapter-data.json", "./pyq-data.json", "./icons/icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    // add one by one so a single failure cannot abort installation
    .then(c => Promise.all(CORE.map(u => c.add(u).catch(() => null))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.pathname.startsWith("/api/") || u.pathname === "/graphql") return;
  // Only our own files plus the two static CDNs (KaTeX, Firebase SDK modules) are cached.
  // Firestore/Auth calls (googleapis.com …) must go straight to the network or realtime sync breaks.
  if (u.origin !== location.origin && !/(^|\.)(gstatic\.com|cdnjs\.cloudflare\.com)$/.test(u.hostname)) return;
  // stale-while-revalidate for static assets (incl. KaTeX from cdnjs)
  e.respondWith(caches.match(r).then(hit => {
    const net = fetch(r).then(res => {
      if (res.ok || res.type === "opaque") { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); }
      return res;
    }).catch(() => hit || (r.mode === "navigate" ? caches.match("./index.html") : Response.error()));
    return hit || net;
  }));
});
