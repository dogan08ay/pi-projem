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

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
    icon: '/icon-192.png',
    badge: '/icon-192.png',
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
