import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getDatabase } from 'firebase-admin/database';
import * as PiNetworkPkg from 'pi-backend';
// pi-backend gerçek bir native ESM paketi (package.json'ında "type":"module"
// ve doğru "exports" haritası var) — yani `import PiNetwork from 'pi-backend'`
// normal şartlarda doğrudan çalışmalı. Yine de Vercel'in fonksiyon
// derleyicisi (esbuild/ncc) ESM<->CJS arasında paketleme yaparken export
// şeklini bozabiliyor; bu yüzden burada TÜM olası şekilleri sırayla deniyor
// ve hangisinin işe yaradığını/yaramadığını sunucu loglarına (Vercel →
// Functions → Logs) yazdırıyoruz. Bir sonraki hata olursa loglardan tam
// olarak hangi export şeklinin geldiğini görüp kesin teşhis koyabiliriz.
function resolvePiNetworkCtor() {
  const candidates = {
    'PiNetworkPkg.default': PiNetworkPkg && PiNetworkPkg.default,
    'PiNetworkPkg.PiNetwork': PiNetworkPkg && PiNetworkPkg.PiNetwork,
    'PiNetworkPkg (kendisi)': PiNetworkPkg,
    'PiNetworkPkg.default.default': PiNetworkPkg && PiNetworkPkg.default && PiNetworkPkg.default.default,
  };
  for (const [label, candidate] of Object.entries(candidates)) {
    if (typeof candidate === 'function') {
      console.log(`[PI-BACKEND] Constructor bulundu: ${label}`);
      return candidate;
    }
  }
  console.error('[PI-BACKEND HATA] Hiçbir export şeklinde constructor bulunamadı. PiNetworkPkg içeriği:',
    Object.keys(PiNetworkPkg || {}), 'tip:', typeof PiNetworkPkg);
  return null;
}
const PiNetwork = resolvePiNetworkCtor();

// ─── Admin Config ───────────────────────────────────────────────────────
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'doganay0808';
const PLATFORM_COMMISSION_RATE = 0.05; // %5 komisyon
// İkili bir teklif pazarlığında (kabul veya karşı-teklif kabulü) anlaşma
// sağlandığında, anlaşan alıcıya bu süre boyunca domaini SADECE kendisinin
// satın alabileceği bir öncelik penceresi tanınır. Süre dolunca domain
// herkese açılır (ilk gelen alır).
const OFFER_RESERVATION_MS = 15 * 60 * 1000; // 15 dakika

// ── Süresi Dolmuş Rezervasyonu Eski Fiyata Döndür ───────────────────────
// Anlaşan alıcı, öncelik penceresi (OFFER_RESERVATION_MS) içinde domaini
// satın almazsa, anlaşılan indirimli fiyat KALICI olarak kalmamalı — aksi
// halde biri sadece pazarlık yapıp hiç almadan fiyatı düşürebilir. Bu
// fonksiyon, süresi dolmuş bir rezervasyon bulursa fiyatı pazarlık
// ÖNCESİNDEKİ değerine döndürür ve rezervasyon alanlarını temizler.
// Uygulamada zamanlanmış görev (cron) olmadığı için bu, domainle ilgili
// herhangi bir etkileşim (görüntüleme, teklif, satın alma denemesi) anında
// TETİKLENEREK çalışır — "tembel" (lazy) bir temizlik mekanizmasıdır.
// Idempotent'tir: zaten süresi dolmamışsa veya rezervasyon yoksa hiçbir şey
// yapmaz, güvenle tekrar tekrar çağrılabilir.
async function revertExpiredReservation(db, domainName) {
  try {
    const domainRef = db.collection('domains').doc(domainName);
    const snap = await domainRef.get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.sold === true) return null;
    if (!data.reservedFor || !data.reservedUntil) return null;
    if (data.reservedUntil > Date.now()) return null; // hâlâ geçerli, dokunma

    const revertPrice = typeof data.preNegotiationPrice === 'number' ? data.preNegotiationPrice : null;
    const update = { reservedFor: FieldValue.delete(), reservedUntil: FieldValue.delete(), preNegotiationPrice: FieldValue.delete() };
    if (revertPrice !== null) update.price = revertPrice;
    await domainRef.set(update, { merge: true });
    console.log(`[Rezervasyon süresi doldu] ${domainName} eski fiyata döndürüldü: ${revertPrice}`);
    return revertPrice;
  } catch (e) {
    console.error(`revertExpiredReservation hatası (${domainName}):`, e);
    return null;
  }
}

// YENİ: Bir domain silindiğinde (soft-delete VEYA kalıcı silme), o domaine
// verilmiş/gelmiş TÜM teklif geçmişini de siler. Aksi halde domain artık
// mevcut olmadığı/görünmediği halde "offers" koleksiyonundaki eski kayıtlar
// kalıcı olarak öylece durur; alıcı "Tekliflerim" ve satıcı "Gelen
// Teklifler" listelerinde artık var olmayan bir domaine ait teklifler
// görünmeye devam eder. Firestore batch limiti (500) aşılabileceğinden
// 400'lük parçalar halinde siliniyor.
async function deleteOffersForDomain(db, domainName) {
  try {
    const snap = await db.collection('offers').where('domainName', '==', domainName).get();
    if (snap.empty) return 0;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    console.log(`[Teklif geçmişi silindi] ${domainName} için ${docs.length} teklif kaydı silindi`);
    return docs.length;
  } catch (e) {
    console.error(`deleteOffersForDomain hatası (${domainName}):`, e);
    return 0;
  }
}

// ─── Escrow / A2U Ödeme İstemcisi (Satıcıya Otomatik Havuz Ödemesi) ───────
// NOT: Bunun çalışması için ortam değişkenlerine PI_WALLET_PRIVATE_SEED
// eklenmesi ve `npm install pi-backend` ile paketin projeye kurulması
// gerekir. PI_WALLET_PRIVATE_SEED, uygulamanızın kendi Pi cüzdanının
// "S..." ile başlayan private seed'idir (Developer Portal / cüzdan
// kurulumunuzdan alınır) — ASLA istemciye/tarayıcıya gönderilmemelidir.
let piClient = null;
function getPiClient() {
  if (piClient) return piClient;
  const apiKey = process.env.APP_SECRET;
  const walletSeed = process.env.PI_WALLET_PRIVATE_SEED;
  if (!apiKey || !walletSeed) return null;
  if (typeof PiNetwork !== 'function') {
    // Buraya düşüyorsak sorun 'new' çağrısında değil, pi-backend paketinin
    // import edilme/derlenme şeklinde demektir. Vercel Function Logs'ta
    // yukarıdaki "[PI-BACKEND HATA]" satırı hangi export şeklinin geldiğini
    // gösterir.
    throw new Error("pi-backend paketi doğru şekilde yüklenemedi (constructor bulunamadı) — Vercel Function Logs'a bakın.");
  }
  piClient = new PiNetwork(apiKey, walletSeed);
  return piClient;
}

// pi-backend (axios tabanlı) bir API hatası aldığında e.message sadece
// "Request failed with status code 401" gibi genel bir metin veriyor —
// gerçek sebep (örn. "invalid API key" veya "A2U not enabled") e.response.data
// içinde saklı kalıyor ve loglanmazsa hiç görünmüyor. Bu fonksiyon o veriyi
// çıkarıp okunabilir hale getiriyor ve Vercel Function Logs'a yazdırıyor.
function describePiApiError(e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  let detail = '';
  if (data) {
    detail = typeof data === 'string' ? data : JSON.stringify(data);
  }
  const full = status
    ? `HTTP ${status}${detail ? ' — ' + detail : ''} (${e.message})`
    : e?.message || String(e);
  console.error('[PI-API HATA DETAYI]', full);
  return full;
}

// ─── Firebase Admin Başlatma ───────────────────────────────────────────────
function getAdminApp() {
  if (getApps().length > 0) return getApps()[0];

  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  if (!dbUrl) {
    console.error("[FIREBASE INIT UYARI] FIREBASE_DATABASE_URL ortam değişkeni BOŞ/tanımsız. RTDB (bildirimler) çalışmayacak.");
  } else if (!/^https:\/\/.+\.firebaseio\.com\/?$/.test(dbUrl) && !/^https:\/\/.+\.(firebasedatabase\.app)\/?$/.test(dbUrl)) {
    console.error(`[FIREBASE INIT UYARI] FIREBASE_DATABASE_URL formatı beklenmedik görünüyor: "${dbUrl}". Beklenen format: https://<proje-id>-default-rtdb.firebaseio.com (sonunda / OLMAMALI, başında https:// OLMALI, tırnak içermemeli).`);
  } else {
    console.log(`[FIREBASE INIT] databaseURL doğrulandı: ${dbUrl}`);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error("[FIREBASE INIT UYARI] FIREBASE_SERVICE_ACCOUNT geçerli bir JSON değil:", e.message);
    throw e;
  }

  return initializeApp({
    credential: cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    databaseURL: dbUrl,
  });
}
function getDb()      { getAdminApp(); return getFirestore(); }
function getBucket()  { getAdminApp(); return getStorage().bucket(); }
function getRtdb()    { getAdminApp(); return getDatabase(); }

// ─── Admin Token Cache ────────────────────────────────────────────────────
const adminCache = new Map();
const ADMIN_CACHE_TTL = 5 * 60 * 1000;

async function verifyAdmin(accessToken) {
  if (!accessToken) return false;
  const cached = adminCache.get(accessToken);
  if (cached && Date.now() - cached.ts < ADMIN_CACHE_TTL) return cached.valid;
  try {
    const response = await fetch('https://api.minepi.com/v2/me', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!response.ok) { adminCache.set(accessToken, { valid: false, ts: Date.now() }); return false; }
    const userDto = await response.json();
    const valid = userDto.username === ADMIN_USERNAME;
    adminCache.set(accessToken, { valid, ts: Date.now() });
    return valid;
  } catch (e) {
    console.error("Pi /v2/me admin doğrulama hatası:", e);
    return false;
  }
}

// Kullanıcı token cache
const userCache = new Map();
const USER_CACHE_TTL = 5 * 60 * 1000;

async function getRealUsername(accessToken) {
  if (!accessToken) return null;
  const cached = userCache.get(accessToken);
  if (cached && Date.now() - cached.ts < USER_CACHE_TTL) return cached.username;
  try {
    const response = await fetch('https://api.minepi.com/v2/me', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!response.ok) return null;
    const userDto = await response.json();
    const username = userDto.username || null;
    userCache.set(accessToken, { username, ts: Date.now() });
    return username;
  } catch (e) {
    console.error("Pi /v2/me kullanıcı doğrulama hatası:", e);
    return null;
  }
}

