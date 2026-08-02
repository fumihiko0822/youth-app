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

/* ---- アイコンのバッジ ----
   通知を受け取った時点で数字を増やす。アプリを開くまで変わらないと、
   バナーを見逃したときに未対応があることに気づけないため。
   ここでは「1つ増やす」だけを行い、正確な件数はアプリを開いたときに
   画面側が入れ直す。保存先は画面側と共有している。 */
const BADGE_CACHE = "youth-app-badge";
const BADGE_KEY = "badge-count";

async function readBadge() {
  try {
    const c = await caches.open(BADGE_CACHE);
    const r = await c.match(BADGE_KEY);
    return r ? (Number(await r.text()) || 0) : 0;
  } catch (e) { return 0; }
}
async function writeBadge(n) {
  try {
    const c = await caches.open(BADGE_CACHE);
    await c.put(BADGE_KEY, new Response(String(n)));
  } catch (e) { /* 使えない環境では何もしない */ }
}

// 通知の表示はFCMのSDKが行う。ここではバッジだけを更新する。
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    const n = (await readBadge()) + 1;
    await writeBadge(n);
    try {
      if (self.navigator && "setAppBadge" in self.navigator) {
        await self.navigator.setAppBadge(n);
      }
    } catch (err) { /* 未対応なら何もしない */ }
  })());
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
      // バッジの保存先は消さない（消すと数字が0に戻ってしまう）
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== BADGE_CACHE).map(k => caches.delete(k))))
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
