// api/config.js — Frontend'e public config bilgilerini döner
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getAdminApp() {
  if (getApps().length > 0) return getApps()[0];
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return initializeApp({
    credential: cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}
function getDb() { getAdminApp(); return getFirestore(); }

let _modeCache = null;
const MODE_CACHE_TTL_MS = 15 * 1000;

export default async function handler(req, res) {
  // CORS headers
  const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
    .split(',').map(o => o.trim()).filter(Boolean);
  const requestOrigin = req.headers.origin;

  if (allowedOrigins.length === 0) {
    // GÜVENLİK (Adım 4): fail-closed — ALLOWED_ORIGIN yoksa dış origin'e izin verilmez (approve.js ile tutarlı).
    // Aynı-origin istekler (uygulamanın kendi /api/config çağrısı) CORS gerektirmez.
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: "Sadece GET kabul edilir" });

  // YENİ (Mainnet hazırlığı): Pi SDK'nın Testnet mi Mainnet mi ile
  // konuşacağı artık Firestore'daki config/platform_settings.piSandboxMode
  // alanından okunuyor — bu, approve.js'teki admin-only 'set_network_mode'
  // action'ının yazdığı AYNI alan. Yani admin panelinden mod değiştirilince,
  // hem istemci (buradan) hem sunucu (approve.js'teki getNetworkMode)
  // OTOMATİK olarak senkron kalıyor; ikisi arasında asla tutarsızlık
  // oluşmuyor. GÜVENLİ VARSAYILAN: Firestore'a hiç ulaşılamazsa veya alan
  // hiç yazılmamışsa HER ZAMAN Testnet (true) kabul edilir.
  let piSandboxMode = true;
  // PERFORMANS (Adım 4): her istemci açılışında Firestore'a gitmemek için 15 sn'lik örnek içi önbellek.
  // Admin panelinden mod değişince en geç 15 sn içinde yansır. Hata durumunda önbelleğe YAZILMAZ ve
  // güvenli varsayılan (Testnet) döner.
  if (_modeCache && Date.now() - _modeCache.ts < MODE_CACHE_TTL_MS) {
    piSandboxMode = _modeCache.value;
  } else {
    try {
      const db = getDb();
      const snap = await db.collection('config').doc('platform_settings').get();
      if (snap.exists && snap.data().piSandboxMode === false) piSandboxMode = false;
      _modeCache = { value: piSandboxMode, ts: Date.now() };
    } catch (e) {
      console.error('[config] Firestore\'dan piSandboxMode okunamadı, güvenli varsayılan (Testnet) kullanılıyor:', e.message);
    }
  }

  // Public config bilgileri (gizli bilgi YOK)
  res.status(200).json({
    adminUsername: process.env.ADMIN_USERNAME || 'doganay0808',
    contactEmail: process.env.NEXT_PUBLIC_CONTACT_EMAIL || 'info@dofiay.com',
    telegramGroup: process.env.NEXT_PUBLIC_TELEGRAM_GROUP || 'https://t.me/+5jZi9vrcNMM2NGVk',
    piSandboxMode,
  });
}
