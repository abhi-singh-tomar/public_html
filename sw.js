/* Paribesh Bandhu Jury — service worker
 * Caches the app shell so it opens instantly and installs as an app.
 * API calls (script.google.com) are never cached.
 * Bump VERSION whenever you deploy changed files. */
const VERSION = 'pbj-v1.12.0';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/logo-480.png', 'icons/favicon-32.png', 'icons/apple-touch-icon.png'
];
const CDN = 'https://cdnjs.cloudflare.com/';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin shell: network-first for HTML/config (so updates land), cache-first for the rest
  if (url.origin === self.location.origin) {
    const fresh = req.mode === 'navigate' || /\/(config|app)\.js$/.test(url.pathname);
    if (fresh) {
      e.respondWith(
        fetch(req).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c)); return r; })
          .catch(() => caches.match(req).then(r => r || caches.match('index.html')))
      );
    } else {
      e.respondWith(caches.match(req).then(r => r || fetch(req)));
    }
    return;
  }

  // PDF library from cdnjs: cache after first use
  if (req.url.startsWith(CDN)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      const c = res.clone(); caches.open(VERSION).then(x => x.put(req, c)); return res;
    })));
  }
});
