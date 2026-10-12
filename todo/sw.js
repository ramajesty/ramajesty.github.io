// 画面のファイルを端末に保存して、電波がなくても起動できるようにする。
// 通信できるときは常に最新を取りに行き(ネットワーク優先)、できないときだけ保存分を使う。
const CACHE = 'outline-todo-v1';
const FILES = [
  './', 'index.html', 'app.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'apple-touch-icon.png',
  'vendor/supabase.js', 'vendor/fractional-indexing.js',
  'js/main.js', 'js/api.js', 'js/config.js', 'js/util.js', 'js/content.js', 'js/attachments.js', 'js/outline.js',
  'js/library.js', 'js/paste.js', 'js/help.js', 'js/syntax.js', 'js/views.js', 'js/importer.js', 'js/cache.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 同じサイトの画面ファイルだけを扱う(Supabase への通信などはそのまま)
  if (req.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./');
      throw err;
    }
  })());
});
