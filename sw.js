/* 青年部アプリ Service Worker
   役割：アプリの「見た目」だけを端末に保存し、2回目以降の起動を速くする。
   データ（Firebase）は毎回ネットから取るため、ここでは触らない。 */

/* ---- プッシュ通知（FCM） ----
   アプリを閉じている間の通知はここで受け取る。
   FCM の既定は firebase-messaging-sw.js という別ファイルだが、同じスコープに
   サービスワーカーを2つ置くと競合するため、このファイルに寄せている。
   （画面側は getToken() にこの登録を明示的に渡している） */
importScripts("https://www.gstatic.com/firebasejs/11.0.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyB91rmaTLGGC1XSVWsRHjh4AKLAMS8G7DQ",
  authDomain: "ajramiyazaki-dx.firebaseapp.com",
  projectId: "ajramiyazaki-dx",
  storageBucket: "ajramiyazaki-dx.firebasestorage.app",
  messagingSenderId: "819068699473",
  appId: "1:819068699473:web:66c31df1c555cb517b0970"
});

// notification 付きで送ってもらい、表示はSDKに任せる。
// data だけの送信は iOS では届かないため（Appleのプッシュは
// 「必ず見える通知になること」を前提にしている）。
// ここで onBackgroundMessage を定義して自分で showNotification すると、
// SDKの自動表示と二重になるので、あえて定義しない。
firebase.messaging();

// 通知を押したら、開いているアプリに戻す。無ければ開く。
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./index.html";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

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
