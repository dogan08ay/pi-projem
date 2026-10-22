// sw.js — Web Push Service Worker
//
// BU DOSYA SİTENİN KÖK DİZİNİNE ("/") DEPLOY EDİLMELİDİR — örn.
// https://sizin-domaininiz.com/sw.js şeklinde erişilebilir olmalı.
// Bir alt klasöre (ör. /static/sw.js) koyarsanız, sadece o klasörün
// altındaki sayfalar için push alabilir, tüm site için ÇALIŞMAZ — çünkü
// bir service worker'ın "scope"u, konumlandığı dizin ve altındakilerle
// sınırlıdır.
//
// index.html içinde şu satırla kaydediliyor:
//   navigator.serviceWorker.register('/sw.js')

// GÜVENLİK: bildirimdeki "url" alanı yalnızca AYNI KAYNAKTAKİ (bu sitenin) adreslerine izin verir.
// Başka bir alan adı, javascript:/data: gibi şemalar ya da bozuk değerler ana sayfaya ("/") çevrilir.
// (Sunucu normalde yalnızca kendi yollarını gönderir; bu, olası bir hatanın/ele geçirilmenin bildirime
// tıklayan kullanıcıyı dış bir siteye götürmesini engelleyen ikinci savunma katmanıdır.)
function safeTarget(u) {
  try {
    const x = new URL(String(u || '/'), self.location.origin);
    if (x.origin === self.location.origin) return x.href;
  } catch (e) { /* aşağıda ana sayfaya düşer */ }
  return self.location.origin + '/';
}

// ── Adım 5: ÇEVRİMDIŞI YEDEK SAYFA ────────────────────────────────────────
// Yalnızca SAYFA GEZİNTİLERİ (navigate) için ve YALNIZCA ağ başarısız olursa devreye girer: ağ varken her
// zaman en güncel sürüm sunulur (eski/bayat uygulama sürümü ASLA önbellekten verilmez). /api çağrılarına,
// Pi SDK'ya ve diğer isteklere HİÇ dokunulmaz. offline.html önbelleğe alınamazsa bile Service Worker'ın
// kurulumu (ve dolayısıyla push bildirimleri) başarısız OLMAZ.
const OFFLINE_CACHE = 'w3dg-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE)
      .then((cache) => cache.add(new Request(new URL(OFFLINE_URL, self.location.origin).href, { cache: 'reload' })))
      .catch(() => { /* yedek sayfa alınamadıysa sessizce devam et */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('w3dg-offline-') && k !== OFFLINE_CACHE)
        .map((k) => caches.delete(k))))
      .catch(() => {})
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  let sameOrigin = false;
  try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch (e) {}
  if (!sameOrigin) return;
  event.respondWith(
    fetch(req).catch(() =>
      caches.open(OFFLINE_CACHE)
        .then((cache) => cache.match(OFFLINE_URL))
        .then((res) => res || new Response('Çevrimdışısınız / You are offline.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }))
    )
  );
});

// Sunucudan (approve.js -> webpush.sendNotification) bir push geldiğinde
// tetiklenir. Payload JSON: { title, body, url }
self.addEventListener('push', (event) => {
  let data = { title: 'Yeni Bildirim', body: '', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // JSON parse edilemezse düz metin olarak dene.
    if (event.data) data.body = event.data.text();
  }

  // Başlık/metin uzunluğunu sınırla (çok uzun değerler bildirimi bozar ya da gizler).
  const title = String(data.title || 'Yeni Bildirim').slice(0, 120);
  const bodyText = String(data.body || '').slice(0, 400);

  const options = {
    body: bodyText,
    icon: '/assets/apple-touch-icon.png',
    badge: '/assets/favicon-32.png',
    data: { url: safeTarget(data.url) },
    // Aynı anda çok sayıda bildirim birikirse kullanıcıyı boğmasın diye
    // aynı "tag" ile gelenler birbirinin üzerine yazılır (yığılmaz).
    tag: 'w3dg-notification',
    renotify: true
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Bildirime tıklanınca uygulamayı (varsa açık bir sekmeyi) öne getir,
// yoksa yeni bir sekmede aç.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = safeTarget(event.notification.data && event.notification.data.url);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          // Zaten aynı adresteyse sayfayı yeniden yükleme (kullanıcının açık ekranı/yazdığı metin kaybolmasın).
          const nav = (client.url === targetUrl) ? Promise.resolve() : client.navigate(targetUrl).catch(() => {});
          return nav.then(() => client.focus());
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
