/* 青年部アプリ Service Worker
   役割：アプリの「見た目」だけを端末に保存し、2回目以降の起動を速くする。
   データ（Firebase）は毎回ネットから取るため、ここでは触らない。 */

const CACHE = "youth-app-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // 自分のサイト以外（Firebase・CDN など）は一切触らない
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== "GET") return;

  // 自分のファイルはネット優先。つながらない時だけキャッシュを使う
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