// ─── Rate Limiter (IP bazlı, Firestore-tabanlı — serverless instance'lar
// arası tutarlı çalışır) ───────────────────────────────────────────────────
// ÖNCEKİ HAL: rateLimitMap in-memory (Map) tutuluyordu. Vercel gibi
// serverless ortamlarda her istek farklı bir fonksiyon instance'ına
// gidebildiğinden, bellekteki sayaç güvenilir değildi — bir saldırgan
// farklı instance'lara denk gelerek limiti fiilen bypass edebilirdi.
// YENİ HAL: sayaç Firestore'da (rate_limits koleksiyonu) bir transaction
// içinde tutuluyor, böylece hangi instance'a düşerse düşsün aynı sayaç
// görülüyor. Firestore'a erişilemezse (geçici hata vb.) eski in-memory
// mantığa düşülüyor — böylece Firestore kesintisi tüm uygulamayı
// kilitlemiyor, sadece o an için eski (instance-bazlı) korumaya döner.
const rateLimitMemoryMap = new Map();
function checkRateLimitMemoryFallback(ip, action, maxReq, windowMs) {
  const key = `${ip}:${action}`;
  const now = Date.now();
  const entry = rateLimitMemoryMap.get(key) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 1; entry.start = now; }
  else entry.count++;
  rateLimitMemoryMap.set(key, entry);
  return entry.count <= maxReq;
}
async function checkRateLimit(ip, action, maxReq = 10, windowMs = 60000) {
  const now = Date.now();
  const docId = `${ip}_${action}`.replace(/[\/\s]/g, '_').substring(0, 300) || `unknown_${action}`;
  // expiresAt: rate_limits koleksiyonu sürekli yeni doküman biriktirir.
  // Firestore'un TTL (Time-to-live) politikası SADECE Timestamp tipindeki
  // bir alana bakarak otomatik silme yapabilir (sayı/epoch ms işe yaramaz),
  // bu yüzden pencere süresi dolduğunda dokümanın "artık geçersiz" olacağı
  // anı ayrıca Timestamp olarak yazıyoruz. Konsoldan bu alan üzerinde bir
  // TTL politikası tanımlanınca Firestore eski kayıtları kendisi temizler.
  const expiresAt = Timestamp.fromMillis(now + windowMs);
  try {
    const db = getDb();
    const ref = db.collection('rate_limits').doc(docId);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : null;
      if (!data || now - data.start > windowMs) {
        tx.set(ref, { count: 1, start: now, expiresAt });
        return true;
      }
      if (data.count >= maxReq) return false;
      tx.set(ref, { count: data.count + 1, start: data.start, expiresAt }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error(`[RateLimit] Firestore hatası (${action}), in-memory yedeğe düşülüyor:`, e.message);
    return checkRateLimitMemoryFallback(ip, action, maxReq, windowMs);
  }
}

// ─── Bildirim Yardımcıları (Firebase Realtime Database) ───────────────────
async function sendNotification(targetUsername, notification) {
  if (!targetUsername) return;
  try {
    const rtdb = getRtdb();
    if (!rtdb) {
      console.error(`[Bildirim] RTDB başlatılamadı, bildirim gönderilemedi: @${targetUsername}`);
      return;
    }
    const ref = rtdb.ref(`notifications/${targetUsername}`);
    await ref.push({
      ...notification,
      read: false,
      ts: Date.now()
    });
  } catch (e) {
    console.error(`Bildirim gönderilemedi (hedef: @${targetUsername}, tip: ${notification?.type||'?'}):`, e.message || e);
  }
}

async function sendNotificationToAdmin(notification) {
  await sendNotification(ADMIN_USERNAME, notification);
}

// ─── Telegram Yardımcısı ──────────────────────────────────────────────────
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID   = process.env.TG_CHAT_ID;
const TG_GROUP_ID  = process.env.TG_GROUP_ID;

async function sendTG(chatId, text) {
  if (!TG_BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
  } catch (e) { console.error("TG Error:", e); }
}

// ─── Sistem Hata Günlüğü ────────────────────────────────────────────────────
// "🩺 Sistem Kontrolü" raporunun "arka planda hata" bölümünü besler. Bir
// action çalışırken beklenmeyen bir hatayla karşılaşıldığında buraya kısa bir
// kayıt düşülür (Firestore: system_errors). Bu fonksiyonun kendisi ASLA hata
// fırlatmaz — loglama başarısız olsa bile asıl isteği etkilemesin diye.
async function logSystemError(action, err, extra) {
  try {
    const db = getDb();
    await db.collection('system_errors').add({
      action: action || 'unknown',
      message: String(err && err.message || err || 'Bilinmeyen hata').slice(0, 500),
      extra: extra ? String(extra).slice(0, 300) : null,
      ts: Date.now()
    });
  } catch (_) { /* günlükleme hatası sessizce yutulur */ }
}

// ─── Admin İşlem Günlüğü (Audit Log) ────────────────────────────────────────
// "Kim, ne zaman, hangi işlemi yaptı" kaydı. Özellikle finansal/geri
// alınamaz işlemler (ödeme serbest bırakma, iade, ilan reddi, domain silme,
// bakım modu vb.) için — ileride bir anlaşmazlık çıkarsa elde iz olsun diye.
// Asla hata fırlatmaz, asıl işlemi engellemez.
async function logAdminAction(adminUsername, action, details) {
  try {
    const db = getDb();
    await db.collection('admin_audit_log').add({
      admin: adminUsername || 'unknown',
      action,
      details: details ? String(details).slice(0, 400) : null,
      ts: Date.now()
    });
  } catch (_) { /* günlükleme hatası sessizce yutulur */ }
}

// ─── CORS ─────────────────────────────────────────────────────────────────
function setCors(req, res) {
  const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
    .split(',').map(o => o.trim()).filter(Boolean);
  const requestOrigin = req.headers.origin;
  if (allowedOrigins.length === 0) {
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ─── Domain Adı Format Doğrulaması ──────────────────────────────────────
// Domain adı hem Firestore doküman ID'si hem de frontend'de birçok yerde
// (kart başlığı, onclick handler parametresi) HTML-escape edilmeden
// render ediliyor. Bu fonksiyon olmadan bir kullanıcı submit_sell_request
// ile domainName alanına HTML/script içeren bir değer gönderip, admin
// onayladığında bunu markette herkesin tarayıcısında çalışacak şekilde
// (stored XSS) markete sokabilirdi. Gerçek bir domain adı zaten sadece
// harf/rakam/tire/nokta içerir, bu yüzden bu kısıtlama meşru kullanımı
// etkilemez.
function isValidDomainName(name) {
  if (typeof name !== 'string') return false;
  if (name.length < 3 || name.length > 253) return false;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(name);
}

// ─── Puan Güncelleme (Handler DIŞINDA - Negatif Puan Koruması) ───────────
async function updateUserPoints(username, points, reason) {
  try {
    const db = getDb();
    const ref = db.collection('user_profiles').doc(username);
    const snap = await ref.get();
    const currentPoints = snap.exists ? (snap.data().points || 0) : 0;
    const newPoints = Math.max(0, currentPoints + points);

    await ref.set({
      points: newPoints,
      updatedAt: Date.now()
    }, { merge: true });

    let badge = null;
    if (newPoints >= 500) badge = 'diamond';
    else if (newPoints >= 200) badge = 'gold';
    else if (newPoints >= 50)  badge = 'silver';
    else if (newPoints >= 10)  badge = 'bronze';
    await ref.set({ badge }, { merge: true });

    console.log(`[Puan] @${username}: ${currentPoints} → ${newPoints} (${reason})`);
  } catch (e) {
    console.error("Puan güncelleme hatası:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  Satış kaydını ve puanları geri alma yardımcı fonksiyonu
//  Bu fonksiyon, bir domain satışı iptal edildiğinde (relist, delete vb.)
//  alıcının global_sales kaydını siler ve puanlarını geri alır.
// ══════════════════════════════════════════════════════════════════════════
async function reverseSaleAndPoints(db, domainName, buyerUsername, soldPrice, soldAt) {
  if (!buyerUsername || !soldPrice) {
    console.log(`[reverseSale] Atlandı: buyer=${buyerUsername}, price=${soldPrice}`);
    return;
  }

  try {
    // 1. global_sales'ten satış kaydını bul ve sil
    const salesQuery = await db.collection('global_sales')
      .where('user', '==', buyerUsername)
      .where('domain', '==', domainName)
      .get();

    let deletedCount = 0;
    const batch = db.batch();

    salesQuery.forEach(doc => {
      batch.delete(doc.ref);
      deletedCount++;
    });

    if (deletedCount > 0) {
      await batch.commit();
      console.log(`[reverseSale] ${deletedCount} adet global_sales kaydı silindi: ${domainName} → @${buyerUsername}`);
    }

    // 2. Kullanıcı puanlarını geri al
    await updateUserPoints(buyerUsername, -soldPrice, `sale_reversed_${domainName}`);

    // 3. daily_stats'ten de düş
    if (soldAt) {
      const soldDate = new Date(soldAt).toISOString().split('T')[0];
      try {
        await db.collection('daily_stats').doc(soldDate).set({
          count: FieldValue.increment(-1),
          volume: FieldValue.increment(-soldPrice)
        }, { merge: true });
        console.log(`[reverseSale] daily_stats güncellendi: ${soldDate}, -${soldPrice} Pi`);
      } catch (statErr) {
        console.error("[reverseSale] daily_stats güncelleme hatası:", statErr);
      }
    }

    // 4. Alıcıya bildirim gönder
    await sendNotification(buyerUsername, {
      type: 'purchase_reversed',
      title: 'ℹ️ Satın Alma İptal Edildi',
      body: `"${domainName}" domaini yönetici tarafından tekrar satışa çıkarıldı veya silindi. ${soldPrice} Pi harcamanız geri alındı.`,
      domainName,
      reversedAmount: soldPrice
    });

  } catch (e) {
    console.error(`[reverseSale] Hata: ${domainName} → @${buyerUsername}`, e);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  ANA HANDLER
// ══════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // FIX: Sistem Kontrolü'nün "arka planda hata" taramasını beslemek için
  // tüm handler'ı bir güvenlik ağıyla sarmaladık. Mevcut ~50 action bloğunun
  // kendi try/catch'lerine DOKUNMADIK — bu sadece onların dışında, hiçbir
  // action'ın yakalayamadığı gerçekten beklenmeyen hataları yakalayıp
  // (a) isteğin sessizce takılıp kalmasını önler, (b) system_errors'a kaydeder.
  try {
    const handled = await handlerImpl(req, res);
    if (handled === undefined && !res.headersSent) {
      // Hiçbir action bloğu eşleşmedi — istek sessizce takılı kalmasın
      return res.status(400).json({ error: "Bilinmeyen action: " + (req.body && req.body.action) });
    }
  } catch (e) {
    console.error("Beklenmeyen sunucu hatası:", e);
    await logSystemError((req.body && req.body.action) || 'unknown', e, 'unhandled-top-level');
    if (!res.headersSent) return res.status(500).json({ error: "Beklenmeyen bir sunucu hatası oluştu." });
  }
}

async function handlerImpl(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: "Sadece POST kabul edilir" });

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const { action, accessToken } = req.body;

  if (!action) return res.status(400).json({ error: "action zorunludur" });

  // ── Görsel Yükleme ─────────────────────────────────────────────────────
  if (action === 'upload_image') {
    if (!await checkRateLimit(clientIp, 'upload_image', 5, 60000))
      return res.status(429).json({ error: "Çok fazla istek. Lütfen bekleyin." });

    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });

    const { imageBase64, mimeType, fileName } = req.body;
    if (!imageBase64 || !mimeType) return res.status(400).json({ error: "Görsel verisi eksik" });

    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(mimeType)) return res.status(400).json({ error: "Desteklenmeyen görsel formatı" });

    try {
      const bucket = getBucket();
      const ext = mimeType.split('/')[1];
      const safeName = (fileName || 'domain').replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 50);
      const filePath = `domain-images/${realUsername}/${Date.now()}_${safeName}.${ext}`;
      const file = bucket.file(filePath);
      const buffer = Buffer.from(imageBase64, 'base64');

      if (buffer.length > 2 * 1024 * 1024)
        return res.status(400).json({ error: "Görsel 2MB'dan büyük olamaz" });

      await file.save(buffer, {
        metadata: { contentType: mimeType },
        public: true
      });
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
      return res.status(200).json({ success: true, url: publicUrl });
    } catch (e) {
      console.error("Görsel yükleme hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Bildirimleri Getir ───────────────────────────────────────────────────
  if (action === 'get_notifications') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const rtdb = getRtdb();
      const snap = await rtdb.ref(`notifications/${realUsername}`).once('value');
      const data = snap.val() || {};
      const notifications = Object.entries(data)
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 100);
      return res.status(200).json({ success: true, notifications });
    } catch (e) {
      console.error("Bildirim getirme hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Bildirimleri Okundu Yap ────────────────────────────────────────────
  if (action === 'mark_notifications_read') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const rtdb = getRtdb();
      const ref = rtdb.ref(`notifications/${realUsername}`);
      const snap = await ref.once('value');
      const updates = {};
      snap.forEach(child => { if (!child.val().read) updates[`${child.key}/read`] = true; });
      if (Object.keys(updates).length > 0) await ref.update(updates);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Belirli Role Ait Devir-Onayı Bildirimlerini Okundu Yap ─────────────
  // "Alımlarım" / "Gelirim" sekmelerindeki küçük rozet için: sadece o
  // sekmeyle ilgili (role'e göre) hatırlatma/anlaşmazlık-yanıtı bildirimleri
  // okundu yapılır, genel bildirim zili (🔔) etkilenmez.
  if (action === 'mark_role_notifications_read') {
    const { role, types } = req.body; // 'buyer' | 'seller', types: opsiyonel özel bildirim tipi listesi
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (role !== 'buyer' && role !== 'seller') return res.status(400).json({ error: "Geçersiz role" });
    try {
      const rtdb = getRtdb();
      const ref = rtdb.ref(`notifications/${realUsername}`);
      const snap = await ref.once('value');
      const updates = {};
      // Varsayılan tipler geriye dönük uyumluluk için korunuyor; frontend
      // artık sekmeye göre (Alımlarım/Gelirim/İlanlarım) farklı tip listeleri
      // gönderebiliyor — her sekmenin kendi rozetini bağımsız temizleyebilmesi için.
      const relevantTypes = Array.isArray(types) && types.length ? types : ['transfer_confirmation_reminder', 'dispute_response'];
      snap.forEach(child => {
        const v = child.val();
        if (!v.read && relevantTypes.includes(v.type) && v.role === role) updates[`${child.key}/read`] = true;
      });
      if (Object.keys(updates).length > 0) await ref.update(updates);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Bildirim Sil ──────────────────────────────────────────────────────
  if (action === 'delete_notification') {
    const { notifId } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const rtdb = getRtdb();
      await rtdb.ref(`notifications/${realUsername}/${notifId}`).remove();
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Tüm Bildirimleri Temizle ─────────────────────────────────────────────
  if (action === 'clear_all_notifications') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const rtdb = getRtdb();
      await rtdb.ref(`notifications/${realUsername}`).remove();
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Giriş Bildirimi ────────────────────────────────────────────────────
  if (action === 'log_login') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const today = new Date().toISOString().split('T')[0];
      const userDocRef = db.collection('daily_users').doc(today);
      const userSnap = await userDocRef.get();
      const users = userSnap.exists ? (userSnap.data().users || {}) : {};
      const isFirstLoginToday = !users[realUsername];

      users[realUsername] = Date.now();
      await userDocRef.set({ users }, { merge: true });

      const allDaily = await db.collection('daily_users').get();
      let earliest = Date.now();
      let isBrandNewUser = true;
      allDaily.forEach(d => {
        const u = d.data().users || {};
        if (u[realUsername]) {
          isBrandNewUser = false;
          if (u[realUsername] < earliest) earliest = u[realUsername];
        }
      });

      if (realUsername !== ADMIN_USERNAME) {
        await sendNotificationToAdmin({
          type: isBrandNewUser ? 'new_user_login' : 'user_login',
          title: isBrandNewUser ? '🆕 Yeni Kullanıcı Katıldı' : '👤 Kullanıcı Girişi',
          body: `@${realUsername} ${isBrandNewUser ? 'ilk kez giriş yaptı.' : 'giriş yaptı.'}`,
          username: realUsername
        });
      }

      return res.status(200).json({ success: true, firstSeen: earliest, isFirstLoginToday });
    } catch (e) {
      console.error("Login log hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Relist ────────────────────────────────────────────────────────────
  if (action === 'relist') {
    const { domainName } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!domainName) return res.status(400).json({ error: "Geçersiz domain adı" });

    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(domainName);
      const domainSnap = await domainRef.get();
      if (!domainSnap.exists || domainSnap.data().sold !== true)
        return res.status(400).json({ error: "Bu domain zaten satılık durumda" });

      const soldData = domainSnap.data();

      // Ödemesi satıcıya zaten gönderilmiş (gerçek Pi el değiştirmiş) bir
      // satışı asla tekrar satılığa çıkarmıyoruz — aksi halde aynı domain
      // ikinci bir alıcıya satılabilir ve ilk alıcı gerçek bir Pi iadesi
      // almadan ortada kalır. Bu domainler zaten otomatik olarak pasife
      // alınıp gizlenmiş durumda (bkz. release_seller_payment).
      if (soldData.payoutStatus === 'released') {
        return res.status(400).json({ error: "Bu domainin ödemesi satıcıya zaten gönderildi, tekrar satışa çıkarılamaz. Domain otomatik olarak pasife alındı. Gerçek bir iptal gerekiyorsa önce alıcıya gerçek bir Pi iadesi yapılmalı (bu, mevcut sistemde otomatikleştirilmemiştir, elle değerlendirilmelidir)." });
      }

      const soldPrice = Number(soldData.price || 0);
      const soldAt = soldData.at;
      const prevBuyer = soldData.buyer;

      if (prevBuyer && soldPrice > 0) {
        await reverseSaleAndPoints(db, domainName, prevBuyer, soldPrice, soldAt);
      }

      await domainRef.set({ sold: false, txid: null, buyer: null, at: null }, { merge: true });

      if (prevBuyer) {
        await sendNotification(prevBuyer, {
          type: 'domain_relisted',
          title: 'Domain Tekrar Satışa Çıkarıldı',
          body: `"${domainName}" domaini admin tarafından tekrar satışa çıkarıldı.`,
          domainName
        });
      }

      console.log(`Domain tekrar satılık yapıldı: ${domainName}`);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("Relist hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Domain Gizle/Göster ─────────────────────────────────────────
  // Gizli domainler, herkese açık listelemede admin dışındaki kimseye
  // gösterilmez (frontend tarafında filtrelenir). Satılmış olsun ya da
  // olmasın herhangi bir domain gizlenebilir/tekrar gösterilebilir.
  if (action === 'toggle_hide_domain') {
    const { domainName, hide } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!domainName) return res.status(400).json({ error: "Geçersiz domain adı" });
    try {
      const db = getDb();
      await db.collection('domains').doc(domainName).set({ hidden: !!hide }, { merge: true });
      return res.status(200).json({ success: true, hidden: !!hide });
    } catch (e) {
      console.error("toggle_hide_domain hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Fiyat Güncelle ────────────────────────────────────────────────────
  if (action === 'update_price') {
    const { domainName: dName, newPrice } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    const priceNum = Number(newPrice);
    if (!dName || !priceNum || priceNum <= 0) return res.status(400).json({ error: "Geçersiz parametre" });
    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(dName);
      const domainSnap = await domainRef.get();
      if (!domainSnap.exists) return res.status(404).json({ error: "Domain bulunamadı" });
      if (domainSnap.data().sold === true) return res.status(400).json({ error: "Satılmış domain fiyatı değiştirilemez" });
      await domainRef.set({ price: priceNum }, { merge: true });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Domain Ekle ───────────────────────────────────────────────────────
  if (action === 'add_domain') {
    const { domainName: newName, newPrice: newP, imgPath, domainType, description } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    const priceNum = Number(newP);
    if (!newName || !priceNum || priceNum <= 0) return res.status(400).json({ error: "Geçersiz parametre" });
    if (!isValidDomainName(newName))
      return res.status(400).json({ error: "Geçersiz domain adı formatı. Örnek: example.com" });
    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(newName);
      const existing = await domainRef.get();
      if (existing.exists) {
        return res.status(400).json({
          error: existing.data().deleted === true
            ? "Bu domain adı daha önce kullanılmış ve silinmiş. Yeniden eklemek için 'restore_domain' kullanın."
            : "Bu domain zaten kayıtlı"
        });
      }
      await domainRef.set({
        sold: false, price: priceNum,
        img: imgPath || 'assets/default.jpeg',
        type: domainType || 'genel',
        description: description || '',
        txid: null, buyer: null, at: null,
        deleted: false, deletedAt: null,
        createdAt: Date.now(),
        // FIX: Admin panelinden eklenen domainler artık "satıcısız sistem
        // domaini" değil, satıcısı admin'in kendisi olan normal bir ilan
        // olarak kaydediliyor. Böylece satış tamamlandığında bu domain de
        // diğer tüm ilanlar gibi escrow/devir-onay akışına giriyor: alıcı
        // "Aldım" diyor, admin "Panelim → Sattığım Domainler" üzerinden
        // satıcı sıfatıyla "Devrettim" diyor, ve kayıt "Bekleyen Ödemeler"
        // panelinde normal bir satıcı kaydı olarak görünüyor.
        sellerUsername: ADMIN_USERNAME
      });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Geriye Dönük Düzeltme: Eski "satıcısız" admin domainlerine sahip ekle ─
  // add_domain fix'inden ÖNCE eklenmiş, henüz SATILMAMIŞ domainlerde
  // sellerUsername alanı yok. Bu action, sadece sold!==true ve deleted!==true
  // olan ve sellerUsername'i hâlâ boş olan domainlere ADMIN_USERNAME yazar.
  // Zaten satılmış domainlere DOKUNMAZ (o satışlar tamamlanmış sayılır,
  // geriye dönük escrow'a sokmak alıcı/satıcı için kafa karıştırıcı olur).
  // İdempotenttir: kaç kez çalıştırılırsa çalıştırılsın, sadece eksik olan
  // kayıtları günceller, zaten sellerUsername'i olanlara dokunmaz.
  // ── Tüm Puanları Sıfırdan Yeniden Hesapla ───────────────────────────────
  // Kalıcı silinen bir domain'in puanı (eski bir silmeden, bu düzeltmeden
  // ÖNCE yapılmış olabilir) geriye dönük düzelmez — çünkü artırma/azaltma
  // (increment) mantığı sadece BUNDAN SONRAKİ silmelerde çalışır. Bu action
  // ise var olan TÜM domainleri tarayıp (silinmişler zaten Firestore'da hiç
  // yok, otomatik olarak hesaba katılmıyor), her kullanıcının puanını
  // SIFIRDAN toplayıp mevcut (muhtemelen şişmiş/eksik) değerin üzerine
  // YAZAR. Ne kadar çok kez çalıştırılırsa çalıştırılsın hep doğru sonucu
  // verir (idempotent).
  if (action === 'recompute_all_ratings') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const domainsSnap = await db.collection('domains').get();
      const sellerTotals = {}; // sellerUsername -> {sum, count}
      const buyerTotals = {};  // buyerUsername -> {sum, count}

      domainsSnap.forEach(d => {
        const data = d.data();
        if (data.buyerRating && data.sellerUsername) {
          const t = sellerTotals[data.sellerUsername] || { sum: 0, count: 0 };
          t.sum += data.buyerRating.stars; t.count++;
          sellerTotals[data.sellerUsername] = t;
        }
        if (data.sellerRatingOfBuyer && data.buyer) {
          const t = buyerTotals[data.buyer] || { sum: 0, count: 0 };
          t.sum += data.sellerRatingOfBuyer.stars; t.count++;
          buyerTotals[data.buyer] = t;
        }
      });

      // Önce, puanı olan TÜM profilleri sıfırla (ileride bir domain silinip
      // artık hiç puanı kalmayan bir kullanıcı varsa, onun eski şişmiş
      // değeri de 0'a dönsün diye).
      const allProfilesSnap = await db.collection('user_profiles').get();
      const batch = db.batch();
      let updatedCount = 0;
      allProfilesSnap.forEach(p => {
        const pd = p.data();
        const hasOldRatingData = pd.ratingSum !== undefined || pd.ratingCount !== undefined || pd.buyerRatingSum !== undefined || pd.buyerRatingCount !== undefined;
        if (!hasOldRatingData) return;
        const sellerT = sellerTotals[p.id] || { sum: 0, count: 0 };
        const buyerT = buyerTotals[p.id] || { sum: 0, count: 0 };
        batch.set(p.ref, {
          ratingSum: sellerT.sum, ratingCount: sellerT.count,
          buyerRatingSum: buyerT.sum, buyerRatingCount: buyerT.count
        }, { merge: true });
        updatedCount++;
      });
      // Henüz hiç user_profiles kaydı olmayan ama şimdi puanı çıkan kullanıcılar
      Object.keys(sellerTotals).forEach(u => {
        if (!allProfilesSnap.docs.some(p => p.id === u)) {
          batch.set(db.collection('user_profiles').doc(u), { ratingSum: sellerTotals[u].sum, ratingCount: sellerTotals[u].count }, { merge: true });
          updatedCount++;
        }
      });
      Object.keys(buyerTotals).forEach(u => {
        if (!allProfilesSnap.docs.some(p => p.id === u)) {
          batch.set(db.collection('user_profiles').doc(u), { buyerRatingSum: buyerTotals[u].sum, buyerRatingCount: buyerTotals[u].count }, { merge: true });
          updatedCount++;
        }
      });
      await batch.commit();

      await logAdminAction(await getRealUsername(accessToken), 'recompute_all_ratings', `${updatedCount} profil güncellendi`);
      return res.status(200).json({ success: true, updatedCount, sellersAffected: Object.keys(sellerTotals).length, buyersAffected: Object.keys(buyerTotals).length });
    } catch (e) {
      console.error("recompute_all_ratings hatası:", e);
      await logSystemError('recompute_all_ratings', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Geriye Dönük Düzeltme: Zaten Silinmiş Domainlerdeki Puanları Geri Al ─
  // Bu fix'ten ÖNCE silinmiş domainlerin buyerRating/sellerRatingOfBuyer
  // alanları hâlâ duruyor ve ilgili kullanıcının toplam puanına dahil
  // ediliyordu. Bu action, deleted===true olan ve hâlâ puan taşıyan her
  // domain için puanı geri alır ve alanı temizler. İdempotenttir.
  if (action === 'backfill_reverse_deleted_ratings') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const snap = await db.collection('domains').where('deleted', '==', true).get();
      let fixedCount = 0;
      const fixedNames = [];
      for (const d of snap.docs) {
        const data = d.data();
        const update = {};
        if (data.buyerRating && data.sellerUsername) {
          await db.collection('user_profiles').doc(data.sellerUsername).set({
            ratingSum: FieldValue.increment(-data.buyerRating.stars),
            ratingCount: FieldValue.increment(-1)
          }, { merge: true });
          update.buyerRating = null;
        }
        if (data.sellerRatingOfBuyer && data.buyer) {
          await db.collection('user_profiles').doc(data.buyer).set({
            buyerRatingSum: FieldValue.increment(-data.sellerRatingOfBuyer.stars),
            buyerRatingCount: FieldValue.increment(-1)
          }, { merge: true });
          update.sellerRatingOfBuyer = null;
        }
        if (Object.keys(update).length > 0) {
          await d.ref.set(update, { merge: true });
          fixedCount++;
          fixedNames.push(d.id);
        }
      }
      return res.status(200).json({ success: true, fixedCount, fixedNames });
    } catch (e) {
      console.error("backfill_reverse_deleted_ratings hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'backfill_seller_username') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const allDomainsSnap = await db.collection('domains').get();
      const batch = db.batch();
      let updatedCount = 0;
      const updatedNames = [];
      allDomainsSnap.forEach(d => {
        const data = d.data();
        if (data.sold !== true && data.deleted !== true && !data.sellerUsername) {
          batch.set(d.ref, { sellerUsername: ADMIN_USERNAME }, { merge: true });
          updatedCount++;
          updatedNames.push(d.id);
        }
      });
      if (updatedCount > 0) await batch.commit();

      // ── 2. Aşama: global_sales kayıtlarını domains ile eşitle ───────────
      // "Panelim → Gelirim" listesi `domains` koleksiyonundan geliyor, ama
      // "Devrettim" (confirm_transfer_seller) ve "Transfer Tamam Öde"
      // (release_seller_payment) işlemleri `global_sales` koleksiyonundan
      // okuyor. Firestore konsolundan elle `domains` içinde sellerUsername
      // düzeltilmiş olsa bile, o satışın `global_sales` kaydı hâlâ eski
      // (satıcısız) haliyle kalmışsa "Satış kaydı bulunamadı" hatası
      // alınır. Bu adım, sold===true ve sellerUsername'i dolu olan her
      // domain için, aynı isimdeki global_sales kaydında sellerUsername
      // eksikse onu tamamlar — MEVCUT (zaten doğru) kayıtlara DOKUNMAZ,
      // sadece eksik olanı doldurur.
      const soldWithSeller = {};
      allDomainsSnap.forEach(d => {
        const data = d.data();
        if (data.sold === true && data.sellerUsername) soldWithSeller[d.id] = data.sellerUsername;
      });
      let salesUpdated = 0;
      const salesUpdatedNames = [];
      if (Object.keys(soldWithSeller).length > 0) {
        const salesSnap = await db.collection('global_sales').get();
        const batch2 = db.batch();
        salesSnap.forEach(s => {
          const sd = s.data();
          const seller = soldWithSeller[sd.domain];
          if (seller && !sd.sellerUsername) {
            const update = { sellerUsername: seller };
            if (!sd.payoutStatus || sd.payoutStatus === 'no_seller') update.payoutStatus = 'pending';
            if (!sd.commissionRate) update.commissionRate = PLATFORM_COMMISSION_RATE;
            if (!sd.payoutAmount) update.payoutAmount = Math.round((sd.price || 0) * (1 - PLATFORM_COMMISSION_RATE) * 1e7) / 1e7;
            batch2.set(s.ref, update, { merge: true });
            salesUpdated++;
            salesUpdatedNames.push(sd.domain);
          }
        });
        if (salesUpdated > 0) await batch2.commit();
      }

      return res.status(200).json({ success: true, updatedCount, updatedNames, salesUpdated, salesUpdatedNames });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── İlanı Geri Çek ────────────────────────────────────────────────────
  if (action === 'withdraw_listing') {
    const { domainName } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!domainName) return res.status(400).json({ error: "Geçersiz domain adı" });

    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(domainName);
      const domainSnap = await domainRef.get();

      if (!domainSnap.exists) return res.status(404).json({ error: "Domain bulunamadı" });
      const domainData = domainSnap.data();

      if (domainData.sellerUsername !== realUsername) {
        return res.status(403).json({ error: "Bu ilanı geri çekme yetkiniz yok" });
      }

      if (domainData.sold === true) {
        return res.status(400).json({ error: "Satılmış domain geri çekilemez" });
      }

      await domainRef.set({
        deleted: true,
        deletedAt: Date.now(),
        deletedBy: realUsername
      }, { merge: true });

      const reqSnap = await db.collection('sell_requests')
        .where('domainName', '==', domainName)
        .where('submittedBy', '==', realUsername)
        .where('status', '==', 'approved')
        .get();

      if (!reqSnap.empty) {
        const batch = db.batch();
        reqSnap.forEach(doc => {
          batch.update(doc.ref, { status: 'withdrawn', withdrawnAt: Date.now() });
        });
        await batch.commit();
      }

      await updateUserPoints(realUsername, -20, 'listing_withdrawn');

      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Domain Sil (SOFT DELETE) ──────────────────────────────────────────
  if (action === 'delete_domain') {
    const { domainName: delName } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!delName) return res.status(400).json({ error: "Geçersiz domain adı" });
    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(delName);
      const domainSnap = await domainRef.get();
      if (!domainSnap.exists) return res.status(404).json({ error: "Domain bulunamadı" });

      const domainDataForDelete = domainSnap.data();

      // FIX (kök neden): Daha önce burada satılmış bir domain için ÖNCE
      // reverseSaleAndPoints() çalışıyor (puanlar geri alınıyor, alıcıya
      // "Pi'niz iade edildi" bildirimi gönderiliyor) SONRA aynı koşul tekrar
      // kontrol edilip hata döndürülüyordu — yani hiçbir şey silinmediği
      // halde puan/istatistik/bildirim tarafında geri dönüşü olmayan yan
      // etkiler zaten gerçekleşmiş oluyordu.
      //
      // Satılmış ama ödemesi HENÜZ kesinleşmemiş (havuzda bekleyen/işlemde
      // olan gerçek Pi var) bir domaine hâlâ dokunmuyoruz — admin önce
      // "Tekrar Satılık Yap" ile düzgünce ele almalı.
      //
      // Ödemesi KESİNLEŞMİŞ (payoutStatus:'released', zaten otomatik pasife
      // alınmış) bir domain ise artık SİLİNEBİLİR — çünkü zaten piyasadan
      // kalıcı olarak çekilmiş durumda, silinmesi çifte-satış riski
      // yaratmaz; bu sadece test/arşiv temizliğidir.
      if (domainDataForDelete.sold === true && domainDataForDelete.payoutStatus !== 'released') {
        return res.status(400).json({ error: "Satılmış domain önce 'Tekrar Satılık Yap' ile satıştan kaldırılmalı" });
      }

      if (domainDataForDelete.sellerUsername) {
        await updateUserPoints(domainDataForDelete.sellerUsername, -20, 'domain_deleted_point_reversal');
      }

      // YENİ: Normal "Sil" (soft-delete) domaini listeden tamamen kaldırıp
      // kullanıcı için "silinmiş" gibi davrandığından, buna bağlı yıldız
      // puanları da burada geri alınmalı — sadece "Kalıcı Sil"i beklemek
      // kullanıcı beklentisiyle uyuşmuyordu (domain zaten görünmez oluyor,
      // ama puan hâlâ sayılıyordu).
      if (domainDataForDelete.buyerRating && domainDataForDelete.sellerUsername) {
        await db.collection('user_profiles').doc(domainDataForDelete.sellerUsername).set({
          ratingSum: FieldValue.increment(-domainDataForDelete.buyerRating.stars),
          ratingCount: FieldValue.increment(-1)
        }, { merge: true });
      }
      if (domainDataForDelete.sellerRatingOfBuyer && domainDataForDelete.buyer) {
        await db.collection('user_profiles').doc(domainDataForDelete.buyer).set({
          buyerRatingSum: FieldValue.increment(-domainDataForDelete.sellerRatingOfBuyer.stars),
          buyerRatingCount: FieldValue.increment(-1)
        }, { merge: true });
      }

      const softDeleteUpdate = { deleted: true, deletedAt: Date.now() };
      // Geri alınan puanlar domain kaydından da temizlenir — hem "Kalıcı
      // Sil" ile daha sonra İKİNCİ kez geri alınmasını (çifte düşüş) önler,
      // hem de bu domain restore edilirse eski (artık geçersiz) puanın
      // tekrar görünmesini engeller.
      if (domainDataForDelete.buyerRating) softDeleteUpdate.buyerRating = null;
      if (domainDataForDelete.sellerRatingOfBuyer) softDeleteUpdate.sellerRatingOfBuyer = null;
      await domainRef.set(softDeleteUpdate, { merge: true });

      // YENİ: Domain silinince, ona verilmiş/gelmiş teklif geçmişi de silinsin
      // — kullanıcı artık olmayan bir domain için "Tekliflerim" / "Gelen
      // Teklifler" listesinde teklif görmemeli.
      await deleteOffersForDomain(db, delName);

      console.log(`Domain soft-delete edildi: ${delName}`);
      await logAdminAction(await getRealUsername(accessToken), 'delete_domain', delName);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Domain Geri Getir ─────────────────────────────────────────────────
  if (action === 'restore_domain') {
    const { domainName: restoreName } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!restoreName) return res.status(400).json({ error: "Geçersiz domain adı" });
    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(restoreName);
      const snap = await domainRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Domain bulunamadı" });
      if (snap.data().deleted !== true) return res.status(400).json({ error: "Bu domain silinmiş durumda değil" });

      const restoreData = snap.data();
      if (restoreData.sellerUsername && restoreData.sold !== true) {
        await updateUserPoints(restoreData.sellerUsername, 20, 'domain_restored_point_reinstate');
      }

      await domainRef.set({ deleted: false, deletedAt: null }, { merge: true });
      console.log(`Domain geri getirildi: ${restoreName}`);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Domain Kalıcı Sil ──────────────────────────────────────────────────
  if (action === 'permanent_delete_domain') {
    const { domainName: permDelName } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!permDelName) return res.status(400).json({ error: "Geçersiz domain adı" });
    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(permDelName);
      const snap = await domainRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Domain bulunamadı" });

      const domainData = snap.data();

      if (domainData.sold === true) {
        const prevBuyer = domainData.buyer;
        const soldPrice = Number(domainData.price || 0);
        const soldAt = domainData.at;

        if (prevBuyer && soldPrice > 0) {
          await reverseSaleAndPoints(db, permDelName, prevBuyer, soldPrice, soldAt);
        }

        // YENİ: Bu satışa bağlı yıldız puanları da geri alınır — domain
        // kalıcı silinince, o satıştan doğan itibar puanı da kaybolmalı,
        // yoksa ortalama puan artık var olmayan bir işleme dayanarak
        // şişirilmiş kalır.
        if (domainData.buyerRating && domainData.sellerUsername) {
          await db.collection('user_profiles').doc(domainData.sellerUsername).set({
            ratingSum: FieldValue.increment(-domainData.buyerRating.stars),
            ratingCount: FieldValue.increment(-1)
          }, { merge: true });
        }
        if (domainData.sellerRatingOfBuyer && domainData.buyer) {
          await db.collection('user_profiles').doc(domainData.buyer).set({
            buyerRatingSum: FieldValue.increment(-domainData.sellerRatingOfBuyer.stars),
            buyerRatingCount: FieldValue.increment(-1)
          }, { merge: true });
        }
      }

      if (snap.data().deleted !== true) return res.status(400).json({ error: "Sadece soft-delete edilmiş domainler kalıcı silinebilir" });

      await domainRef.delete();

      const reqSnap = await db.collection('sell_requests')
        .where('domainName', '==', permDelName)
        .get();
      if (!reqSnap.empty) {
        const batch = db.batch();
        reqSnap.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }

      // YENİ: Kalıcı silmede de teklif geçmişi silinir (soft-delete anında
      // zaten silinmiş olabilir ama domain hiç soft-delete edilmeden burada
      // doğrudan çağrılan bir akış olursa diye burada da garanti altına
      // alınıyor — deleteOffersForDomain zaten kayıt yoksa hiçbir şey yapmaz).
      await deleteOffersForDomain(db, permDelName);

      console.log(`Domain kalıcı silindi: ${permDelName}`);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Sistem Kontrolü (Check Up) ─────────────────────────────────────────
  // Admin panelindeki "🩺 Sistem Kontrolü" butonunun arkası. Bilinen veri
  // tutarlılığı sorunlarını tarar (satıcı/satış kaydı uyuşmazlıkları,
  // takılı kalmış ödemeler, kopuk ilan kayıtları vb.) ve bir rapor
  // (issues[]) döner. Hiçbir veriyi DEĞİŞTİRMEZ, sadece okur ve raporlar.
  // ── Admin İşlem Günlüğünü Getir ────────────────────────────────────────
  // ── Anlık Aktif Kullanıcılar (Admin) ───────────────────────────────────
  // Mevcut "giriş bildirimleri" (log_login) ve günlük giriş kaydına EK
  // olarak: admin panelinde açıldığı anda son 30 saniye içinde "aktif"
  // (active_users koleksiyonunda lastSeen güncel) olan kullanıcıları
  // canlı olarak çeker. Var olan giriş bildirimi akışına dokunmuyor.
  if (action === 'get_active_users') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const snap = await db.collection('active_users').get();
      const now = Date.now();
      const active = [];
      snap.forEach(d => {
        const lastSeen = d.data().lastSeen;
        if (lastSeen && (now - lastSeen) < 30000) active.push({ username: d.id, lastSeen });
      });
      active.sort((a, b) => b.lastSeen - a.lastSeen);
      return res.status(200).json({ success: true, active });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'get_admin_audit_log') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const snap = await db.collection('admin_audit_log').orderBy('ts', 'desc').limit(100).get();
      const entries = [];
      snap.forEach(d => entries.push({ id: d.id, ...d.data() }));
      return res.status(200).json({ success: true, entries });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'run_system_checkup') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const issues = [];
      const addIssue = (severity, title, detail) => issues.push({ severity, title, detail });

      const [domainsSnap, salesSnap, sellReqSnap, tmSnap, statsSnap, offersSnap] = await Promise.all([
        db.collection('domains').get(),
        db.collection('global_sales').get(),
        db.collection('sell_requests').get(),
        db.collection('trademark_claims').get(),
        db.collection('config').doc('platform_stats').get(),
        db.collection('offers').get()
      ]);

      // global_sales'i domain adına göre indeksle (bir domain birden çok kez satılmış olabilir, hepsini tut)
      const salesByDomain = {};
      salesSnap.forEach(s => {
        const sd = s.data();
        if (!sd.domain) return;
        (salesByDomain[sd.domain] = salesByDomain[sd.domain] || []).push({ id: s.id, ...sd });
      });

      let soldCount = 0, stuckPayouts = [], missingSalesRecord = [], sellerMismatch = [], missingSaleFields = [];
      domainsSnap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        if (data.sold !== true) return;
        soldCount++;

        if (!data.buyer || !data.txid || !data.at) {
          missingSaleFields.push(d.id);
        }

        const matchingSales = salesByDomain[d.id] || [];
        if (data.sellerUsername) {
          if (matchingSales.length === 0) {
            missingSalesRecord.push(d.id);
          } else {
            const anyMatch = matchingSales.some(s => s.sellerUsername === data.sellerUsername);
            if (!anyMatch) sellerMismatch.push(d.id);
          }
        }

        matchingSales.forEach(s => {
          if (s.payoutStatus === 'processing' || s.payoutStatus === 'failed' || s.payoutStatus === 'refund_processing' || s.payoutStatus === 'refund_failed') {
            stuckPayouts.push({ domain: d.id, status: s.payoutStatus });
          }
        });
      });

      if (missingSalesRecord.length > 0) {
        addIssue('error', `${missingSalesRecord.length} satılmış domain'in satış kaydı (global_sales) hiç yok`,
          `Bu domainler "sold:true" ve satıcı bilgisi var, ama global_sales koleksiyonunda hiç kaydı yok — muhtemelen escrow sistemi kurulmadan önce satılmışlar. "Devrettim" onayı çalışmaz, "🔧 Eski domainlerdeki satıcı bilgisini düzelt" butonu bunları da düzeltemez (çünkü düzeltilecek bir kayıt yok). Etkilenenler: ${missingSalesRecord.join(', ')}`);
      }
      if (sellerMismatch.length > 0) {
        addIssue('warning', `${sellerMismatch.length} domain'de satıcı bilgisi domains/global_sales arasında uyuşmuyor`,
          `"🔧 Eski domainlerdeki satıcı bilgisini düzelt" butonuna basarak düzeltebilirsiniz. Etkilenenler: ${sellerMismatch.join(', ')}`);
      }
      if (stuckPayouts.length > 0) {
        addIssue('warning', `${stuckPayouts.length} ödeme "işleniyor/başarısız" durumunda takılı kalmış`,
          stuckPayouts.map(s => `${s.domain} (${s.status})`).join(', ') + ' — Bekleyen Ödemeler panelinden kontrol edip tekrar deneyin.');
      }
      if (missingSaleFields.length > 0) {
        addIssue('info', `${missingSaleFields.length} satılmış domain'de alıcı/işlem no/tarih bilgisi eksik`,
          `Etkilenenler: ${missingSaleFields.join(', ')}`);
      }

      // sell_requests: onaylanmış ama karşılığında domain oluşmamış
      const staleRequests = [];
      const now = Date.now();
      sellReqSnap.forEach(r => {
        const rd = r.data();
        if (rd.status === 'pending' && rd.submittedAt && (now - rd.submittedAt) > 30 * 24 * 3600 * 1000) {
          staleRequests.push(r.id);
        }
      });
      if (staleRequests.length > 0) {
        addIssue('info', `${staleRequests.length} satış talebi 30 günden uzun süredir bekliyor`, `İncelemeniz gerekebilir: ${staleRequests.join(', ')}`);
      }

      // ── YENİ: Yetim teklif kayıtları (offers) ──────────────────────────
      // Bir domain silindiğinde (soft-delete veya kalıcı silme) artık ona
      // ait teklif geçmişi de siliniyor (bkz. deleteOffersForDomain), AMA bu
      // sadece bu düzeltmeden SONRA silinen domainler için geçerli. Daha
      // önce silinmiş domainlerin "offers" kayıtları hâlâ Firestore'da
      // duruyor olabilir. Burada bunları tespit edip admin'e "🧹 Yetim
      // Verileri Temizle" butonunu kullanması için bildiriyoruz.
      const domainStatusMap = {};
      domainsSnap.forEach(d => { domainStatusMap[d.id] = d.data().deleted === true; });
      const orphanedOffersByDomain = {};
      offersSnap.forEach(o => {
        const dn = o.data().domainName;
        if (!dn) return;
        const isOrphan = !(dn in domainStatusMap) || domainStatusMap[dn] === true;
        if (isOrphan) orphanedOffersByDomain[dn] = (orphanedOffersByDomain[dn] || 0) + 1;
      });
      const orphanedOfferDomains = Object.keys(orphanedOffersByDomain);
      const orphanedOfferCount = orphanedOfferDomains.reduce((sum, dn) => sum + orphanedOffersByDomain[dn], 0);
      if (orphanedOfferCount > 0) {
        addIssue('warning', `${orphanedOfferCount} teklif kaydı artık var olmayan/silinmiş domainlere ait (${orphanedOfferDomains.length} domain)`,
          `Etkilenen domainler: ${orphanedOfferDomains.join(', ')} — Admin panelindeki "🧹 Yetim Verileri Temizle" butonuyla kalıcı olarak silebilirsiniz.`);
      }


      const staleClaims = [];
      tmSnap.forEach(c => {
        const cd = c.data();
        if ((cd.status === 'new' || cd.status === 'reviewing') && cd.createdAt && (now - cd.createdAt) > 14 * 24 * 3600 * 1000) {
          staleClaims.push(c.id);
        }
      });
      if (staleClaims.length > 0) {
        addIssue('info', `${staleClaims.length} marka hakkı talebi 14 günden uzun süredir yanıt bekliyor`, `Talep ID'leri: ${staleClaims.join(', ')}`);
      }

      // platform_stats
      if (!statsSnap.exists) {
        addIssue('info', 'Kazanç istatistik kaydı (config/platform_stats) henüz oluşmamış', 'Kazanç sekmesi ilk açıldığında otomatik oluşturulur, bu normaldir.');
      } else if (statsSnap.data().statsVersion !== 2) {
        addIssue('warning', 'Kazanç istatistikleri eski formatta (statsVersion≠2)', 'Kazanç sekmesini bir kez açtığınızda otomatik güncellenir.');
      }

      // Bakım modu açık mı — unutulmuş olabilir
      const maintSnap = await db.collection('config').doc('app_status').get();
      if (maintSnap.exists && maintSnap.data().maintenanceMode === true) {
        addIssue('warning', 'Bakım modu şu anda AÇIK', 'Uygulama şu an ziyaretçilere kapalı. Kasıtlı değilse "🚀 Yayına Al" ile açın.');
      }

      // ── YENİ: Ortam değişkenleri kontrolü ─────────────────────────────
      // Eksik bir ortam değişkeni genelde "her şey çalışıyor gibi görünür,
      // ta ki o özelliğe ihtiyaç duyulana kadar" şeklinde sinsi sorunlara
      // yol açar (örn. ödeme sırasında aniden "escrow istemcisi yok" hatası).
      const requiredEnvVars = [
        { key: 'APP_SECRET', label: 'Pi API Key (escrow ödemeleri için gerekli)' },
        { key: 'PI_WALLET_PRIVATE_SEED', label: 'Escrow cüzdan seed (satıcıya ödeme göndermek için gerekli)' },
        { key: 'FIREBASE_SERVICE_ACCOUNT', label: 'Firebase servis hesabı (JSON) — Firestore/Realtime DB erişimi için gerekli' },
        { key: 'FIREBASE_DATABASE_URL', label: 'Firebase Realtime Database URL (bildirimler için gerekli)' },
        { key: 'FIREBASE_STORAGE_BUCKET', label: 'Firebase Storage bucket (domain görselleri için gerekli)' },
        { key: 'TG_BOT_TOKEN', label: 'Telegram bot token (bildirimler için)' },
        { key: 'TG_CHAT_ID', label: 'Telegram admin sohbet ID' },
        { key: 'ALLOWED_ORIGIN', label: 'CORS izinli origin listesi' }
      ];
      const missingEnv = requiredEnvVars.filter(v => !process.env[v.key]);
      if (missingEnv.length > 0) {
        addIssue('error', `${missingEnv.length} ortam değişkeni Vercel'de tanımlı değil`,
          missingEnv.map(v => `${v.key} (${v.label})`).join('; '));
      }
      if (!process.env.TG_GROUP_ID) {
        addIssue('info', 'TG_GROUP_ID tanımlı değil', 'Satış duyuruları herkese açık Telegram grubuna gönderilemiyor olabilir (admin bildirimleri bundan etkilenmez).');
      }

      // ── YENİ: Canlı bağlantı testleri ──────────────────────────────────
      const connResults = [];
      // Firestore yazma testi (zararsız, tek bir dokümana zaman damgası yazıp okuyoruz)
      try {
        const pingRef = db.collection('config').doc('checkup_ping');
        const pingVal = Date.now();
        await pingRef.set({ lastCheckupAt: pingVal }, { merge: true });
        const pingSnap = await pingRef.get();
        if (pingSnap.data()?.lastCheckupAt !== pingVal) throw new Error('Yazılan değer okunamadı');
        connResults.push('✅ Firestore (okuma/yazma)');
      } catch (e) {
        addIssue('error', 'Firestore\'a yazma/okuma başarısız', String(e.message || e));
      }
      // Realtime Database testi
      try {
        const rtdb = getRtdb();
        const ref = rtdb.ref('_checkup_ping');
        await ref.set(Date.now());
        connResults.push('✅ Realtime Database');
      } catch (e) {
        addIssue('error', 'Realtime Database bağlantısı başarısız', String(e.message || e) + ' — bildirimler (🔔) bundan etkileniyor olabilir.');
      }
      // Pi Platform API erişilebilirlik testi (401 dönmesi dahi "erişilebilir" demektir — sadece ağ/DNS/sunucu tarafını doğruluyoruz)
      try {
        const piResp = await fetch('https://api.minepi.com/v2/me', { headers: { Authorization: 'Key invalid-checkup-probe' } });
        if (piResp.status >= 200 && piResp.status < 600) connResults.push(`✅ Pi Platform API (HTTP ${piResp.status})`);
      } catch (e) {
        addIssue('error', 'Pi Platform API\'sine (api.minepi.com) ulaşılamıyor', String(e.message || e) + ' — ödemeler ve giriş doğrulaması etkilenebilir.');
      }
      // Telegram bot token doğrulama
      if (TG_BOT_TOKEN) {
        try {
          const tgResp = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getMe`);
          const tgData = await tgResp.json();
          if (tgData.ok) connResults.push(`✅ Telegram Bot (@${tgData.result.username})`);
          else addIssue('warning', 'Telegram bot token geçersiz görünüyor', JSON.stringify(tgData));
        } catch (e) {
          addIssue('warning', 'Telegram API\'sine ulaşılamadı', String(e.message || e));
        }
      }

      // ── YENİ: Kayıtlı arka plan hataları (system_errors) ───────────────
      // logSystemError() tarafından yazılan, herhangi bir action'ın kendi
      // catch bloğunda ya da global güvenlik ağında yakalanan gerçek
      // çalışma zamanı hataları. Son 7 gün, en fazla 20 kayıt.
      let recentErrors = [];
      try {
        const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
        const errSnap = await db.collection('system_errors')
          .where('ts', '>=', sevenDaysAgo)
          .orderBy('ts', 'desc')
          .limit(20)
          .get();
        errSnap.forEach(e => recentErrors.push({ id: e.id, ...e.data() }));
      } catch (e) {
        // system_errors koleksiyonu/indexi henüz yoksa (ilk çalıştırma) sessizce geç
      }
      if (recentErrors.length > 0) {
        const grouped = {};
        recentErrors.forEach(e => { grouped[e.action] = (grouped[e.action] || 0) + 1; });
        const summary = Object.entries(grouped).map(([a, c]) => `${a}: ${c}`).join(', ');
        const lastFew = recentErrors.slice(0, 5).map(e => `[${new Date(e.ts).toLocaleString('tr-TR')}] ${e.action}: ${e.message}`).join('\n');
        addIssue('warning', `Son 7 günde ${recentErrors.length} arka plan hatası kaydedildi`,
          `Action bazında: ${summary}\n\nEn son 5 kayıt:\n${lastFew}`);
      }

      return res.status(200).json({
        success: true,
        issues,
        connResults,
        summary: { domainsScanned: domainsSnap.size, soldCount, salesScanned: salesSnap.size, sellRequestsScanned: sellReqSnap.size, trademarkClaimsScanned: tmSnap.size, backgroundErrors: recentErrors.length, offersScanned: offersSnap.size, orphanedOffers: orphanedOfferCount }
      });
    } catch (e) {
      console.error("run_system_checkup hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Yetim Teklif Kayıtlarını Temizle ────────────────────────────────────
  // Admin panelindeki "🧹 Yetim Verileri Temizle" butonunun arkası.
  // deleteOffersForDomain() artık her domain silindiğinde (soft/kalıcı)
  // otomatik çalışıyor, AMA bu düzeltmeden ÖNCE silinmiş domainlerin
  // "offers" kayıtları hâlâ Firestore'da duruyor olabilir. Bu action, artık
  // var olmayan VEYA "deleted:true" olan domainlere ait tüm teklif
  // kayıtlarını tarar ve kalıcı olarak siler. Idempotent'tir — temiz bir
  // veritabanında tekrar çalıştırıldığında hiçbir şey silmez.
  if (action === 'cleanup_orphaned_offers') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const [domainsSnap, offersSnap] = await Promise.all([
        db.collection('domains').get(),
        db.collection('offers').get()
      ]);

      const domainStatusMap = {};
      domainsSnap.forEach(d => { domainStatusMap[d.id] = d.data().deleted === true; });

      const orphanDocs = [];
      const affectedDomains = {};
      offersSnap.forEach(o => {
        const dn = o.data().domainName;
        if (!dn) return;
        const isOrphan = !(dn in domainStatusMap) || domainStatusMap[dn] === true;
        if (isOrphan) {
          orphanDocs.push(o.ref);
          affectedDomains[dn] = (affectedDomains[dn] || 0) + 1;
        }
      });

      if (orphanDocs.length === 0) {
        return res.status(200).json({ success: true, deletedCount: 0, affectedDomains: [] });
      }

      for (let i = 0; i < orphanDocs.length; i += 400) {
        const batch = db.batch();
        orphanDocs.slice(i, i + 400).forEach(ref => batch.delete(ref));
        await batch.commit();
      }

      const affectedList = Object.entries(affectedDomains).map(([domainName, count]) => ({ domainName, count }));
      await logAdminAction(await getRealUsername(accessToken), 'cleanup_orphaned_offers', `${orphanDocs.length} kayıt / ${affectedList.length} domain`);
      console.log(`[Yetim veri temizliği] ${orphanDocs.length} teklif kaydı silindi (${affectedList.length} domain)`);
      return res.status(200).json({ success: true, deletedCount: orphanDocs.length, affectedDomains: affectedList });
    } catch (e) {
      console.error("cleanup_orphaned_offers hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Platform İstatistiklerini Sıfırla ─────────────────────────────────
  if (action === 'reset_platform_stats') {
    const { confirmReset } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (confirmReset !== true) {
      return res.status(400).json({ error: "Bu kalıcı bir işlemdir. confirmReset:true parametresi olmadan çalıştırılamaz." });
    }
    try {
      const db = getDb();

      const salesSnap = await db.collection('global_sales').get();
      let batch = db.batch();
      let opCount = 0;
      for (const doc of salesSnap.docs) {
        batch.delete(doc.ref);
        opCount++;
        if (opCount >= 450) { await batch.commit(); batch = db.batch(); opCount = 0; }
      }
      if (opCount > 0) await batch.commit();

      const statsSnap = await db.collection('daily_stats').get();
      batch = db.batch();
      opCount = 0;
      for (const doc of statsSnap.docs) {
        batch.delete(doc.ref);
        opCount++;
        if (opCount >= 450) { await batch.commit(); batch = db.batch(); opCount = 0; }
      }
      if (opCount > 0) await batch.commit();

      const profilesSnap = await db.collection('user_profiles').get();
      batch = db.batch();
      opCount = 0;
      for (const doc of profilesSnap.docs) {
        batch.set(doc.ref, { points: 0, badge: null, resetAt: Date.now() }, { merge: true });
        opCount++;
        if (opCount >= 450) { await batch.commit(); batch = db.batch(); opCount = 0; }
      }
      if (opCount > 0) await batch.commit();

      // Kalıcı gelir defterini de sıfırla — aksi halde Kazanç ekranı reset
      // sonrası hâlâ eski (silinmiş) satışlardan gelen toplamları gösterir.
      await db.collection('config').doc('platform_stats').set({
        totalVolume: 0, userOwnedVolume: 0, platformEarnings: 0, adminOwnEarnings: 0, statsVersion: 2, resetAt: Date.now()
      });

      const resetTimestamp = Date.now();
      await db.collection('system_config').doc('reset_epoch').set({
        resetAt: resetTimestamp,
        resetBy: ADMIN_USERNAME
      });

      console.log(`Platform istatistikleri sıfırlandı: ${new Date(resetTimestamp).toISOString()}`);
      await logAdminAction(await getRealUsername(accessToken), 'reset_platform_stats', 'TÜM satış geçmişi ve puanlar sıfırlandı');
      return res.status(200).json({ success: true, resetAt: resetTimestamp });
    } catch (e) {
      console.error("Platform sıfırlama hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Satış Önerisi Gönder ──────────────────────────────────────────────
  if (action === 'submit_sell_request') {
    if (!await checkRateLimit(clientIp, 'submit_sell_request', 3, 60000))
      return res.status(429).json({ error: "Çok fazla istek. 1 dakika bekleyin." });

    const { domainName: reqDomainName, price: reqPrice, domainType, imgPath: reqImgPath, sellerNote, ownershipProof, description, editMode, oldRequestId } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçerli Pi oturumu bulunamadı" });

    const priceNum = Number(reqPrice);
    if (!reqDomainName || !priceNum || priceNum <= 0) return res.status(400).json({ error: "Geçersiz parametre" });
    if (!isValidDomainName(reqDomainName))
      return res.status(400).json({ error: "Geçersiz domain adı formatı. Örnek: example.com" });
    // Sahiplik kanıtı zorunlu — açık artırmayla kazanılmış bir domaini
    // başkasının adına satışa çıkarmayı zorlaştırmak için minimum bir engel.
    if (!ownershipProof || !ownershipProof.trim())
      return res.status(400).json({ error: "Sahiplik kanıtı zorunludur. Bu domainin size ait olduğunu doğrulayacak bilgiyi girmelisiniz." });

    try {
      const db = getDb();
      const existingDomain = await db.collection('domains').doc(reqDomainName).get();
      if (existingDomain.exists) {
        return res.status(400).json({
          error: existingDomain.data().deleted === true
            ? "Bu domain adı daha önce kullanılmış ve silinmiş, tekrar kullanılamaz."
            : "Bu domain zaten markette mevcut"
        });
      }

      // ── Düzenle & Yeniden Gönder (editMode) ──────────────────────────
      // Kullanıcı reddedilmiş bir ilanı düzenleyip yeniden gönderdiğinde,
      // eski reddedilmiş kaydı sil. Böylece hem listede tekrar görünmez
      // hem de yeni istek onaylandığında ortada "hayalet" reddedilmiş
      // kayıt kalmaz.
      let oldReqRef = null;
      if (editMode && oldRequestId) {
        oldReqRef = db.collection('sell_requests').doc(oldRequestId);
        const oldReqSnap = await oldReqRef.get();
        if (!oldReqSnap.exists) return res.status(404).json({ error: "Düzenlenecek ilan talebi bulunamadı" });
        const oldReqData = oldReqSnap.data();
        if (oldReqData.submittedBy !== realUsername) return res.status(403).json({ error: "Bu talebi düzenleme yetkiniz yok" });
        if (oldReqData.status !== 'rejected') return res.status(400).json({ error: "Sadece reddedilmiş talepler düzenlenebilir" });
      }

      const existingReq = await db.collection('sell_requests')
        .where('submittedBy', '==', realUsername)
        .where('status', '==', 'pending')
        .where('domainName', '==', reqDomainName)
        .get();
      if (!existingReq.empty) return res.status(400).json({ error: "Bu domain için zaten bekleyen bir öneriniz var" });

      if (oldReqRef) {
        await oldReqRef.delete();
      }

      const requestRef = db.collection('sell_requests').doc();
      await requestRef.set({
        domainName: reqDomainName,
        price: priceNum,
        domainType: domainType || 'genel',
        img: reqImgPath || 'assets/default.jpeg',
        sellerNote: sellerNote || null,
        ownershipProof: ownershipProof.trim(),
        description: description || '',
        submittedBy: realUsername,
        status: 'pending',
        deleted: false,
        submittedAt: Date.now()
      });

      await sendNotificationToAdmin({
        type: 'new_sell_request',
        title: 'Yeni Domain Önerisi',
        body: `@${realUsername} tarafından "${reqDomainName}" domaini onay için gönderildi.`,
        domainName: reqDomainName,
        requestId: requestRef.id
      });

      await sendTG(TG_CHAT_ID, `📬 *YENİ DOMAIN ÖNERİSİ*\n\n👤 @${realUsername}\n🌐 ${reqDomainName}\n💰 ${priceNum} Pi\n📋 ${description || '—'}`);

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("Satış önerisi hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Satış Önerisini Onayla ────────────────────────────────────────────
  if (action === 'approve_sell_request') {
    const { requestId } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!requestId) return res.status(400).json({ error: "Geçersiz istek ID" });
    try {
      const db = getDb();
      const requestRef = db.collection('sell_requests').doc(requestId);
      const requestSnap = await requestRef.get();
      if (!requestSnap.exists) return res.status(404).json({ error: "Öneri bulunamadı" });
      const reqData = requestSnap.data();
      if (reqData.status !== 'pending') return res.status(400).json({ error: "Bu öneri zaten işlenmiş" });

      const domainRef = db.collection('domains').doc(reqData.domainName);
      const existingDomain = await domainRef.get();
      if (existingDomain.exists) {
        return res.status(400).json({
          error: existingDomain.data().deleted === true
            ? "Bu domain adı silinmiş durumda, onaylanamaz. Önce restore_domain ile geri getirin."
            : "Domain adı zaten mevcut"
        });
      }

      await domainRef.set({
        sold: false, price: reqData.price,
        img: reqData.img, type: reqData.domainType,
        description: reqData.description || '',
        sellerUsername: reqData.submittedBy,
        sellerNote: reqData.sellerNote,
        ownershipProof: reqData.ownershipProof || null,
        txid: null, buyer: null, at: null,
        deleted: false, deletedAt: null,
        createdAt: Date.now()
      });
      await requestRef.set({ status: 'approved', resolvedAt: Date.now() }, { merge: true });

      await sendNotification(reqData.submittedBy, {
        type: 'sell_request_approved',
        title: '✅ Domain Öneriniz Onaylandı!',
        body: `"${reqData.domainName}" domaininiz markete eklendi. Satışa hazır!`,
        domainName: reqData.domainName
      });

      await updateUserPoints(reqData.submittedBy, 20, 'domain_approved');
      await logAdminAction(await getRealUsername(accessToken), 'approve_sell_request', `${reqData.domainName} (@${reqData.submittedBy})`);

      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Satış Önerisini Reddet ────────────────────────────────────────────
  if (action === 'reject_sell_request') {
    const { requestId, rejectReason } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!requestId) return res.status(400).json({ error: "Geçersiz istek ID" });
    try {
      const db = getDb();
      const requestRef = db.collection('sell_requests').doc(requestId);
      const requestSnap = await requestRef.get();
      const reqData = requestSnap.data();
      await requestRef.set({ status: 'rejected', resolvedAt: Date.now(), rejectReason: rejectReason || '' }, { merge: true });

      if (reqData?.submittedBy) {
        await sendNotification(reqData.submittedBy, {
          type: 'sell_request_rejected',
          title: '❌ Domain Öneriniz Reddedildi',
          body: `"${reqData.domainName}" öneriniz reddedildi.${rejectReason ? ' Neden: ' + rejectReason : ''}`,
          domainName: reqData.domainName
        });
      }

      await logAdminAction(await getRealUsername(accessToken), 'reject_sell_request', `${reqData?.domainName || requestId}${rejectReason ? ' - ' + rejectReason : ''}`);

      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── İlan Talebini Geri Çek (pending durumundaki sell_request) ─────────
  if (action === 'withdraw_sell_request') {
    const { requestId } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!requestId) return res.status(400).json({ error: "Geçersiz istek ID" });
    try {
      const db = getDb();
      const requestRef = db.collection('sell_requests').doc(requestId);
      const snap = await requestRef.get();
      if (!snap.exists) return res.status(404).json({ error: "İlan talebi bulunamadı" });
      const data = snap.data();
      if (data.submittedBy !== realUsername) return res.status(403).json({ error: "Bu talebi geri çekme yetkiniz yok" });
      if (data.status !== 'pending') return res.status(400).json({ error: "Sadece onay bekleyen talepler geri çekilebilir" });

      await requestRef.set({ status: 'withdrawn', withdrawnAt: Date.now() }, { merge: true });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Reddedilmiş veya Geri Çekilmiş İlan Talebini Sil ───────────────────
  if (action === 'delete_rejected_request') {
    const { requestId } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!requestId) return res.status(400).json({ error: "Geçersiz istek ID" });
    try {
      const db = getDb();
      const requestRef = db.collection('sell_requests').doc(requestId);
      const snap = await requestRef.get();
      if (!snap.exists) return res.status(404).json({ error: "İlan talebi bulunamadı" });
      const data = snap.data();
      if (data.submittedBy !== realUsername) return res.status(403).json({ error: "Bu talebi silme yetkiniz yok" });
      // FIX: sadece 'rejected' değil, 'withdrawn' (kullanıcının kendi geri
      // çektiği) talepler de artık silinebiliyor — daha önce bu durumda
      // "İlanı Sil" butonu hiç görünmüyordu.
      if (data.status !== 'rejected' && data.status !== 'withdrawn')
        return res.status(400).json({ error: "Sadece reddedilmiş veya geri çekilmiş talepler silinebilir" });

      await requestRef.delete();
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  TICKET / DESTEK SİSTEMİ — frontend ile birebir uyumlu action isimleri
  //  Mesaj formatı: { from: 'username'|'admin', text: '...', timestamp: N }
  // ══════════════════════════════════════════════════════════════════════

  // ── Ticket Oluştur (Kullanıcı) ────────────────────────────────────────
  if (action === 'create_ticket') {
    if (!await checkRateLimit(clientIp, 'create_ticket', 5, 60000))
      return res.status(429).json({ error: "Çok fazla istek. Lütfen bekleyin." });

    const { subject, category, message, priority } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!subject || !message) return res.status(400).json({ error: "Konu ve mesaj zorunludur" });

    try {
      const db = getDb();
      const ticketRef = db.collection('tickets').doc();
      const now = Date.now();

      await ticketRef.set({
        subject,
        category: category || 'general',
        priority: priority || 'normal',
        status: 'new',
        createdBy: realUsername,
        createdAt: now,
        lastUpdate: now,
        assignedTo: null,
        messages: [{ from: realUsername, text: message, timestamp: now }]
      });

      await sendNotification(realUsername, {
        type: 'ticket_created',
        title: '📬 Talebiniz Alındı',
        body: `"${subject}" konulu talebiniz oluşturuldu. En kısa sürede yanıtlanacaktır.`,
        ticketId: ticketRef.id
      });

      await sendNotificationToAdmin({
        type: 'new_ticket',
        title: '🎫 Yeni Destek Talebi',
        body: `@${realUsername} tarafından "${subject}" konulu yeni bir talep oluşturuldu.`,
        ticketId: ticketRef.id
      });

      await sendTG(TG_CHAT_ID, `🎫 *YENİ DESTEK TALEBİ*\n\n👤 @${realUsername}\n📌 ${subject}\n🏷️ ${category || 'general'}`);

      return res.status(200).json({ success: true, ticketId: ticketRef.id });
    } catch (e) {
      console.error("Ticket oluşturma hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kullanıcı: Kendi Ticket'larını Getir ──────────────────────────────
  if (action === 'get_my_tickets') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const snap = await db.collection('tickets').where('createdBy', '==', realUsername).get();
      const tickets = [];
      snap.forEach(doc => tickets.push({ id: doc.id, ...doc.data() }));
      tickets.sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));

      // Kullanıcının en son ne zaman kendi taleplerini görüntülediğini kontrol et.
      // Bir talebe admin'den yanıt geldiyse ve kullanıcı henüz görmediyse
      // "okunmamış" say (kendi gönderdiği mesajlar sayaca dahil edilmez).
      const seenSnap = await db.collection('system_config').doc(`user_ticket_seen_${realUsername}`).get();
      const seenAt = seenSnap.exists ? (seenSnap.data().seenAt || 0) : 0;
      const unseenCount = tickets.filter(tk => {
        if ((tk.lastUpdate || 0) <= seenAt) return false;
        const lastMsg = tk.messages && tk.messages.length ? tk.messages[tk.messages.length - 1] : null;
        return lastMsg && lastMsg.from === 'admin';
      }).length;

      return res.status(200).json({ success: true, tickets, unseenCount, seenAt });
    } catch (e) {
      console.error("get_my_tickets hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kullanıcı: Kendi Ticket Bildirimlerini Görüldü Olarak İşaretle ─────
  if (action === 'mark_my_tickets_seen') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const now = Date.now();
      await db.collection('system_config').doc(`user_ticket_seen_${realUsername}`).set({ seenAt: now }, { merge: true });
      return res.status(200).json({ success: true, seenAt: now });
    } catch (e) {
      console.error("mark_my_tickets_seen hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kullanıcı: Ticket'a Yanıt Gönder ──────────────────────────────────
  if (action === 'reply_ticket') {
    const { ticketId, text } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!ticketId || !text) return res.status(400).json({ error: "ticketId ve mesaj zorunludur" });
    try {
      const db = getDb();
      const ticketRef = db.collection('tickets').doc(ticketId);
      const snap = await ticketRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Talep bulunamadı" });
      const data = snap.data();
      if (data.createdBy !== realUsername) return res.status(403).json({ error: "Bu talebe yanıt verme yetkiniz yok" });
      if (data.status === 'closed') return res.status(400).json({ error: "Kapatılmış talebe yanıt verilemez" });

      const now = Date.now();
      // "Çözüldü" olarak işaretlenmiş bir talebe kullanıcı yanıt yazdığında (ör. teşekkür mesajı),
      // bunu "yeni" duruma — yani sıfırdan başlıyormuş gibi — almak mantıksız: talep zaten
      // çözülmüş durumda, kullanıcı sadece kapanış onayı/teşekkür niteliğinde yazmış oluyor.
      // Bu yüzden akışın doğal son adımı olarak talebi doğrudan 'closed' durumuna alıyoruz.
      // Gerçekten yeni bir sorun varsa kullanıcı yeni bir destek talebi açmalı.
      // "Yanıtlandı" durumundaki normal karşılıklı yazışma akışında ise 'reviewing'e
      // dönmeye devam ediyor (bu, olağan bir takip mesajı).
      const wasResolved = data.status === 'resolved';
      const newStatus = wasResolved ? 'closed' : (data.status === 'answered' ? 'reviewing' : data.status);

      await ticketRef.update({
        messages: FieldValue.arrayUnion({ from: realUsername, text, timestamp: now }),
        lastUpdate: now,
        status: newStatus
      });

      await sendNotificationToAdmin({
        type: 'ticket_message',
        title: wasResolved ? '✅ Talep Kapatıldı' : '💬 Yeni Mesaj',
        body: wasResolved
          ? `@${realUsername} çözüldü olarak işaretlenen "${data.subject}" talebine yanıt verdi, talep kapatıldı.`
          : `@${realUsername} "${data.subject}" talebine yeni mesaj gönderdi.`,
        ticketId
      });

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("reply_ticket hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Tüm Ticket'ları Getir ──────────────────────────────────────
  if (action === 'get_all_tickets') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const snap = await db.collection('tickets').get();
      const tickets = [];
      snap.forEach(doc => {
        const d = doc.data();
        tickets.push({ id: doc.id, ...d, username: d.createdBy });
      });
      tickets.sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));

      const seenSnap = await db.collection('system_config').doc('admin_ticket_seen').get();
      const seenAt = seenSnap.exists ? (seenSnap.data().seenAt || 0) : 0;
      // Kapatılmış talepler bildirim sayacına dahil edilmez; kullanıcıdan
      // gelen yeni mesaj/talep sonrası lastUpdate, admin'in son görme
      // zamanından yeniyse "okunmamış" sayılır.
      const unseenCount = tickets.filter(tk => tk.status !== 'closed' && (tk.lastUpdate || 0) > seenAt).length;

      return res.status(200).json({ success: true, tickets, unseenCount, seenAt });
    } catch (e) {
      console.error("get_all_tickets hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Ticket Bildirimlerini Görüldü Olarak İşaretle ───────────────
  if (action === 'mark_tickets_seen') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const now = Date.now();
      await db.collection('system_config').doc('admin_ticket_seen').set({ seenAt: now }, { merge: true });
      return res.status(200).json({ success: true, seenAt: now });
    } catch (e) {
      console.error("mark_tickets_seen hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Marka Hakkı / Telif Bildirimi (DMCA-benzeri Claim Formu)
  //  Not: Bu, tescilli marka/domain sahiplerinin -Pi hesabı olmasa dahi-
  //  başvurabileceği HERKESE AÇIK bir uçtur; bu yüzden accessToken/Pi
  //  girişi ARANMAZ, sadece IP bazlı rate-limit ile kötüye kullanım
  //  engellenir.
  // ══════════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════
  //  Pi Hesap UID Senkronizasyonu (Escrow / A2U Ödemesi İçin)
  //  Kullanıcının yazdığı bir cüzdan adresi DEĞİL — Pi'nin resmi A2U akışı
  //  ödemeyi doğrudan hesabın UID'si üzerinden kendi cüzdanına yönlendiriyor.
  //  Bu yüzden her girişte sessizce senkronize ediyoruz.
  // ══════════════════════════════════════════════════════════════════════
  if (action === 'sync_user_uid') {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: "uid zorunludur" });
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(401).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      await db.collection('users').doc(realUsername).set({ piUid: uid, piUidSyncedAt: Date.now() }, { merge: true });
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("sync_user_uid hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ADMIN: BAKIM MODU (Maintenance Mode)
  // ══════════════════════════════════════════════════════════════════════
  if (action === 'set_maintenance_mode') {
    const { enabled } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const realUsername = await getRealUsername(accessToken);
      await db.collection('config').doc('app_status').set({
        maintenanceMode: !!enabled,
        updatedAt: Date.now(),
        updatedBy: realUsername
      }, { merge: true });
      await logAdminAction(realUsername, 'set_maintenance_mode', enabled ? 'AÇILDI' : 'KAPATILDI');
      return res.status(200).json({ success: true, maintenanceMode: !!enabled });
    } catch (e) {
      console.error("set_maintenance_mode hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'submit_trademark_claim') {
    if (!await checkRateLimit(clientIp, 'submit_trademark_claim', 3, 3600000))
      return res.status(429).json({ error: "Çok fazla istek. Lütfen daha sonra tekrar deneyin." });

    const { claimantName, companyName, domainName: claimDomain, trademarkInfo, description, contactEmail } = req.body;

    if (!claimantName || !claimDomain || !description || !contactEmail)
      return res.status(400).json({ error: "Zorunlu alanlar eksik: ad, domain adı, açıklama ve e-posta gereklidir." });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(contactEmail))
      return res.status(400).json({ error: "Geçerli bir e-posta adresi girin." });

    if (String(claimantName).length > 200 || String(companyName || '').length > 200 ||
        String(claimDomain).length > 100 || String(trademarkInfo || '').length > 500 ||
        String(description).length > 3000 || String(contactEmail).length > 200) {
      return res.status(400).json({ error: "Bir veya daha fazla alan çok uzun." });
    }

    try {
      const db = getDb();
      const now = Date.now();

      // Başvuran o an Pi ile giriş yapmışsa (accessToken varsa), talebi kendi
      // hesabına bağlıyoruz ki "Panelim" kısmından süreci takip edebilsin.
      // Giriş yapmamış (Pi hesabı olmayan) marka sahipleri için bu alan boş
      // kalır — sadece e-posta üzerinden bilgilendirilirler.
      let submittedByUsername = null;
      if (accessToken) {
        submittedByUsername = await getRealUsername(accessToken);
      }

      const claimRef = db.collection('trademark_claims').doc();
      await claimRef.set({
        claimantName: String(claimantName).trim(),
        companyName: String(companyName || '').trim(),
        domainName: String(claimDomain).trim(),
        trademarkInfo: String(trademarkInfo || '').trim(),
        description: String(description).trim(),
        contactEmail: String(contactEmail).trim(),
        status: 'new',
        createdAt: now,
        ip: clientIp,
        submittedByUsername: submittedByUsername || null
      });

      await sendNotificationToAdmin({
        type: 'trademark_claim',
        title: '🔖 Yeni Marka Hakkı Talebi',
        body: `"${claimDomain}" domaini için ${claimantName} tarafından bir marka hakkı bildirimi yapıldı.`,
        claimId: claimRef.id
      });
      await sendTG(TG_CHAT_ID, `🔖 *Yeni Marka Hakkı Talebi*\nDomain: ${claimDomain}\nBaşvuran: ${claimantName}\nE-posta: ${contactEmail}`);

      return res.status(200).json({ success: true, claimId: claimRef.id });
    } catch (e) {
      console.error("submit_trademark_claim hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Marka Hakkı Taleplerini Listele ─────────────────────────────
  if (action === 'get_trademark_claims') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const snap = await db.collection('trademark_claims').get();
      const claims = [];
      snap.forEach(doc => claims.push({ id: doc.id, ...doc.data() }));
      claims.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return res.status(200).json({ success: true, claims });
    } catch (e) {
      console.error("get_trademark_claims hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Bekleyen İlan Taleplerini Getir ─────────────────────────────
  // GÜVENLİK: sell_requests koleksiyonu (satıcı adayının cüzdan adresi dahil)
  // artık Firestore'dan doğrudan okunmuyor; bu action üzerinden, admin
  // doğrulamasından geçerek çekiliyor.
  if (action === 'get_pending_sell_requests') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const snap = await db.collection('sell_requests').get();
      const requests = [];
      snap.forEach(doc => requests.push({ id: doc.id, ...doc.data() }));
      requests.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
      return res.status(200).json({ success: true, requests });
    } catch (e) {
      console.error("get_pending_sell_requests hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Marka Hakkı Talebi Durumunu Güncelle ────────────────────────
  if (action === 'update_trademark_claim_status') {
    const { claimId, status } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    const validStatuses = ['new', 'reviewing', 'resolved', 'rejected', 'withdrawn'];
    if (!claimId || !validStatuses.includes(status)) return res.status(400).json({ error: "Geçersiz parametre" });
    try {
      const db = getDb();
      const claimRef = db.collection('trademark_claims').doc(claimId);
      await claimRef.set({ status, updatedAt: Date.now() }, { merge: true });

      if (status === 'rejected') {
        const claimSnap = await claimRef.get();
        const claim = claimSnap.data();
        if (claim && claim.submittedByUsername) {
          await sendNotification(claim.submittedByUsername, {
            type: 'trademark_claim_rejected',
            title: '❌ Marka Hakkı Talebiniz Reddedildi',
            body: `"${claim.domainName}" domaini hakkındaki marka hakkı talebiniz incelendi ve reddedildi.`,
            domainName: claim.domainName
          });
        }
      }

      await logAdminAction(await getRealUsername(accessToken), 'update_trademark_claim_status', `claim:${claimId} → ${status}`);

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("update_trademark_claim_status hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ADMIN: Marka Hakkı Talebini "Haklı Bul" — Domaini Kaldır
  //  Talep haklı bulunduğunda, sadece durumu güncellemekle kalmıyoruz —
  //  itiraz edilen domaini gerçekten pazarlıktan kaldırıyoruz (satın
  //  alınamaz/satılamaz hale getiriyoruz). Domain zaten satılmışsa,
  //  kaldırmadan önce alıcı/satıcıya bilgi veriyoruz.
  // ══════════════════════════════════════════════════════════════════════
  if (action === 'approve_trademark_claim') {
    const { claimId } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!claimId) return res.status(400).json({ error: "claimId zorunludur" });
    try {
      const db = getDb();
      const claimRef = db.collection('trademark_claims').doc(claimId);
      const claimSnap = await claimRef.get();
      if (!claimSnap.exists) return res.status(404).json({ error: "Talep bulunamadı" });
      const claim = claimSnap.data();

      const domainName = String(claim.domainName || '').trim();
      let domainRemoved = false;
      let domainNotFoundNote = '';

      if (domainName) {
        const domainRef = db.collection('domains').doc(domainName);
        const domainSnap = await domainRef.get();
        if (domainSnap.exists) {
          const domainData = domainSnap.data();
          // Domain satılmışsa ilgili tarafları bilgilendir.
          if (domainData.buyer) {
            await sendNotification(domainData.buyer, {
              type: 'domain_removed_trademark',
              title: '⚠️ Domain Marka Hakkı İhlali Nedeniyle Kaldırıldı',
              body: `"${domainName}" domaini, geçerli bir marka hakkı talebi nedeniyle platformdan kaldırıldı. Destek talebi açarak durumunuzu iletebilirsiniz.`,
              domainName
            });
          }
          if (domainData.sellerUsername) {
            await sendNotification(domainData.sellerUsername, {
              type: 'domain_removed_trademark',
              title: '⚠️ İlanınız Marka Hakkı İhlali Nedeniyle Kaldırıldı',
              body: `"${domainName}" isimli ilanınız, geçerli bulunan bir marka hakkı talebi nedeniyle platformdan kaldırıldı.`,
              domainName
            });
          }
          await domainRef.delete();
          domainRemoved = true;
        } else {
          domainNotFoundNote = 'Domain zaten platformda mevcut değildi (muhtemelen daha önce kaldırılmış).';
        }
      }

      await claimRef.set({ status: 'resolved', updatedAt: Date.now(), domainRemoved }, { merge: true });

      if (claim.submittedByUsername) {
        await sendNotification(claim.submittedByUsername, {
          type: 'trademark_claim_resolved',
          title: '✅ Marka Hakkı Talebiniz Haklı Bulundu',
          body: `"${domainName}" domaini hakkındaki talebiniz incelendi ve haklı bulundu. Domain platformdan kaldırıldı.`,
          domainName
        });
      }

      await logAdminAction(await getRealUsername(accessToken), 'approve_trademark_claim', `${domainName} kaldırıldı (claim:${claimId})`);

      return res.status(200).json({ success: true, domainRemoved, note: domainNotFoundNote });
    } catch (e) {
      console.error("approve_trademark_claim hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Reddedilmiş Marka Hakkı Talebini Sil ────────────────────────
  // Güvenlik için sadece 'rejected' durumundaki talepler silinebilir —
  // aktif/çözülmüş bir talebin kaza sonucu silinmesini engeller.
  if (action === 'delete_trademark_claim') {
    const { claimId } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!claimId) return res.status(400).json({ error: "claimId zorunludur" });
    try {
      const db = getDb();
      const claimRef = db.collection('trademark_claims').doc(claimId);
      const snap = await claimRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Talep bulunamadı" });
      if (snap.data().status !== 'rejected' && snap.data().status !== 'resolved')
        return res.status(400).json({ error: "Sadece reddedilmiş veya çözülmüş talepler silinebilir." });
      await claimRef.delete();
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("delete_trademark_claim hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kullanıcı: Kendi Çözülmüş Marka Hakkı Talebini Sil ──────────────────
  if (action === 'delete_my_trademark_claim') {
    const { claimId } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!claimId) return res.status(400).json({ error: "claimId zorunludur" });
    try {
      const db = getDb();
      const claimRef = db.collection('trademark_claims').doc(claimId);
      const snap = await claimRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Talep bulunamadı" });
      const claim = snap.data();
      if (claim.submittedByUsername !== realUsername) return res.status(403).json({ error: "Bu talebi silme yetkiniz yok" });
      if (claim.status !== 'resolved')
        return res.status(400).json({ error: "Sadece çözülmüş talepler silinebilir." });
      await claimRef.delete();
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("delete_my_trademark_claim hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kullanıcı: Kendi Marka Hakkı Taleplerini Listele (Panelim) ─────────
  if (action === 'get_my_trademark_claims') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(401).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const snap = await db.collection('trademark_claims').where('submittedByUsername', '==', realUsername).get();
      const claims = [];
      snap.forEach(doc => claims.push({ id: doc.id, ...doc.data() }));
      claims.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return res.status(200).json({ success: true, claims });
    } catch (e) {
      console.error("get_my_trademark_claims hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kullanıcı: Kendi Marka Hakkı Talebini Geri Çek ─────────────────────
  // Sadece 'new' veya 'reviewing' durumundaki talepler geri çekilebilir;
  // zaten sonuçlanmış (çözüldü/reddedildi) bir talep geri çekilemez.
  if (action === 'withdraw_trademark_claim') {
    const { claimId } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(401).json({ error: "Geçersiz oturum" });
    if (!claimId) return res.status(400).json({ error: "claimId zorunludur" });
    try {
      const db = getDb();
      const claimRef = db.collection('trademark_claims').doc(claimId);
      const snap = await claimRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Talep bulunamadı" });
      const claim = snap.data();
      if (claim.submittedByUsername !== realUsername)
        return res.status(403).json({ error: "Bu talep size ait değil." });
      if (claim.status !== 'new' && claim.status !== 'reviewing')
        return res.status(400).json({ error: "Bu talep artık geri çekilemez (sonuçlanmış)." });
      await claimRef.set({ status: 'withdrawn', updatedAt: Date.now() }, { merge: true });
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("withdraw_trademark_claim hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ADMIN: ESCROW — Bekleyen Satıcı Ödemelerini Listele
  // ══════════════════════════════════════════════════════════════════════
  if (action === 'get_pending_payouts') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const snap = await db.collection('global_sales')
        .where('payoutStatus', 'in', ['pending', 'no_seller', 'processing', 'released', 'failed', 'refund_processing', 'refunded', 'refund_failed'])
        .get();
      const payouts = [];
      snap.forEach(doc => payouts.push({ id: doc.id, ...doc.data() }));
      payouts.sort((a, b) => (b.at || 0) - (a.at || 0));
      return res.status(200).json({ success: true, payouts });
    } catch (e) {
      console.error("get_pending_payouts hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ADMIN: ESCROW — Satıcıya Ödemeyi Serbest Bırak (A2U)
  //  Admin, domainin satıcıdan alıcıya devrini teyit ettikten SONRA bu
  //  aksiyonu tetikler. Komisyon düşülmüş tutar, satıcının en son giriş
  //  yaptığı Pi hesabına (UID üzerinden) otomatik olarak gönderilir.
  // ══════════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════
  //  ESCROW GÜVEN MEKANİZMASI: Alıcı/Satıcı Devir Onayı
  //  Admin'in "Transfer Tamam Öde" / "İade Et" kararını uygulama DIŞINDAN
  //  gelen sözlü bilgiye göre değil, uygulama İÇİNDE hem alıcının hem
  //  satıcının verdiği gerçek onaya göre verebilmesi için.
  // ══════════════════════════════════════════════════════════════════════
  if (action === 'confirm_transfer_buyer') {
    const { domainName: transferDomainName, confirmed, note } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!transferDomainName) return res.status(400).json({ error: "domainName zorunludur" });
    try {
      const db = getDb();
      const saleQuery = await db.collection('global_sales')
        .where('domain', '==', transferDomainName)
        .where('user', '==', realUsername)
        .limit(1).get();
      if (saleQuery.empty) return res.status(404).json({ error: "Satış kaydı bulunamadı" });
      const saleRef = saleQuery.docs[0].ref;
      const sale = saleQuery.docs[0].data();
      if (sale.payoutStatus === 'released' || sale.payoutStatus === 'refunded')
        return res.status(400).json({ error: "Bu işlem zaten sonuçlanmış, onay artık değiştirilemez" });

      await saleRef.set({
        buyerConfirmed: !!confirmed,
        buyerConfirmedAt: Date.now(),
        buyerConfirmNote: note || null,
        buyerDisputeResolution: null
      }, { merge: true });
      if (sale.domain) {
        await db.collection('domains').doc(sale.domain).set({
          buyerConfirmed: !!confirmed, buyerConfirmedAt: Date.now(), buyerDisputeResolution: null
        }, { merge: true });
      }

      await sendNotificationToAdmin({
        type: 'transfer_confirmation',
        title: confirmed ? '✅ Alıcı Devri Onayladı' : '⚠️ Alıcı Sorun Bildirdi',
        body: `"${sale.domain}" için @${realUsername} (alıcı) ${confirmed ? 'domaini teslim aldığını onayladı.' : 'bir sorun bildirdi: ' + (note || 'detay belirtmedi')}`,
        domainName: sale.domain
      });

      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'confirm_transfer_seller') {
    const { domainName: transferDomainName, confirmed, note } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!transferDomainName) return res.status(400).json({ error: "domainName zorunludur" });
    try {
      const db = getDb();
      const saleQuery = await db.collection('global_sales')
        .where('domain', '==', transferDomainName)
        .where('sellerUsername', '==', realUsername)
        .limit(1).get();
      if (saleQuery.empty) return res.status(404).json({ error: "Satış kaydı bulunamadı" });
      const saleRef = saleQuery.docs[0].ref;
      const sale = saleQuery.docs[0].data();
      if (sale.payoutStatus === 'released' || sale.payoutStatus === 'refunded')
        return res.status(400).json({ error: "Bu işlem zaten sonuçlanmış, onay artık değiştirilemez" });

      await saleRef.set({
        sellerConfirmed: !!confirmed,
        sellerConfirmedAt: Date.now(),
        sellerConfirmNote: note || null,
        sellerDisputeResolution: null
      }, { merge: true });
      await db.collection('domains').doc(transferDomainName).set({
        sellerConfirmed: !!confirmed, sellerConfirmedAt: Date.now(), sellerDisputeResolution: null
      }, { merge: true });

      await sendNotificationToAdmin({
        type: 'transfer_confirmation',
        title: confirmed ? '✅ Satıcı Devri Onayladı' : '⚠️ Satıcı Sorun Bildirdi',
        body: `"${sale.domain}" için @${realUsername} (satıcı) ${confirmed ? 'domaini devrettiğini onayladı.' : 'bir sorun bildirdi: ' + (note || 'detay belirtmedi')}`,
        domainName: sale.domain
      });

      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Devir Onayı İçin Hatırlatma Bildirimi Gönder ────────────────
  // ── Admin: Anlaşmazlığı Yanıtla / Çöz ───────────────────────────────────
  // Bir taraf "sorun var" dediğinde admin buradan cevap yazar; bu, ilgili
  // tarafın onay durumunu sıfırlayıp tekrar onaylayabilmesini sağlar.
  if (action === 'resolve_dispute') {
    const { saleId, role, message } = req.body; // role: 'buyer' | 'seller'
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!saleId || !role || !message) return res.status(400).json({ error: "Geçersiz parametre" });
    try {
      const db = getDb();
      const saleRef = db.collection('global_sales').doc(saleId);
      const saleSnap = await saleRef.get();
      if (!saleSnap.exists) return res.status(404).json({ error: "Satış kaydı bulunamadı" });
      const sale = saleSnap.data();
      const targetUsername = role === 'buyer' ? sale.user : sale.sellerUsername;
      if (!targetUsername) return res.status(400).json({ error: "Hedef kullanıcı bulunamadı" });

      const updateData = role === 'buyer'
        ? { buyerConfirmed: null, buyerConfirmNote: null, buyerDisputeResolution: message, buyerDisputeResolvedAt: Date.now() }
        : { sellerConfirmed: null, sellerConfirmNote: null, sellerDisputeResolution: message, sellerDisputeResolvedAt: Date.now() };
      await saleRef.set(updateData, { merge: true });
      if (sale.domain) {
        const domainUpdate = role === 'buyer'
          ? { buyerConfirmed: null, buyerDisputeResolution: message, buyerDisputeResolvedAt: Date.now() }
          : { sellerConfirmed: null, sellerDisputeResolution: message, sellerDisputeResolvedAt: Date.now() };
        await db.collection('domains').doc(sale.domain).set(domainUpdate, { merge: true });
      }

      await sendNotification(targetUsername, {
        type: 'dispute_response',
        title: '💬 Bildirdiğiniz Sorunla İlgili Yanıt',
        body: `"${sale.domain}" ile ilgili bildirdiğiniz soruna admin şu yanıtı verdi: "${message}". Devam etmek için lütfen "Panelim" içinden tekrar onay verin.`,
        domainName: sale.domain,
        role
      });

      await logAdminAction(await getRealUsername(accessToken), 'resolve_dispute', `${sale.domain} (${role}): ${message}`);

      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'nudge_confirmation') {
    const { saleId, role } = req.body; // role: 'buyer' | 'seller'
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!saleId || !role) return res.status(400).json({ error: "Geçersiz parametre" });
    try {
      const db = getDb();
      const saleRef = db.collection('global_sales').doc(saleId);
      const saleSnap = await saleRef.get();
      if (!saleSnap.exists) return res.status(404).json({ error: "Satış kaydı bulunamadı" });
      const sale = saleSnap.data();
      const targetUsername = role === 'buyer' ? sale.user : sale.sellerUsername;
      if (!targetUsername) return res.status(400).json({ error: "Hedef kullanıcı bulunamadı" });

      // Hatırlatma sayısını takip et — kullanıcı kendi onay ekranında
      // "admin size N kez hatırlattı" bilgisini görebilsin diye.
      const countField = role === 'buyer' ? 'buyerNudgeCount' : 'sellerNudgeCount';
      const newCount = (Number(sale[countField]) || 0) + 1;
      await saleRef.set({ [countField]: newCount }, { merge: true });
      if (sale.domain) {
        await db.collection('domains').doc(sale.domain).set({ [countField]: newCount }, { merge: true });
      }

      await sendNotification(targetUsername, {
        type: 'transfer_confirmation_reminder',
        title: '🔔 Onayınız Bekleniyor',
        body: role === 'buyer'
          ? `"${sale.domain}" domainini satıcıdan teslim aldınız mı? Ödemenin işleme alınabilmesi için lütfen "Panelim" içinden onaylayın.`
          : `"${sale.domain}" domainini alıcıya devrettiniz mi? Ödemenizin gönderilebilmesi için lütfen "Panelim" içinden onaylayın.`,
        domainName: sale.domain,
        role
      });

      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'release_seller_payment') {
    const { saleId } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!saleId) return res.status(400).json({ error: "saleId zorunludur" });

    try {
      const db = getDb();
      const saleRef = db.collection('global_sales').doc(saleId);
      const saleSnap = await saleRef.get();
      if (!saleSnap.exists) return res.status(404).json({ error: "Satış kaydı bulunamadı" });
      const sale = saleSnap.data();

      if (sale.payoutStatus === 'released')
        return res.status(400).json({ error: "Bu ödeme zaten satıcıya gönderilmiş." });
      if (!sale.sellerUsername)
        return res.status(400).json({ error: "Bu ilanın kayıtlı bir satıcısı yok, ödeme serbest bırakılamaz." });

      const sellerDoc = await db.collection('users').doc(sale.sellerUsername).get();
      const sellerUid = sellerDoc.exists ? sellerDoc.data().piUid : null;
      if (!sellerUid) {
        // Satıcıyı sessizce beklemek yerine, ödemesini alabilmesi için
        // tekrar giriş yapması gerektiğini otomatik olarak bildiriyoruz.
        await sendNotification(sale.sellerUsername, {
          type: 'payout_needs_login',
          title: '💰 Ödemenizi Almak İçin Giriş Yapın',
          body: `"${sale.domain}" domaininiz satıldı ve ödemeniz hazır! Ödemenin Pi hesabınıza gönderilebilmesi için lütfen uygulamaya bir kez daha Pi ile giriş yapın.`,
          domainName: sale.domain
        });
        return res.status(400).json({
          error: `@${sale.sellerUsername} henüz Pi hesabını uygulamaya bağlamamış (giriş yapmamış). Kendisine giriş yapması gerektiğine dair bildirim gönderildi. Ödeme, satıcı giriş yapana kadar sistem cüzdanında bekleyecek.`
        });
      }

      const pi = getPiClient();
      if (!pi) {
        return res.status(500).json({
          error: "Sunucuda escrow ödeme istemcisi yapılandırılmamış (PI_WALLET_PRIVATE_SEED / pi-backend paketi eksik). Lütfen ortam değişkenlerini kontrol edin."
        });
      }

      const payoutAmount = sale.payoutAmount || Math.round(sale.price * (1 - PLATFORM_COMMISSION_RATE) * 1e7) / 1e7;

      // ══════════════════════════════════════════════════════════════════
      //  KURTARMA (RESCUE/RECOVERY) MEKANİZMASI
      //  Her adım BAŞARILI OLDUĞU AN Firestore'a yazılır. Bir sonraki adım
      //  hata verirse (ağ kopması, sunucu zaman aşımı vb.), admin butona
      //  tekrar bastığında işlem SIFIRDAN değil, KALDIĞI YERDEN devam eder:
      //  - paymentId zaten varsa yeniden oluşturulmaz (çift ödeme riski yok)
      //  - txid zaten varsa yeniden gönderilmez
      //  Böylece Pi'ler asla "arada" kaybolmaz; en kötü ihtimalle 'failed'
      //  durumunda beklemeye devam eder ve aynı butonla güvenle tekrar denenir.
      // ══════════════════════════════════════════════════════════════════
      let paymentId = sale.payoutPaymentId || null;
      let txid = sale.payoutTxid || null;

      try {
        if (!paymentId) {
          paymentId = await pi.createPayment({
            amount: payoutAmount,
            memo: `Domain satışı: ${sale.domain} (komisyon sonrası)`,
            metadata: { saleId, domainName: sale.domain, type: 'seller_payout' },
            uid: sellerUid
          });
          await saleRef.set({ payoutStatus: 'processing', payoutPaymentId: paymentId }, { merge: true });
        }

        if (!txid) {
          txid = await pi.submitPayment(paymentId);
          await saleRef.set({ payoutTxid: txid }, { merge: true });
        }

        await pi.completePayment(paymentId, txid);

        await saleRef.set({
          payoutStatus: 'released',
          payoutAt: Date.now(),
          payoutTxid: txid,
          payoutPaymentId: paymentId,
          payoutReleasedBy: await getRealUsername(accessToken)
        }, { merge: true });

        // ── KALICI GELİR DEFTERİ ──────────────────────────────────────
        // %5 komisyon, tam olarak ödeme satıcıya serbest bırakıldığı bu anda
        // "kazanılmış" sayılır ve kalıcı bir belgeye eklenir — domain daha
        // sonra silinse bile bu rakam asla etkilenmez. (Admin'in kendi
        // domaini ise geliri zaten satın alma anında tam tutarla
        // kaydedilmişti, burada tekrar sayılmaz.)
        if (sale.sellerUsername && sale.sellerUsername !== ADMIN_USERNAME) {
          const commissionAmt = Math.round((sale.price - payoutAmount) * 1e7) / 1e7;
          await db.collection('config').doc('platform_stats').set({
            platformEarnings: FieldValue.increment(commissionAmt)
          }, { merge: true });
        }

        // Domain kaydını da güncelle: liste ekranında artık "Onay Aşamasında"
        // değil, kesin "SATILDI" olarak görünsün. Ödeme kesinleştiği için
        // domain otomatik olarak PASİFE ALINIR (hidden) — gerçek Pi el
        // değiştirdiğinden bu domain bir daha asla normal listede veya
        // "Tekrar Satılık Yap" ile ikinci kez satışa çıkarılamaz; sadece
        // admin'in "Pasife Alınmış" filtresinde görünür.
        if (sale.domain) {
          await db.collection('domains').doc(sale.domain).set({ payoutStatus: 'released', hidden: true }, { merge: true });
        }

        await sendNotification(sale.sellerUsername, {
          type: 'payout_released',
          title: '💸 Ödemeniz Gönderildi!',
          body: `"${sale.domain}" domain satışınıza ait ${payoutAmount} Pi (komisyon düşülmüş), Pi hesabınıza gönderildi.`,
          domainName: sale.domain, amount: payoutAmount
        });
        await sendTG(TG_CHAT_ID, `💸 *ÖDEME SERBEST BIRAKILDI*\n\n🌐 ${sale.domain}\n👤 @${sale.sellerUsername}\n💰 ${payoutAmount} Pi\n🔑 txid: ${txid}`);
        await logAdminAction(await getRealUsername(accessToken), 'release_seller_payment', `${sale.domain} → @${sale.sellerUsername}, ${payoutAmount} Pi`);

        return res.status(200).json({ success: true, txid, payoutAmount });
      } catch (stepError) {
        const detail = describePiApiError(stepError);
        // Hangi adımda kaldığını (paymentId/txid) kaydediyoruz ki bir sonraki
        // deneme sıfırdan başlamasın — Pi'ler güvende, sadece işlem yarım kaldı.
        await saleRef.set({
          payoutStatus: 'failed',
          payoutError: detail,
          payoutFailedAt: Date.now(),
          payoutPaymentId: paymentId || null,
          payoutTxid: txid || null
        }, { merge: true });
        return res.status(500).json({
          error: `Ödeme tamamlanamadı ama Pi'ler kaybolmadı, güvenli havuzda bekliyor: ${detail}. Aynı butona tekrar basarak kaldığı yerden devam ettirebilirsiniz.`
        });
      }
    } catch (e) {
      const detail = describePiApiError(e);
      console.error("release_seller_payment hatası:", e);
      try {
        await getDb().collection('global_sales').doc(saleId).set({ payoutStatus: 'failed', payoutError: detail, payoutFailedAt: Date.now() }, { merge: true });
      } catch (_) {}
      return res.status(500).json({ error: "Ödeme gönderilemedi: " + detail });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ADMIN: ESCROW — Ödemeyi Alıcıya İade Et
  //  Domain devrinde bir sorun varsa (satıcı devretmiyor, anlaşmazlık vb.),
  //  admin satıcıya ödeme göndermek yerine parayı doğrudan alıcıya iade
  //  edebilir. Aynı adım-adım kurtarma mantığı burada da geçerli.
  // ══════════════════════════════════════════════════════════════════════
  if (action === 'refund_buyer_payment') {
    const { saleId } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!saleId) return res.status(400).json({ error: "saleId zorunludur" });

    try {
      const db = getDb();
      const saleRef = db.collection('global_sales').doc(saleId);
      const saleSnap = await saleRef.get();
      if (!saleSnap.exists) return res.status(404).json({ error: "Satış kaydı bulunamadı" });
      const sale = saleSnap.data();

      if (sale.payoutStatus === 'released')
        return res.status(400).json({ error: "Bu ödeme zaten satıcıya gönderilmiş, artık iade edilemez." });
      if (sale.payoutStatus === 'refunded')
        return res.status(400).json({ error: "Bu ödeme zaten alıcıya iade edilmiş." });
      if (!sale.user)
        return res.status(400).json({ error: "Bu satışın kayıtlı bir alıcısı yok." });

      const buyerDoc = await db.collection('users').doc(sale.user).get();
      const buyerUid = buyerDoc.exists ? buyerDoc.data().piUid : null;
      if (!buyerUid) {
        await sendNotification(sale.user, {
          type: 'refund_needs_login',
          title: '💰 İadenizi Almak İçin Giriş Yapın',
          body: `"${sale.domain}" domaini için ödemeniz iade edilecek! İadenin Pi hesabınıza gönderilebilmesi için lütfen uygulamaya bir kez daha Pi ile giriş yapın.`,
          domainName: sale.domain
        });
        return res.status(400).json({
          error: `@${sale.user} henüz Pi hesabını uygulamaya bağlamamış (giriş yapmamış). Kendisine giriş yapması gerektiğine dair bildirim gönderildi. İade, alıcı giriş yapana kadar sistem cüzdanında bekleyecek.`
        });
      }

      const pi = getPiClient();
      if (!pi) {
        return res.status(500).json({
          error: "Sunucuda escrow ödeme istemcisi yapılandırılmamış (PI_WALLET_PRIVATE_SEED / pi-backend paketi eksik)."
        });
      }

      const refundAmount = sale.price;
      let paymentId = sale.refundPaymentId || null;
      let txid = sale.refundTxid || null;

      try {
        if (!paymentId) {
          paymentId = await pi.createPayment({
            amount: refundAmount,
            memo: `İade: ${sale.domain} (domain devri gerçekleşmedi)`,
            metadata: { saleId, domainName: sale.domain, type: 'buyer_refund' },
            uid: buyerUid
          });
          await saleRef.set({ payoutStatus: 'refund_processing', refundPaymentId: paymentId }, { merge: true });
        }

        if (!txid) {
          txid = await pi.submitPayment(paymentId);
          await saleRef.set({ refundTxid: txid }, { merge: true });
        }

        await pi.completePayment(paymentId, txid);

        await saleRef.set({
          payoutStatus: 'refunded',
          refundAt: Date.now(),
          refundTxid: txid,
          refundPaymentId: paymentId,
          refundIssuedBy: await getRealUsername(accessToken)
        }, { merge: true });

        // Domaini tekrar satışa aç (devir gerçekleşmediği için) ve alıcının
        // puanlarını/istatistiklerini geri al — ama satış kaydını (audit
        // izi için) SİLMİYORUZ, sadece 'refunded' olarak işaretliyoruz.
        if (sale.domain) {
          await db.collection('domains').doc(sale.domain).set({
            sold: false, buyer: null, at: null, txid: null, payoutStatus: null
          }, { merge: true });
          try { await updateUserPoints(sale.user, -sale.price, `refund_${sale.domain}`); } catch (_) {}
        }

        await sendNotification(sale.user, {
          type: 'refund_issued',
          title: '💸 Ödemeniz İade Edildi',
          body: `"${sale.domain}" domaini için ödediğiniz ${refundAmount} Pi, Pi hesabınıza iade edildi.`,
          domainName: sale.domain, amount: refundAmount
        });
        await sendTG(TG_CHAT_ID, `↩️ *ÖDEME İADE EDİLDİ*\n\n🌐 ${sale.domain}\n👤 @${sale.user}\n💰 ${refundAmount} Pi\n🔑 txid: ${txid}`);
        await logAdminAction(await getRealUsername(accessToken), 'refund_buyer', `${sale.domain} → @${sale.user}, ${refundAmount} Pi`);

        return res.status(200).json({ success: true, txid, refundAmount });
      } catch (stepError) {
        const detail = describePiApiError(stepError);
        await saleRef.set({
          payoutStatus: 'refund_failed',
          refundError: detail,
          refundFailedAt: Date.now(),
          refundPaymentId: paymentId || null,
          refundTxid: txid || null
        }, { merge: true });
        return res.status(500).json({
          error: `İade tamamlanamadı ama Pi'ler kaybolmadı, güvenli havuzda bekliyor: ${detail}. Aynı butona tekrar basarak kaldığı yerden devam ettirebilirsiniz.`
        });
      }
    } catch (e) {
      const detail = describePiApiError(e);
      console.error("refund_buyer_payment hatası:", e);
      return res.status(500).json({ error: "İade gönderilemedi: " + detail });
    }
  }

  // ── Admin: Ticket Durumunu Güncelle ────────────────────────────────────
  if (action === 'update_ticket_status') {
    const { ticketId, status } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    const validStatuses = ['new', 'reviewing', 'answered', 'resolved', 'closed'];
    if (!ticketId || !validStatuses.includes(status)) return res.status(400).json({ error: "Geçersiz parametre" });
    try {
      const db = getDb();
      const ticketRef = db.collection('tickets').doc(ticketId);
      const snap = await ticketRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Talep bulunamadı" });
      const data = snap.data();

      await ticketRef.update({ status, lastUpdate: Date.now() });

      const statusMsgs = {
        reviewing: { title: '🔍 Talebiniz İnceleniyor', body: `"${data.subject}" konulu talebiniz incelenmeye başlandı.` },
        answered: { title: '💬 Talebiniz Yanıtlandı', body: `"${data.subject}" konulu talebinize yanıt verildi.` },
        resolved: { title: '✅ Talep Çözüldü', body: `"${data.subject}" konulu talebiniz çözüldü.` },
        closed: { title: '📪 Talep Kapatıldı', body: `"${data.subject}" konulu talep kapatıldı.` }
      };
      const msg = statusMsgs[status];
      if (msg) await sendNotification(data.createdBy, { type: 'ticket_status_update', ...msg, ticketId, status });

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("update_ticket_status hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Ticket'a Yanıt Yaz ──────────────────────────────────────────
  if (action === 'admin_reply_ticket') {
    const { ticketId, text } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!ticketId || !text) return res.status(400).json({ error: "ticketId ve mesaj zorunludur" });
    try {
      const db = getDb();
      const ticketRef = db.collection('tickets').doc(ticketId);
      const snap = await ticketRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Talep bulunamadı" });
      const data = snap.data();

      const now = Date.now();
      await ticketRef.update({
        messages: FieldValue.arrayUnion({ from: 'admin', text, timestamp: now }),
        status: 'answered',
        lastUpdate: now
      });

      await sendNotification(data.createdBy, {
        type: 'ticket_admin_reply',
        title: '💬 Yöneticiden Yanıt',
        body: `"${data.subject}" talebinize yönetici yanıt verdi.`,
        ticketId
      });

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("admin_reply_ticket hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Ticket'ı Üzerine Al / Bırak ─────────────────────────────────
  if (action === 'assign_ticket') {
    const { ticketId, assign } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!ticketId) return res.status(400).json({ error: "ticketId zorunludur" });
    try {
      const db = getDb();
      const ticketRef = db.collection('tickets').doc(ticketId);
      const snap = await ticketRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Talep bulunamadı" });

      await ticketRef.update({ assignedTo: assign ? ADMIN_USERNAME : null, lastUpdate: Date.now() });
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("assign_ticket hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Ticket Sil (Kullanıcı kendi talebini / Admin herhangi bir talebi) ──
  if (action === 'delete_ticket') {
    const { ticketId } = req.body;
    if (!ticketId) return res.status(400).json({ error: "ticketId zorunludur" });

    const isAdmin = await verifyAdmin(accessToken);
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });

    try {
      const db = getDb();
      const ticketRef = db.collection('tickets').doc(ticketId);
      const snap = await ticketRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Talep bulunamadı" });
      const data = snap.data();

      // Sadece talebin sahibi ya da admin silebilir
      if (!isAdmin && data.createdBy !== realUsername) {
        return res.status(403).json({ error: "Bu talebi silme yetkiniz yok" });
      }

      await ticketRef.delete();

      // Admin başkasının talebini sildiyse kullanıcıya bilgi ver
      if (isAdmin && data.createdBy && data.createdBy !== realUsername) {
        await sendNotification(data.createdBy, {
          type: 'ticket_deleted',
          title: '🗑️ Destek Talebiniz Silindi',
          body: `"${data.subject}" konulu talebiniz yönetici tarafından silindi.`
        });
      }

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("delete_ticket hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kullanıcı Profili Getir ───────────────────────────────────────────
  // ── Favori Ekle/Çıkar ──────────────────────────────────────────────────
  // ── Satıcıyı Değerlendir (Puanlama) ────────────────────────────────────
  // Sadece: satış gerçekten release edilmiş (payoutStatus:'released'),
  // isteği yapan gerçekten o satışın alıcısı, ve daha önce bu satış için
  // puan verilmemiş olmalı. Domain doc'a buyerRating yazılır (tekrar
  // puanlamayı engeller) + satıcının user_profiles kaydında ratingSum/
  // ratingCount artırılır (ortalama puan buradan hesaplanır).
  // ── Alıcıyı Değerlendir (Satıcı → Alıcı Puanlaması) ────────────────────
  // submit_seller_rating'in aynası: sadece satış release edilmişse, isteği
  // yapan gerçekten o satışın satıcısıysa ve daha önce puanlanmamışsa.
  // Alıcının puanı domain doc'a sellerRatingOfBuyer olarak yazılır (buyerRating
  // ile karışmasın diye ayrı alan), buyer'ın user_profiles kaydında
  // buyerRatingSum/buyerRatingCount artırılır (satıcı puanından tamamen ayrı).
  if (action === 'submit_buyer_rating') {
    const { domainName, stars, comment } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    const starsNum = parseInt(stars, 10);
    if (!domainName || !Number.isInteger(starsNum) || starsNum < 1 || starsNum > 5)
      return res.status(400).json({ error: "Geçersiz puan" });
    const commentText = comment ? String(comment).trim().slice(0, 300) : null;
    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(domainName);
      const domainSnap = await domainRef.get();
      if (!domainSnap.exists) return res.status(404).json({ error: "Domain bulunamadı" });
      const data = domainSnap.data();
      if (data.sellerUsername !== realUsername) return res.status(403).json({ error: "Bu satışın satıcısı siz değilsiniz" });
      if (data.payoutStatus !== 'released') return res.status(400).json({ error: "Ödeme henüz serbest bırakılmadı, satış tamamlanmadan değerlendirme yapılamaz" });
      if (data.sellerRatingOfBuyer) return res.status(400).json({ error: "Bu satış için zaten bir değerlendirme yaptınız" });
      if (!data.buyer) return res.status(400).json({ error: "Bu satışın kayıtlı bir alıcısı yok" });

      const rating = { stars: starsNum, at: Date.now(), by: realUsername, comment: commentText };
      await domainRef.set({ sellerRatingOfBuyer: rating }, { merge: true });
      await db.collection('user_profiles').doc(data.buyer).set({
        buyerRatingSum: FieldValue.increment(starsNum),
        buyerRatingCount: FieldValue.increment(1)
      }, { merge: true });

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("submit_buyer_rating hatası:", e);
      await logSystemError('submit_buyer_rating', e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'submit_seller_rating') {
    const { domainName, stars, comment } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    const starsNum = parseInt(stars, 10);
    if (!domainName || !Number.isInteger(starsNum) || starsNum < 1 || starsNum > 5)
      return res.status(400).json({ error: "Geçersiz puan" });
    const commentText = comment ? String(comment).trim().slice(0, 300) : null;
    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(domainName);
      const domainSnap = await domainRef.get();
      if (!domainSnap.exists) return res.status(404).json({ error: "Domain bulunamadı" });
      const data = domainSnap.data();
      if (data.buyer !== realUsername) return res.status(403).json({ error: "Bu satışın alıcısı siz değilsiniz" });
      if (data.payoutStatus !== 'released') return res.status(400).json({ error: "Ödeme henüz serbest bırakılmadı, satış tamamlanmadan değerlendirme yapılamaz" });
      if (data.buyerRating) return res.status(400).json({ error: "Bu satış için zaten bir değerlendirme yaptınız" });
      if (!data.sellerUsername) return res.status(400).json({ error: "Bu satışın kayıtlı bir satıcısı yok" });

      const rating = { stars: starsNum, at: Date.now(), by: realUsername, comment: commentText };
      await domainRef.set({ buyerRating: rating }, { merge: true });
      await db.collection('user_profiles').doc(data.sellerUsername).set({
        ratingSum: FieldValue.increment(starsNum),
        ratingCount: FieldValue.increment(1)
      }, { merge: true });

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("submit_seller_rating hatası:", e);
      await logSystemError('submit_seller_rating', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Satıcının Ortalama Puanını + Son Yorumlarını Getir (herkese açık) ──
  if (action === 'get_seller_rating') {
    const { sellerUsername } = req.body;
    if (!sellerUsername) return res.status(400).json({ error: "Geçersiz kullanıcı adı" });
    try {
      const db = getDb();
      const snap = await db.collection('user_profiles').doc(sellerUsername).get();
      const d = snap.exists ? snap.data() : {};
      const count = d.ratingCount || 0;
      const avg = count > 0 ? Math.round((d.ratingSum / count) * 10) / 10 : null;

      // Yazılı yorumları toplamak için: bu satıcının sattığı domainleri
      // tara, buyerRating.comment dolu olanları en yeniden eskiye sırala.
      let recentReviews = [];
      try {
        const domSnap = await db.collection('domains').where('sellerUsername', '==', sellerUsername).limit(100).get();
        const withComments = [];
        domSnap.forEach(dd => {
          const br = dd.data().buyerRating;
          if (br && br.comment) withComments.push({ stars: br.stars, comment: br.comment, at: br.at, domain: dd.id });
        });
        withComments.sort((a, b) => b.at - a.at);
        recentReviews = withComments.slice(0, 5);
      } catch (_) { /* yorum toplama başarısız olsa da ana puan verisi dönsün */ }

      return res.status(200).json({ success: true, avg, count, recentReviews });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Alıcının Ortalama Puanını Getir ─────────────────────────────────────
  if (action === 'get_buyer_rating') {
    const { buyerUsername } = req.body;
    if (!buyerUsername) return res.status(400).json({ error: "Geçersiz kullanıcı adı" });
    try {
      const db = getDb();
      const snap = await db.collection('user_profiles').doc(buyerUsername).get();
      const d = snap.exists ? snap.data() : {};
      const count = d.buyerRatingCount || 0;
      const avg = count > 0 ? Math.round((d.buyerRatingSum / count) * 10) / 10 : null;
      return res.status(200).json({ success: true, avg, count });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Pazarlık / Teklif Sistemi ───────────────────────────────────────────
  // Bir domain için sabit fiyat dışında, alıcı bir teklif sunabiliyor.
  // Satıcı (ya da admin) kabul ederse domain fiyatı teklif tutarına
  // güncellenir ve alıcı normal satın alma akışıyla tamamlayabilir.
  if (action === 'submit_offer') {
    const { domainName, offerPrice, message } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!await checkRateLimit(clientIp, 'submit_offer', 10, 60000))
      return res.status(429).json({ error: "Çok fazla teklif gönderdiniz, lütfen biraz bekleyin." });
    const priceNum = Number(offerPrice);
    if (!domainName || !Number.isFinite(priceNum) || priceNum <= 0)
      return res.status(400).json({ error: "Geçersiz teklif tutarı" });
    try {
      const db = getDb();
      await revertExpiredReservation(db, domainName);
      const domainSnap = await db.collection('domains').doc(domainName).get();
      if (!domainSnap.exists) return res.status(404).json({ error: "Domain bulunamadı" });
      const data = domainSnap.data();
      if (data.sold === true) return res.status(400).json({ error: "Bu domain zaten satılmış" });
      if (data.deleted === true || data.hidden === true) return res.status(400).json({ error: "Bu domain artık satışta değil" });
      if (data.sellerUsername === realUsername) return res.status(400).json({ error: "Kendi domaininize teklif veremezsiniz" });

      const offerRef = db.collection('offers').doc();
      await offerRef.set({
        domainName,
        buyerUsername: realUsername,
        sellerUsername: data.sellerUsername || null,
        originalPrice: data.price,
        offerPrice: priceNum,
        message: message ? String(message).trim().slice(0, 300) : null,
        status: 'pending',
        createdAt: Date.now()
      });

      const notifyTarget = data.sellerUsername || ADMIN_USERNAME;
      await sendNotification(notifyTarget, {
        type: 'offer_received',
        role: 'seller',
        title: '💬 Yeni Teklif Aldınız',
        body: `@${realUsername}, "${domainName}" için ${priceNum} Pi teklif etti (liste fiyatı: ${data.price} Pi).`,
        domainName
      });
      if (notifyTarget === ADMIN_USERNAME) {
        await sendTG(TG_CHAT_ID, `💬 *YENİ TEKLİF*\n\n🌐 ${domainName}\n👤 @${realUsername}\n💰 Teklif: ${priceNum} Pi (liste: ${data.price} Pi)`);
      }

      return res.status(200).json({ success: true, offerId: offerRef.id });
    } catch (e) {
      console.error("submit_offer hatası:", e);
      await logSystemError('submit_offer', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kendi Verdiğim Teklifleri Getir (alıcı) ─────────────────────────────
  if (action === 'get_my_offers') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const snap = await db.collection('offers').where('buyerUsername', '==', realUsername).get();
      const offers = [];
      snap.forEach(d => offers.push({ id: d.id, ...d.data() }));
      offers.sort((a, b) => b.createdAt - a.createdAt);
      return res.status(200).json({ success: true, offers });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Domainlerime Gelen Teklifleri Getir (satıcı) ────────────────────────
  if (action === 'get_received_offers') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      // 'countered': satıcının kendi verdiği karşı teklifi de burada
      // göstermeye devam ediyoruz ki alıcının yanıtını bekleyen teklif
      // listeden kaybolmasın (aksi halde satıcı ne olduğunu takip edemez).
      let offers = [];
      try {
        const snap = await db.collection('offers').where('sellerUsername', '==', realUsername).where('status', 'in', ['pending', 'countered']).get();
        snap.forEach(d => offers.push({ id: d.id, ...d.data() }));
      } catch (idxErr) {
        // Firestore bu birleşik sorgu için composite index isteyebilir;
        // index henüz oluşturulmamışsa uygulamanın çökmemesi için daha
        // basit bir sorguya (sadece sellerUsername) düşüp filtreyi
        // JS tarafında yapıyoruz.
        console.error('[get_received_offers] composite index hatası, fallback kullanılıyor:', idxErr.message);
        const snap = await db.collection('offers').where('sellerUsername', '==', realUsername).get();
        snap.forEach(d => { const data = d.data(); if (data.status === 'pending' || data.status === 'countered') offers.push({ id: d.id, ...data }); });
      }
      offers.sort((a, b) => b.createdAt - a.createdAt);
      return res.status(200).json({ success: true, offers });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Teklife Yanıt Ver (Kabul/Reddet) ────────────────────────────────────
  if (action === 'respond_offer') {
    const { offerId, accept } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!offerId) return res.status(400).json({ error: "Geçersiz teklif" });
    try {
      const db = getDb();
      const offerRef = db.collection('offers').doc(offerId);
      const offerSnap = await offerRef.get();
      if (!offerSnap.exists) return res.status(404).json({ error: "Teklif bulunamadı" });
      const offer = offerSnap.data();
      const isAdmin = await verifyAdmin(accessToken);
      if (offer.sellerUsername !== realUsername && !isAdmin)
        return res.status(403).json({ error: "Bu teklife yanıt verme yetkiniz yok" });
      if (offer.status !== 'pending') return res.status(400).json({ error: "Bu teklif zaten yanıtlanmış" });

      if (accept) {
        const domainRef = db.collection('domains').doc(offer.domainName);
        const domainSnap = await domainRef.get();
        if (!domainSnap.exists || domainSnap.data().sold === true)
          return res.status(400).json({ error: "Domain artık müsait değil" });

        const reservedUntil = Date.now() + OFFER_RESERVATION_MS;
        const preNegotiationPrice = domainSnap.data().price;
        await domainRef.set({ price: offer.offerPrice, reservedFor: offer.buyerUsername, reservedUntil, preNegotiationPrice }, { merge: true });
        await offerRef.set({ status: 'accepted', respondedAt: Date.now() }, { merge: true });

        // Aynı domain için bekleyen diğer teklifler artık geçersiz — fiyat değişti
        const otherPending = await db.collection('offers')
          .where('domainName', '==', offer.domainName).where('status', '==', 'pending').get();
        const batch = db.batch();
        otherPending.forEach(d => { if (d.id !== offerId) batch.set(d.ref, { status: 'expired', respondedAt: Date.now() }, { merge: true }); });
        await batch.commit();

        const minutes = Math.round(OFFER_RESERVATION_MS / 60000);
        await sendNotification(offer.buyerUsername, {
          type: 'offer_accepted',
          role: 'buyer',
          title: '✅ Teklifiniz Kabul Edildi!',
          body: `"${offer.domainName}" için ${offer.offerPrice} Pi teklifiniz kabul edildi. Bu domaini ${minutes} dakika boyunca SADECE siz satın alabilirsiniz — süre dolarsa herkese açılır.`,
          domainName: offer.domainName
        });
      } else {
        await offerRef.set({ status: 'rejected', respondedAt: Date.now() }, { merge: true });
        await sendNotification(offer.buyerUsername, {
          type: 'offer_rejected',
          role: 'buyer',
          title: '❌ Teklifiniz Reddedildi',
          body: `"${offer.domainName}" için ${offer.offerPrice} Pi teklifiniz satıcı tarafından reddedildi.`,
          domainName: offer.domainName
        });
      }

      await logAdminAction(realUsername, 'respond_offer', `${offer.domainName}: @${offer.buyerUsername}'in ${offer.offerPrice} Pi teklifi ${accept ? 'kabul edildi' : 'reddedildi'}`);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("respond_offer hatası:", e);
      await logSystemError('respond_offer', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kendi Teklifimi Geri Çek ────────────────────────────────────────────
  if (action === 'withdraw_offer') {
    const { offerId } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const offerRef = db.collection('offers').doc(offerId);
      const offerSnap = await offerRef.get();
      if (!offerSnap.exists) return res.status(404).json({ error: "Teklif bulunamadı" });
      const offer = offerSnap.data();
      if (offer.buyerUsername !== realUsername) return res.status(403).json({ error: "Bu teklif size ait değil" });
      if (offer.status !== 'pending') return res.status(400).json({ error: "Sadece bekleyen teklifler geri çekilebilir" });
      await offerRef.set({ status: 'withdrawn', respondedAt: Date.now() }, { merge: true });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Karşı Teklif Ver (satıcı) ───────────────────────────────────────────
  // Satıcı, gelen bir teklifi doğrudan kabul/reddetmek yerine farklı bir
  // fiyat önerebilir. Teklif 'countered' durumuna geçer, orijinal teklif
  // tutarı korunur (offerPrice) ama ayrıca counterPrice/counterMessage
  // alanları eklenir. Alıcı bunu respond_counter_offer ile yanıtlar.
  if (action === 'counter_offer') {
    const { offerId, counterPrice, counterMessage } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    const priceNum = Number(counterPrice);
    if (!offerId || !Number.isFinite(priceNum) || priceNum <= 0)
      return res.status(400).json({ error: "Geçersiz karşı teklif tutarı" });
    try {
      const db = getDb();
      const offerRef = db.collection('offers').doc(offerId);
      const offerSnap = await offerRef.get();
      if (!offerSnap.exists) return res.status(404).json({ error: "Teklif bulunamadı" });
      const offer = offerSnap.data();
      const isAdmin = await verifyAdmin(accessToken);
      if (offer.sellerUsername !== realUsername && !isAdmin)
        return res.status(403).json({ error: "Bu teklife yanıt verme yetkiniz yok" });
      if (offer.status !== 'pending') return res.status(400).json({ error: "Bu teklif zaten yanıtlanmış" });

      await offerRef.set({
        status: 'countered',
        counterPrice: priceNum,
        counterMessage: counterMessage ? String(counterMessage).trim().slice(0, 300) : null,
        counteredAt: Date.now()
      }, { merge: true });

      await sendNotification(offer.buyerUsername, {
        type: 'offer_countered',
        role: 'buyer',
        title: '🔄 Karşı Teklif Aldınız',
        body: `"${offer.domainName}" için satıcı ${priceNum} Pi karşı teklif sundu (sizin teklifiniz: ${offer.offerPrice} Pi).`,
        domainName: offer.domainName
      });
      await logAdminAction(realUsername, 'counter_offer', `${offer.domainName}: @${offer.buyerUsername}'in ${offer.offerPrice} Pi teklifine ${priceNum} Pi karşı teklif verildi`);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("counter_offer hatası:", e);
      await logSystemError('counter_offer', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Karşı Teklife Yanıt Ver (alıcı) ─────────────────────────────────────
  if (action === 'respond_counter_offer') {
    const { offerId, accept } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!offerId) return res.status(400).json({ error: "Geçersiz teklif" });
    try {
      const db = getDb();
      const offerRef = db.collection('offers').doc(offerId);
      const offerSnap = await offerRef.get();
      if (!offerSnap.exists) return res.status(404).json({ error: "Teklif bulunamadı" });
      const offer = offerSnap.data();
      if (offer.buyerUsername !== realUsername) return res.status(403).json({ error: "Bu teklif size ait değil" });
      if (offer.status !== 'countered') return res.status(400).json({ error: "Bu teklif için bekleyen bir karşı teklif yok" });

      if (accept) {
        const domainRef = db.collection('domains').doc(offer.domainName);
        const domainSnap = await domainRef.get();
        if (!domainSnap.exists || domainSnap.data().sold === true)
          return res.status(400).json({ error: "Domain artık müsait değil" });

        const reservedUntil = Date.now() + OFFER_RESERVATION_MS;
        const preNegotiationPrice = domainSnap.data().price;
        await domainRef.set({ price: offer.counterPrice, reservedFor: realUsername, reservedUntil, preNegotiationPrice }, { merge: true });
        await offerRef.set({ status: 'accepted', respondedAt: Date.now() }, { merge: true });

        const otherPending = await db.collection('offers')
          .where('domainName', '==', offer.domainName).where('status', '==', 'pending').get();
        const batch = db.batch();
        otherPending.forEach(d => { if (d.id !== offerId) batch.set(d.ref, { status: 'expired', respondedAt: Date.now() }, { merge: true }); });
        await batch.commit();

        const minutes = Math.round(OFFER_RESERVATION_MS / 60000);
        await sendNotification(offer.sellerUsername || ADMIN_USERNAME, {
          type: 'counter_offer_accepted',
          role: 'seller',
          title: '✅ Karşı Teklifiniz Kabul Edildi!',
          body: `"${offer.domainName}" için ${offer.counterPrice} Pi karşı teklifiniz @${realUsername} tarafından kabul edildi. Alıcıya ${minutes} dakikalık öncelikli satın alma süresi tanındı.`,
          domainName: offer.domainName
        });
      } else {
        await offerRef.set({ status: 'rejected', respondedAt: Date.now() }, { merge: true });
        await sendNotification(offer.sellerUsername || ADMIN_USERNAME, {
          type: 'counter_offer_rejected',
          role: 'seller',
          title: '❌ Karşı Teklifiniz Reddedildi',
          body: `"${offer.domainName}" için ${offer.counterPrice} Pi karşı teklifiniz @${realUsername} tarafından reddedildi.`,
          domainName: offer.domainName
        });
      }
      await logAdminAction(realUsername, 'respond_counter_offer', `${offer.domainName}: ${offer.counterPrice} Pi karşı teklif ${accept ? 'kabul edildi' : 'reddedildi'}`);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("respond_counter_offer hatası:", e);
      await logSystemError('respond_counter_offer', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Tüm Teklif Trafiğini Getir (SADECE admin) ───────────────────────────
  if (action === 'get_all_offers') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      // Platform büyüdükçe bu koleksiyon da büyüyecek; admin izleme paneli
      // için en son 500 kayıt yeterli — daha fazlası pratikte okunamaz zaten.
      const snap = await db.collection('offers').orderBy('createdAt', 'desc').limit(500).get();
      const offers = [];
      snap.forEach(d => offers.push({ id: d.id, ...d.data() }));
      return res.status(200).json({ success: true, offers });
    } catch (e) {
      console.error("get_all_offers hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Teklifler Sekmesi Rozeti İçin Hafif Sayaç ───────────────────────────
  // Admin panelindeki "Teklifler" başlığında yeni/bekleyen teklif olduğunu
  // gösteren küçük bir bildirim rozeti için — get_all_offers gibi 500
  // kaydın tamamını çekmek yerine sadece 'pending' sayısını döner.
  if (action === 'get_pending_offers_count') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const snap = await db.collection('offers').where('status', '==', 'pending').get();
      return res.status(200).json({ success: true, count: snap.size });
    } catch (e) {
      console.error("get_pending_offers_count hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Süresi Dolmuş Rezervasyonu Anında Tetikle (herhangi bir ziyaretçi) ──
  // "İlk kim domaine bakarsa o an kontrol edilsin" isteği için: frontend,
  // bir domain kartında süresi geçmiş ama henüz temizlenmemiş bir rezervasyon
  // fark ettiğinde bu action'ı çağırır. Giriş yapmamış ziyaretçiler de
  // tetikleyebilsin diye kimlik doğrulaması istemiyoruz — zararsız, idempotent
  // bir "kendi kendini düzeltme" işlemi olduğu için güvenli. Kötüye kullanımı
  // önlemek için IP bazlı rate limit var.
  if (action === 'check_expired_reservation') {
    const { domainName } = req.body;
    if (!domainName) return res.status(400).json({ error: "domainName zorunlu" });
    if (!await checkRateLimit(clientIp, 'check_expired_reservation', 20, 60000))
      return res.status(429).json({ error: "Çok fazla istek" });
    try {
      const db = getDb();
      await revertExpiredReservation(db, domainName);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("check_expired_reservation hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Hesap/Veri Silme Talebi (KVKK/GDPR) ─────────────────────────────────
  // NOT: Burada otomatik/anlık veri silme YAPILMIYOR — kasıtlı bir tasarım
  // tercihi. Çünkü tamamlanmış satışlar/ödemeler muhasebe ve olası
  // anlaşmazlık kayıtları için saklanması gerekebilecek finansal kayıtlar;
  // körü körüne otomatik silme bu kayıtları da yok ederek başka
  // yükümlülükleri ihlal edebilir. Bunun yerine: talep kayıt altına alınır,
  // admin'e bildirilir, admin inceleyip (gerekirse kişisel veriyi
  // anonimleştirerek) manuel olarak sonuçlandırır.
  if (action === 'request_account_deletion') {
    const { reason } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const existing = await db.collection('account_deletion_requests')
        .where('username', '==', realUsername).where('status', '==', 'pending').get();
      if (!existing.empty) return res.status(400).json({ error: "Zaten bekleyen bir talebiniz var." });

      const reqRef = db.collection('account_deletion_requests').doc();
      await reqRef.set({
        username: realUsername,
        reason: reason ? String(reason).trim().slice(0, 500) : null,
        status: 'pending',
        createdAt: Date.now()
      });

      await sendTG(TG_CHAT_ID, `🗑️ *HESAP SİLME TALEBİ*\n\n👤 @${realUsername}${reason ? `\n📝 ${reason}` : ''}\n\nAdmin panelinden inceleyip sonuçlandırın.`);

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("request_account_deletion hatası:", e);
      await logSystemError('request_account_deletion', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kendi Silme Talebimin Durumunu Gör ──────────────────────────────────
  if (action === 'get_my_deletion_request') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const snap = await db.collection('account_deletion_requests')
        .where('username', '==', realUsername).orderBy('createdAt', 'desc').limit(1).get();
      if (snap.empty) return res.status(200).json({ success: true, request: null });
      const doc = snap.docs[0];
      return res.status(200).json({ success: true, request: { id: doc.id, ...doc.data() } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Bekleyen Silme Taleplerini Getir ─────────────────────────────
  if (action === 'get_deletion_requests') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const snap = await db.collection('account_deletion_requests').where('status', '==', 'pending').get();
      const requests = [];
      snap.forEach(d => requests.push({ id: d.id, ...d.data() }));
      requests.sort((a, b) => a.createdAt - b.createdAt);
      return res.status(200).json({ success: true, requests });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Silme Talebini Sonuçlandır ────────────────────────────────────
  if (action === 'resolve_deletion_request') {
    const { requestId, note } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!requestId) return res.status(400).json({ error: "Geçersiz talep" });
    try {
      const db = getDb();
      const reqRef = db.collection('account_deletion_requests').doc(requestId);
      await reqRef.set({
        status: 'resolved',
        resolvedAt: Date.now(),
        resolvedBy: await getRealUsername(accessToken),
        resolutionNote: note ? String(note).trim().slice(0, 500) : null
      }, { merge: true });
      await logAdminAction(await getRealUsername(accessToken), 'resolve_deletion_request', requestId);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'toggle_favorite') {
    const { domainName, addFavorite } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!domainName) return res.status(400).json({ error: "Geçersiz domain adı" });
    try {
      const db = getDb();
      const ref = db.collection('user_profiles').doc(realUsername);
      await ref.set({
        favorites: addFavorite ? FieldValue.arrayUnion(domainName) : FieldValue.arrayRemove(domainName)
      }, { merge: true });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'get_user_profile') {
    // YENİ: Girişten hemen sonra çağrılan bu endpoint'e de rate limit
    // eklendi — token deneme/kaba kuvvet saldırılarına karşı ek koruma.
    if (!await checkRateLimit(clientIp, 'get_user_profile', 20, 60000))
      return res.status(429).json({ error: "Çok fazla istek. Lütfen biraz bekleyin." });
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const profileSnap = await db.collection('user_profiles').doc(realUsername).get();
      const profileData = profileSnap.exists ? profileSnap.data() : { points: 0, badge: null };
      if (!profileData.favorites) profileData.favorites = [];

      const salesSnap = await db.collection('global_sales').where('user', '==', realUsername).get();
      let totalSpent = 0;
      const purchases = [];
      salesSnap.forEach(d => {
        const data = d.data();
        purchases.push({ id: d.id, ...data });
        totalSpent += Number(data.price || 0);
      });

      const sellReqSnap = await db.collection('sell_requests').where('submittedBy', '==', realUsername).get();
      const sellRequests = [];
      const allDomainNamesInRequests = new Set();
      sellReqSnap.forEach(d => {
        const data = d.data();
        allDomainNamesInRequests.add(data.domainName);
        sellRequests.push({ id: d.id, ...data });
      });

      let deletedDomainNames = new Set();
      if (allDomainNamesInRequests.size > 0) {
        const domainDocs = await Promise.all(
          Array.from(allDomainNamesInRequests).map(name => db.collection('domains').doc(name).get())
        );
        domainDocs.forEach(snap => {
          if (snap.exists && snap.data().deleted === true) deletedDomainNames.add(snap.id);
        });
      }
      const visibleSellRequests = sellRequests.filter(r => !deletedDomainNames.has(r.domainName));

      const domainsSnap = await db.collection('domains')
        .where('sellerUsername', '==', realUsername)
        .where('sold', '==', true)
        .get();
      let totalEarned = 0;
      const soldDomains = [];
      domainsSnap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        totalEarned += Number(data.price || 0);
        soldDomains.push({ name: d.id, ...data });
      });

      const activeListingsSnap = await db.collection('domains')
        .where('sellerUsername', '==', realUsername)
        .where('sold', '==', false)
        .get();
      const activeListings = [];
      activeListingsSnap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        activeListings.push({ name: d.id, ...data });
      });

      return res.status(200).json({
        success: true,
        profile: profileData,
        purchases,
        sellRequests: visibleSellRequests,
        soldDomains,
        activeListings,
        totalSpent,
        totalEarned
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Toplam Kazanç / Cüzdan Özeti ────────────────────────────────
  // ── Satış Trendi (Son 30 Gün) ──────────────────────────────────────────
  if (action === 'get_sales_trend') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 24 * 3600 * 1000;
      const snap = await db.collection('domains').where('sold', '==', true).get();
      // Firestore'da tarih alanına göre range filtresi + eşitlik filtresi
      // aynı anda index gerektirebileceğinden, güvenli tarafta kalmak için
      // client tarafta (burada, sunucu kodunda) filtreliyoruz.
      const byDay = {};
      for (let i = 0; i < 30; i++) {
        const d = new Date(now - i * 24 * 3600 * 1000);
        const key = d.toISOString().slice(0, 10);
        byDay[key] = { date: key, count: 0, volume: 0 };
      }
      snap.forEach(d => {
        const data = d.data();
        if (data.deleted === true || !data.at || data.at < thirtyDaysAgo) return;
        const key = new Date(data.at).toISOString().slice(0, 10);
        if (byDay[key]) { byDay[key].count++; byDay[key].volume += Number(data.price || 0); }
      });
      const trend = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
      return res.status(200).json({ success: true, trend });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Satış Verisini Dışa Aktarım İçin Getir (CSV, admin'in tarayıcısında oluşturulur) ─
  if (action === 'export_sales_data') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const snap = await db.collection('domains').where('sold', '==', true).get();
      const rows = [];
      snap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        rows.push({
          domain: d.id,
          price: data.price || 0,
          buyer: data.buyer || '',
          sellerUsername: data.sellerUsername || '',
          at: data.at ? new Date(data.at).toISOString() : '',
          txid: data.txid || '',
          payoutStatus: data.payoutStatus || '',
          type: data.type || ''
        });
      });
      rows.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
      await logAdminAction(await getRealUsername(accessToken), 'export_sales_data', `${rows.length} satır`);
      return res.status(200).json({ success: true, rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'get_admin_earnings') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();

      const allDomainsSnap = await db.collection('domains').get();

      const salesByDomain = {};
      const adminOwnSoldDomains = [];
      const allSalesDetail = [];

      // Bu döngü artık KÜMÜLATİF kazanç toplamlarını hesaplamıyor (o kalıcı
      // deftere taşındı) — sadece hâlâ var olan/silinmemiş satışların anlık
      // bir listesini (Satış İstatistikleri sekmesi için) oluşturuyor.
      allDomainsSnap.forEach(d => {
        const data = d.data();
        const price = Number(data.price || 0);

        if (data.deleted === true || data.sold !== true) return;

        salesByDomain[d.id] = (salesByDomain[d.id] || 0) + price;

        allSalesDetail.push({
          name: d.id,
          price: data.price,
          buyer: data.buyer || null,
          at: data.at || null,
          sellerUsername: data.sellerUsername || null,
          type: data.type || 'genel'
        });

        if (!data.sellerUsername || data.sellerUsername === ADMIN_USERNAME) {
          adminOwnSoldDomains.push({
            name: d.id,
            price: data.price,
            buyer: data.buyer || null
          });
        }
      });

      // ── KALICI GELİR DEFTERİ ────────────────────────────────────────────
      // İlk kez okunuyorsa (belge hiç yoksa), MEVCUT durumu eski (canlı
      // tarama) yöntemiyle bir kereliğine hesaplayıp kalıcı belgeye yazıyoruz
      // — böylece o ana kadar zaten kazanılmış gerçek gelir kaybolmuyor.
      // Sonraki her satış/ödeme serbest bırakma bu belgeyi artırarak devam
      // eder ve domain silinse bile bu toplamlar bir daha asla değişmez.
      const statsRef = db.collection('config').doc('platform_stats');
      const statsSnap = await statsRef.get();
      let totalVolume, userOwnedVolume, platformEarnings, adminOwnEarnings;

      // FIX: statsVersion:2 öncesi oluşturulmuş kayıtlar, ödeme durumu
      // kontrolü olmayan eski (hatalı) formülle hesaplanmış olabilir. Böyle
      // bir kayıt bulunursa, bu istekte SESSİZCE ve BİR KEREYE MAHSUS doğru
      // formülle yeniden hesaplanıp üzerine yazılır — elle müdahale gerekmez.
      const needsRecalc = !statsSnap.exists || statsSnap.data().statsVersion !== 2;

      if (statsSnap.exists && !needsRecalc) {
        const s = statsSnap.data();
        totalVolume = Number(s.totalVolume || 0);
        userOwnedVolume = Number(s.userOwnedVolume || 0);
        platformEarnings = Number(s.platformEarnings || 0);
        adminOwnEarnings = Number(s.adminOwnEarnings || 0);
      } else {
        totalVolume = 0; userOwnedVolume = 0; adminOwnEarnings = 0; platformEarnings = 0;
        allDomainsSnap.forEach(d => {
          const data = d.data();
          const price = Number(data.price || 0);
          if (data.deleted === true || data.sold !== true) return;
          totalVolume += price;
          if (data.sellerUsername) {
            userOwnedVolume += price;
            if (data.sellerUsername === ADMIN_USERNAME) {
              // Admin'in kendi domaini: escrow/serbest bırakma adımı yok,
              // satış anında kesinleşmiş sayılır.
              adminOwnEarnings += price;
            } else if (data.payoutStatus === 'released') {
              // FIX: %5 komisyon SADECE ödeme satıcıya gerçekten serbest
              // bırakılmışsa (payoutStatus:'released') kazanılmış sayılır.
              // Önceden bu kontrol yoktu; havuzda bekleyen (henüz ödenmemiş)
              // satışlar da komisyon olarak sayılıp toplamı şişiriyordu.
              const releasedPayout = Number(data.payoutAmount || Math.round(price * (1 - PLATFORM_COMMISSION_RATE) * 1e7) / 1e7);
              platformEarnings += (price - releasedPayout);
            }
          } else {
            adminOwnEarnings += price;
          }
        });
        platformEarnings = Math.round(platformEarnings * 1e7) / 1e7;
        await statsRef.set({ totalVolume, userOwnedVolume, platformEarnings, adminOwnEarnings, statsVersion: 2, backfilledAt: Date.now() });
        console.log('[platform_stats] Hesaplandı/düzeltildi (statsVersion 2):', { totalVolume, userOwnedVolume, platformEarnings, adminOwnEarnings });
      }

      allSalesDetail.sort((a, b) => (b.at || 0) - (a.at || 0));

      return res.status(200).json({
        success: true,
        totalVolume,
        userOwnedVolume,
        platformEarnings,
        adminOwnEarnings,
        adminOwnSoldDomains,
        allSalesDetail,
        salesByDomain
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Onaya Gelen Domain Detayı (Admin) ──────────────────────────────────
  if (action === 'get_sell_request_detail') {
    const { requestId } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!requestId) return res.status(400).json({ error: "Geçersiz istek ID" });
    try {
      const db = getDb();
      const snap = await db.collection('sell_requests').doc(requestId).get();
      if (!snap.exists) return res.status(404).json({ error: "Öneri bulunamadı" });
      return res.status(200).json({ success: true, detail: { id: snap.id, ...snap.data() } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Pi Ödeme Akışı (approve / complete / cancel)
  // ══════════════════════════════════════════════════════════════════════
  const { paymentId, txid, username, domainName } = req.body;

  if (!paymentId) return res.status(400).json({ error: "paymentId zorunludur" });

  const allowedActions = ['approve', 'complete', 'cancel'];
  if (!allowedActions.includes(action)) return res.status(400).json({ error: "Geçersiz action" });

  // YENİ: Ödeme akışı (satın alma) için rate limiting eklendi — daha önce
  // hiç yoktu, bu da otomatikleştirilmiş kötüye kullanıma (bot ile ardı
  // ardına sahte ödeme denemesi) açık bırakıyordu.
  if (!await checkRateLimit(clientIp, 'payment_action', 20, 60000))
    return res.status(429).json({ error: "Çok fazla ödeme isteği. Lütfen biraz bekleyip tekrar deneyin." });

  if (action === 'cancel') {
    if (domainName && !username) {
      return res.status(400).json({ error: "cancel işlemi için username gerekli" });
    }
  }

  // YENİ (yarış durumu sertleştirmesi — kısım 1/2): 'approve' adımında,
  // kullanıcı Pi cüzdanından ödemeyi imzalamadan ÖNCE domain hâlâ müsait mi
  // diye erkenden bakıyoruz. Bu, iki kişinin aynı domaine neredeyse aynı
  // anda "Satın Al" bastığı durumda birinin daha en baştan (parasını hiç
  // göndermeden) net bir hata almasını sağlar — yarış penceresini önemli
  // ölçüde daraltır. (Asıl kesin koruma 'complete' adımındaki transaction'da;
  // bu sadece erken/ucuz bir ön-kontrol, %100 garanti değil çünkü blockchain
  // işlemi kullanıcı tarafında gerçekleşiyor.)
  if (action === 'approve' && domainName) {
    try {
      const db = getDb();
      await revertExpiredReservation(db, domainName);
      const domainSnap = await db.collection('domains').doc(domainName).get();
      if (domainSnap.exists) {
        const dData = domainSnap.data();
        if (dData.sold === true) {
          return res.status(409).json({ error: "Bu domain az önce başka biri tarafından satın alındı." });
        }
        // Anlaşılan teklif sonrası öncelik penceresi: bu süre boyunca domain
        // SADECE anlaşan alıcıya satılabilir, başkası denerse engellenir.
        if (dData.reservedFor && dData.reservedUntil && dData.reservedUntil > Date.now()) {
          const buyerUsername = await getRealUsername(accessToken);
          if (buyerUsername !== dData.reservedFor) {
            const minutesLeft = Math.ceil((dData.reservedUntil - Date.now()) / 60000);
            return res.status(409).json({ error: `Bu domain şu anda anlaşma sağlanan bir alıcı için ayrılmış. ${minutesLeft} dakika sonra herkese açılacak.`, reserved: true, reservedUntil: dData.reservedUntil });
          }
        }
      }
    } catch (e) {
      console.error("approve ön-kontrol hatası:", e);
      // Kontrol başarısız olursa akışı durdurmuyoruz (Pi API zaten kendi
      // içinde onaylayacak) — sadece erken uyarı bir bonus, engel değil.
    }
  }

  const PI_API_KEY = process.env.APP_SECRET;
  const body = action === 'complete' ? { txid } : {};
  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    let data;
    try { data = await response.json(); } catch (e) { data = {}; }

    if (!response.ok) {
      console.error("Pi API hatası:", action, paymentId, data);
      return res.status(response.status).json({ error: "Pi API hatası", details: data });
    }

    if (action === 'complete' && domainName && username) {
      let purchaseCode = null;
      let raceLost = false;
      try {
        const db = getDb();
        const domainRef = db.collection('domains').doc(domainName);

        // Transaction'a girmeden önce süresi dolmuş bir rezervasyon varsa
        // geri alıyoruz — böylece aşağıdaki transaction, güncel/doğru
        // reservedFor durumuna bakar.
        await revertExpiredReservation(db, domainName);

        // YENİ (yarış durumu sertleştirmesi — ASIL KORUMA): Öncesinde burada
        // "oku, kontrol et, sonra yaz" ayrı ayrı adımlardı — iki ödeme
        // neredeyse aynı anda 'complete' olursa (ikisi de gerçek Pi
        // blockchain'inde zaten tamamlanmıştı), ikisi de "sold !== true"
        // görüp ikisi de yazabiliyordu; ikinci yazan birincinin kaydının
        // ÜZERİNE yazıyordu — yani biri gerçekten Pi ödedi ama hiçbir kayıt
        // kalmıyordu, admin de bundan haberdar olmuyordu. Artık okuma+yazma
        // tek bir Firestore transaction içinde, atomik. Kaybeden taraf
        // (parası zaten gitmiş) net bir hata alıyor VE admin'e aynı anda
        // acil bir uyarı gidiyor ki elle iade sürecini başlatabilsin.
        const txResult = await db.runTransaction(async (tx) => {
          const domainSnap = await tx.get(domainRef);
          const realPrice = domainSnap.exists ? domainSnap.data().price : null;
          if (typeof realPrice !== 'number') return { ok: false, reason: 'invalid_domain' };
          if (domainSnap.data().sold === true) return { ok: false, reason: 'already_sold' };
          // Rezervasyon kontrolü BURADA (transaction içinde) da tekrarlanıyor
          // — approve aşamasındaki kontrol sadece erken/kaba bir engel,
          // asıl atomik/kesin koruma bu transaction'da olmalı.
          const dData = domainSnap.data();
          if (dData.reservedFor && dData.reservedUntil && dData.reservedUntil > Date.now() && dData.reservedFor !== username) {
            return { ok: false, reason: 'reserved', reservedUntil: dData.reservedUntil };
          }

          const code = "WEB3-" + Math.random().toString(36).substr(2, 6).toUpperCase();
          const sellerUsername = domainSnap.data().sellerUsername || null;
          const previousBuyer = domainSnap.data().buyer || null;
          const payoutStatusForDomain = sellerUsername ? 'pending' : 'no_seller';

          tx.set(domainRef, {
            sold: true, price: realPrice,
            txid: txid || null, buyer: username, at: Date.now(),
            sellerUsername: sellerUsername || null,
            // Escrow onayı tamamlanana kadar liste ekranında "Onay Aşamasında"
            // gösterilir; satıcısı yoksa (sistem domaini) zaten beklemeye
            // gerek olmadığından direkt kesin "SATILDI" gösterilir.
            payoutStatus: payoutStatusForDomain,
            reservedFor: FieldValue.delete(), reservedUntil: FieldValue.delete()
          }, { merge: true });

          return { ok: true, realPrice, sellerUsername, previousBuyer, code };
        });

        if (!txResult.ok) {
          if (txResult.reason === 'invalid_domain') return res.status(400).json({ error: "Geçersiz domain" });
          if (txResult.reason === 'reserved') {
            // Domain, anlaşma sağlanan BAŞKA bir alıcı için rezerve edilmiş.
            // 'approve' aşamasındaki ön-kontrol bunu genelde daha en baştan
            // engeller (kullanıcı parasını hiç göndermez); bu dal sadece çok
            // dar bir zaman penceresinde (approve ile complete arasında yeni
            // bir rezervasyon oluşmuşsa) tetiklenir. Ödeme yine de zaten
            // blockchain'de tamamlandığı için aynı acil-iade akışını izliyoruz.
            raceLost = true;
            console.error(`[REZERVASYON ÇAKIŞMASI] ${username}, ${domainName} için ödeme tamamladı ama domain başka bir alıcı için rezerveliymiş. txid:${txid}`);
            await logSystemError('complete_reservation_conflict', new Error('Domain reserved for another buyer — payment completed but no domain assigned'), `Alıcı:@${username} Domain:${domainName} Txid:${txid} — MANUEL İADE GEREKİYOR`);
            await sendTG(TG_CHAT_ID, `🚨 *ACİL — REZERVASYON ÇAKIŞMASI / MANUEL İADE GEREKİYOR*\n\n@${username} "${domainName}" için ödeme yaptı (txid: ${txid}) ama domain anlaşma sağlanan başka bir alıcı için rezerveliymiş. Bu kullanıcıya elle Pi iadesi yapılması gerekiyor.`);
            await sendNotificationToAdmin({
              type: 'reservation_conflict_refund_needed',
              title: '🚨 Acil: Elle İade Gerekiyor (Rezervasyon)',
              body: `@${username}, "${domainName}" için ödeme yaptı (txid: ${txid}) ama domain başka bir alıcı için rezerveliymiş. Manuel iade gerekiyor.`,
              domainName, buyer: username, txid
            });
            return res.status(409).json({
              error: "Bu domain, ödemeniz tamamlanırken anlaşma sağlanan başka bir alıcı için rezerve edilmiş. Paranız alındığı için otomatik olarak destek ekibine bildirildi, en kısa sürede sizinle iletişime geçip iadenizi yapacaklar.",
              raceCondition: true
            });
          }
          // 'already_sold': yarışı kaybetti. Ödeme Pi blockchain'inde zaten
          // tamamlandı — bunu geri alamayız, ama admin'i ACİL uyarıp elle
          // iade süreci başlatılmasını tetikliyoruz.
          raceLost = true;
          console.error(`[YARIŞ DURUMU] ${username}, ${domainName} için ödeme tamamladı ama domain az önce başka biri tarafından alınmış. txid:${txid}`);
          await logSystemError('complete_race_condition', new Error('Domain already sold — payment completed but no domain assigned'), `Alıcı:@${username} Domain:${domainName} Txid:${txid} — MANUEL İADE GEREKİYOR`);
          await sendTG(TG_CHAT_ID, `🚨 *ACİL — YARIŞ DURUMU / MANUEL İADE GEREKİYOR*\n\n@${username} "${domainName}" için ödeme yaptı (txid: ${txid}) ama domain aynı anda başka biri tarafından satın alınmış. Bu kullanıcıya elle Pi iadesi yapılması gerekiyor.`);
          await sendNotificationToAdmin({
            type: 'race_condition_refund_needed',
            title: '🚨 Acil: Elle İade Gerekiyor',
            body: `@${username}, "${domainName}" için ödeme yaptı (txid: ${txid}) ama domain aynı anda başka biri tarafından alındı. Manuel iade gerekiyor.`,
            domainName, buyer: username, txid
          });
          return res.status(409).json({
            error: "Bu domain, ödemeniz tamamlanırken çok kısa bir süre önce başka biri tarafından satın alınmış. Paranız alındığı için otomatik olarak destek ekibine bildirildi, en kısa sürede sizinle iletişime geçip iadenizi yapacaklar.",
            raceCondition: true
          });
        }

        const { realPrice, sellerUsername, previousBuyer, code } = txResult;
        purchaseCode = code;
        {

          await db.collection('global_sales').doc(txid || paymentId).set({
            user: username, domain: domainName, price: realPrice, at: Date.now(),
            sellerUsername: sellerUsername || null,
            // ── Escrow takibi ──────────────────────────────────────────
            // Ödeme şu an uygulamanın kendi Pi cüzdanında (havuzda) duruyor.
            // Admin, satıcının domaini alıcıya devrettiğini teyit edip
            // "Transfer Tamam" dediğinde payoutStatus 'released' olur ve
            // komisyon düşülmüş tutar satıcının Pi hesabına A2U ile gönderilir.
            payoutStatus: sellerUsername ? 'pending' : 'no_seller',
            commissionRate: PLATFORM_COMMISSION_RATE,
            payoutAmount: sellerUsername ? Math.round(realPrice * (1 - PLATFORM_COMMISSION_RATE) * 1e7) / 1e7 : null
          });

          const today = new Date().toISOString().split('T')[0];
          await db.collection('daily_stats').doc(today).set({
            count: FieldValue.increment(1),
            volume: FieldValue.increment(realPrice)
          }, { merge: true });

          // ── KALICI GELİR DEFTERİ ────────────────────────────────────
          // Bu rakamlar domain kaydına DEĞİL, ayrı ve kalıcı bir belgeye
          // yazılıyor — domain daha sonra silinse bile (test temizliği ya
          // da arşivleme) bu toplamlar ASLA etkilenmez.
          // Üçüncü taraf bir satıcı varsa, %5 komisyon burada değil,
          // ödeme gerçekten satıcıya serbest bırakıldığında (release_seller_
          // payment) kayda geçiyor — çünkü o ana kadar komisyon henüz
          // "kazanılmış" sayılmaz, Pi hâlâ havuzda bekliyor.
          const statsIncrement = { totalVolume: FieldValue.increment(realPrice) };
          if (sellerUsername) {
            statsIncrement.userOwnedVolume = FieldValue.increment(realPrice);
            if (sellerUsername === ADMIN_USERNAME) {
              statsIncrement.adminOwnEarnings = FieldValue.increment(realPrice);
            }
          } else {
            // Sistem domaini (satıcısız) — escrow/serbest bırakma adımı hiç
            // yok, tutarın tamamı satış anında kesinleşmiş sayılır.
            statsIncrement.adminOwnEarnings = FieldValue.increment(realPrice);
          }
          await db.collection('config').doc('platform_stats').set(statsIncrement, { merge: true });

          await updateUserPoints(username, realPrice, 'purchase');

          await sendNotification(username, {
            type: 'purchase_success',
            title: '🎉 Satın Alma Başarılı!',
            body: `"${domainName}" domainini ${realPrice} Pi karşılığında satın aldınız! Satıcıyla devri tamamladıktan sonra "Panelim" içinden teslim aldığınızı onaylamayı unutmayın.`,
            domainName, txid
          });

          await sendNotificationToAdmin({
            type: 'new_sale',
            title: '💰 Yeni Satış!',
            body: `@${username} tarafından "${domainName}" ${realPrice} Pi'ye satıldı.`,
            domainName, buyer: username, price: realPrice
          });

          if (sellerUsername && sellerUsername !== username) {
            await sendNotification(sellerUsername, {
              type: 'your_domain_sold',
              title: '🏆 Domaininiz Satıldı!',
              body: `"${domainName}" domaininiz @${username} tarafından ${realPrice} Pi'ye satın alındı! Domaini alıcıya devrettikten sonra lütfen "Panelim" içinden devri tamamladığınızı onaylayın — ödeme, hem sizin hem alıcının onayı görüldükten sonra admin tarafından serbest bırakılır (%${Math.round(PLATFORM_COMMISSION_RATE * 100)} komisyon düşülerek).`,
              domainName, buyer: username, price: realPrice
            });
          }

          if (previousBuyer && previousBuyer !== username) {
            await sendNotification(previousBuyer, {
              type: 'domain_resold',
              title: 'ℹ️ Domain Yeniden Satıldı',
              body: `Daha önce sahip olduğunuz "${domainName}" domaini, tekrar satışa çıkarıldıktan sonra @${username} tarafından satın alındı.`,
              domainName, buyer: username, price: realPrice
            });
          }

          // FIX: Grup mesajı da artık gerçek duruma göre değişiyor — escrow
          // devredeyse (sellerUsername varsa, yani neredeyse her satışta)
          // "satın aldı" yanında ödemenin henüz onay aşamasında olduğu da
          // açıkça belirtiliyor; admin mesajındaki mantıkla birebir aynı.
          const groupMsg = sellerUsername
            ? `🎉 *YENİ SATIŞ!*\n\n👤 @${username}, *${domainName}* domainini satın aldı!\n⏳ Ödeme şu anda escrow'da — satıcı ve alıcının devri onaylamasının ardından serbest bırakılacak.`
            : `🎉 *YENİ SATIŞ!*\n\n👤 @${username}, *${domainName}* domainini satın aldı! 🚀`;
          await sendTG(TG_GROUP_ID, groupMsg);
          // FIX: Üçüncü taraf bir satıcı varsa ödeme henüz escrow'da bekliyor
          // demektir (satıcıya serbest bırakılana kadar "tamamlandı" değil) —
          // bu yüzden mesaj artık gerçek duruma göre değişiyor. Satıcısız
          // (admin'e ait) domainlerde escrow adımı hiç olmadığı için "TAMAMLANDI"
          // hâlâ doğru.
          const adminMsg = sellerUsername
            ? `🔒 *YENİ SATIŞ — ESCROW'DA ONAY BEKLİYOR*\n\n👤 @${username}\n🌐 ${domainName}\n💰 ${realPrice} Pi\n🏷️ Satıcı: @${sellerUsername}\n🔑 ${purchaseCode}\n\nÖdeme, alıcı ve satıcının devri onaylaması sonrası "Bekleyen Ödemeler" panelinden serbest bırakılacak.`
            : `✅ *SATIŞ TAMAMLANDI*\n\n👤 @${username}\n🌐 ${domainName}\n💰 ${realPrice} Pi\n🔑 ${purchaseCode}`;
          await sendTG(TG_CHAT_ID, adminMsg);
        }
      } catch (firestoreErr) {
        console.error("Firestore yazma hatası:", firestoreErr);
        await logSystemError('complete', firestoreErr, `Ödeme tamamlandı (txid:${txid}) ama Firestore yazılamadı. Domain:${domainName}`);
        await sendTG(TG_CHAT_ID, `⚠️ *DİKKAT:* Ödeme tamamlandı (txid: ${txid}) ama Firestore'a yazılamadı. Domain: ${domainName}, @${username}`);
      }
      return res.status(200).json({ ...data, purchaseCode, success: true });
    }

    return res.status(200).json({ ...data, success: true });
  } catch (e) {
    console.error("Sunucu hatası:", e);
    await logSystemError('complete', e);
    return res.status(500).json({ error: e.message });
  }
}
