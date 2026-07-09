import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getDatabase } from 'firebase-admin/database';
import * as PiNetworkPkg from 'pi-backend';
// FIX (kök neden): pi-backend paketi TypeScript'ten derlenmiş bir CJS
// paketi olup `exports.default = PiNetwork` şeklinde dışa aktarım yapıyor.
// Node'un native ESM'inde `import X from 'cjs-paketi'` söz dizimi, X'i
// paketin .default'una DEĞİL, module.exports'un TAMAMINA bağlar. Yani
// PiNetwork değişkeni aslında bir sınıf değil, içinde .default barındıran
// düz bir nesne oluyordu — bu yüzden `new PiNetwork(...)` tam olarak
// "PiNetwork is not a constructor" hatasını veriyordu. Paketi namespace
// olarak import edip .default'u (yoksa paketin kendisini) kullanmak, hangi
// export şeklini kullanırsa kullansın doğru sonucu garanti eder.
const PiNetwork = PiNetworkPkg.default || PiNetworkPkg;

// ─── Admin Config ───────────────────────────────────────────────────────
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'doganay0808';
const PLATFORM_COMMISSION_RATE = 0.05; // %5 komisyon

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
  piClient = new PiNetwork(apiKey, walletSeed);
  return piClient;
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

// ─── Rate Limiter (IP bazlı, in-memory) ───────────────────────────────────
const rateLimitMap = new Map();
function checkRateLimit(ip, action, maxReq = 10, windowMs = 60000) {
  const key = `${ip}:${action}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 1; entry.start = now; }
  else entry.count++;
  rateLimitMap.set(key, entry);
  return entry.count <= maxReq;
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
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: "Sadece POST kabul edilir" });

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const { action, accessToken } = req.body;

  if (!action) return res.status(400).json({ error: "action zorunludur" });

  // ── Görsel Yükleme ─────────────────────────────────────────────────────
  if (action === 'upload_image') {
    if (!checkRateLimit(clientIp, 'upload_image', 5, 60000))
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
        createdAt: Date.now()
      });
      return res.status(200).json({ success: true });
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

      if (domainDataForDelete.sold === true) {
        const prevBuyer = domainDataForDelete.buyer;
        const soldPrice = Number(domainDataForDelete.price || 0);
        const soldAt = domainDataForDelete.at;

        if (prevBuyer && soldPrice > 0) {
          await reverseSaleAndPoints(db, delName, prevBuyer, soldPrice, soldAt);
        }
      }

      if (domainDataForDelete.sold === true) {
        return res.status(400).json({ error: "Satılmış domain önce 'Tekrar Satılık Yap' ile satıştan kaldırılmalı" });
      }

      if (domainDataForDelete.sellerUsername) {
        await updateUserPoints(domainDataForDelete.sellerUsername, -20, 'domain_deleted_point_reversal');
      }

      await domainRef.set({
        deleted: true,
        deletedAt: Date.now()
      }, { merge: true });

      console.log(`Domain soft-delete edildi: ${delName}`);
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
      console.log(`Domain kalıcı silindi: ${permDelName}`);
      return res.status(200).json({ success: true });
    } catch (e) {
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

      const resetTimestamp = Date.now();
      await db.collection('system_config').doc('reset_epoch').set({
        resetAt: resetTimestamp,
        resetBy: ADMIN_USERNAME
      });

      console.log(`Platform istatistikleri sıfırlandı: ${new Date(resetTimestamp).toISOString()}`);
      return res.status(200).json({ success: true, resetAt: resetTimestamp });
    } catch (e) {
      console.error("Platform sıfırlama hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Satış Önerisi Gönder ──────────────────────────────────────────────
  if (action === 'submit_sell_request') {
    if (!checkRateLimit(clientIp, 'submit_sell_request', 3, 60000))
      return res.status(429).json({ error: "Çok fazla istek. 1 dakika bekleyin." });

    const { domainName: reqDomainName, price: reqPrice, domainType, imgPath: reqImgPath, sellerWallet, description, editMode, oldRequestId } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçerli Pi oturumu bulunamadı" });

    const priceNum = Number(reqPrice);
    if (!reqDomainName || !priceNum || priceNum <= 0) return res.status(400).json({ error: "Geçersiz parametre" });

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
        sellerWallet: sellerWallet || null,
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
        sellerWallet: reqData.sellerWallet,
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
    if (!checkRateLimit(clientIp, 'create_ticket', 5, 60000))
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
      return res.status(200).json({ success: true, maintenanceMode: !!enabled });
    } catch (e) {
      console.error("set_maintenance_mode hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === 'submit_trademark_claim') {
    if (!checkRateLimit(clientIp, 'submit_trademark_claim', 3, 3600000))
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
      if (snap.data().status !== 'rejected')
        return res.status(400).json({ error: "Sadece reddedilmiş talepler silinebilir." });
      await claimRef.delete();
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("delete_trademark_claim hatası:", e);
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
        .where('payoutStatus', 'in', ['pending', 'no_seller', 'released', 'failed'])
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

        // Domain kaydını da güncelle: liste ekranında artık "Onay Aşamasında"
        // değil, kesin "SATILDI" olarak görünsün.
        if (sale.domain) {
          await db.collection('domains').doc(sale.domain).set({ payoutStatus: 'released' }, { merge: true });
        }

        await sendNotification(sale.sellerUsername, {
          type: 'payout_released',
          title: '💸 Ödemeniz Gönderildi!',
          body: `"${sale.domain}" domain satışınıza ait ${payoutAmount} Pi (komisyon düşülmüş), Pi hesabınıza gönderildi.`,
          domainName: sale.domain, amount: payoutAmount
        });
        await sendTG(TG_CHAT_ID, `💸 *ÖDEME SERBEST BIRAKILDI*\n\n🌐 ${sale.domain}\n👤 @${sale.sellerUsername}\n💰 ${payoutAmount} Pi\n🔑 txid: ${txid}`);

        return res.status(200).json({ success: true, txid, payoutAmount });
      } catch (stepError) {
        // Hangi adımda kaldığını (paymentId/txid) kaydediyoruz ki bir sonraki
        // deneme sıfırdan başlamasın — Pi'ler güvende, sadece işlem yarım kaldı.
        await saleRef.set({
          payoutStatus: 'failed',
          payoutError: stepError.message,
          payoutFailedAt: Date.now(),
          payoutPaymentId: paymentId || null,
          payoutTxid: txid || null
        }, { merge: true });
        return res.status(500).json({
          error: `Ödeme tamamlanamadı ama Pi'ler kaybolmadı, güvenli havuzda bekliyor: ${stepError.message}. Aynı butona tekrar basarak kaldığı yerden devam ettirebilirsiniz.`
        });
      }
    } catch (e) {
      console.error("release_seller_payment hatası:", e);
      try {
        await getDb().collection('global_sales').doc(saleId).set({ payoutStatus: 'failed', payoutError: e.message, payoutFailedAt: Date.now() }, { merge: true });
      } catch (_) {}
      return res.status(500).json({ error: "Ödeme gönderilemedi: " + e.message });
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

        return res.status(200).json({ success: true, txid, refundAmount });
      } catch (stepError) {
        await saleRef.set({
          payoutStatus: 'refund_failed',
          refundError: stepError.message,
          refundFailedAt: Date.now(),
          refundPaymentId: paymentId || null,
          refundTxid: txid || null
        }, { merge: true });
        return res.status(500).json({
          error: `İade tamamlanamadı ama Pi'ler kaybolmadı, güvenli havuzda bekliyor: ${stepError.message}. Aynı butona tekrar basarak kaldığı yerden devam ettirebilirsiniz.`
        });
      }
    } catch (e) {
      console.error("refund_buyer_payment hatası:", e);
      return res.status(500).json({ error: "İade gönderilemedi: " + e.message });
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
  if (action === 'get_user_profile') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const profileSnap = await db.collection('user_profiles').doc(realUsername).get();
      const profileData = profileSnap.exists ? profileSnap.data() : { points: 0, badge: null };

      const salesSnap = await db.collection('global_sales').where('user', '==', realUsername).get();
      let totalSpent = 0;
      const purchases = [];
      salesSnap.forEach(d => {
        const data = d.data();
        purchases.push(data);
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
  if (action === 'get_admin_earnings') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();

      const allDomainsSnap = await db.collection('domains').get();

      let totalVolume = 0;
      let userOwnedVolume = 0;
      let adminOwnEarnings = 0;
      let platformEarnings = 0;
      const salesByDomain = {};
      const adminOwnSoldDomains = [];
      const allSalesDetail = [];

      allDomainsSnap.forEach(d => {
        const data = d.data();
        const price = Number(data.price || 0);

        if (data.deleted === true || data.sold !== true) return;

        totalVolume += price;
        salesByDomain[d.id] = (salesByDomain[d.id] || 0) + price;

        allSalesDetail.push({
          name: d.id,
          price: data.price,
          buyer: data.buyer || null,
          at: data.at || null,
          sellerUsername: data.sellerUsername || null,
          type: data.type || 'genel'
        });

        if (data.sellerUsername) {
          userOwnedVolume += price;
          if (data.sellerUsername === ADMIN_USERNAME) {
            adminOwnEarnings += price;
            adminOwnSoldDomains.push({
              name: d.id,
              price: data.price,
              buyer: data.buyer || null
            });
          } else {
            // Platform cüzdanı: SADECE başka kullanıcılar tarafından listelenip
            // satılan domainlerden alınan %5 komisyon kesintisi. Satıcının payı
            // (kalan %95), escrow serbest bırakıldığında kendisine gider —
            // platform cüzdanına dahil edilmez.
            platformEarnings += price * PLATFORM_COMMISSION_RATE;
          }
        } else {
          adminOwnEarnings += price;
          adminOwnSoldDomains.push({
            name: d.id,
            price: data.price,
            buyer: data.buyer || null
          });
        }
      });

      platformEarnings = Math.round(platformEarnings * 1e7) / 1e7;

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

  if (action === 'cancel') {
    if (domainName && !username) {
      return res.status(400).json({ error: "cancel işlemi için username gerekli" });
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
      try {
        const db = getDb();
        const domainRef = db.collection('domains').doc(domainName);
        const domainSnap = await domainRef.get();
        const realPrice = domainSnap.exists ? domainSnap.data().price : null;

        if (typeof realPrice !== 'number')
          return res.status(400).json({ error: "Geçersiz domain" });

        if (domainSnap.data().sold !== true) {
          purchaseCode = "WEB3-" + Math.random().toString(36).substr(2, 6).toUpperCase();
          const sellerUsername = domainSnap.data().sellerUsername || null;
          const previousBuyer = domainSnap.data().buyer || null;

          const payoutStatusForDomain = sellerUsername ? 'pending' : 'no_seller';
          await domainRef.set({
            sold: true, price: realPrice,
            txid: txid || null, buyer: username, at: Date.now(),
            sellerUsername: sellerUsername || null,
            // Escrow onayı tamamlanana kadar liste ekranında "Onay Aşamasında"
            // gösterilir; satıcısı yoksa (sistem domaini) zaten beklemeye
            // gerek olmadığından direkt kesin "SATILDI" gösterilir.
            payoutStatus: payoutStatusForDomain
          }, { merge: true });

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

          await updateUserPoints(username, realPrice, 'purchase');

          await sendNotification(username, {
            type: 'purchase_success',
            title: '🎉 Satın Alma Başarılı!',
            body: `"${domainName}" domainini ${realPrice} Pi karşılığında satın aldınız!`,
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
              body: `"${domainName}" domaininiz @${username} tarafından ${realPrice} Pi'ye satın alındı! Ödeme, admin domainin devrini onaylayana kadar güvenli havuzda (escrow) bekletilir; onay sonrası %${Math.round(PLATFORM_COMMISSION_RATE * 100)} komisyon düşülerek Pi hesabınıza gönderilir.`,
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

          const groupMsg = `🎉 *YENİ SATIŞ!*\n\n👤 @${username}, *${domainName}* domainini satın aldı! 🚀`;
          await sendTG(TG_GROUP_ID, groupMsg);
          await sendTG(TG_CHAT_ID, `✅ *SATIŞ TAMAMLANDI*\n\n👤 @${username}\n🌐 ${domainName}\n💰 ${realPrice} Pi\n🔑 ${purchaseCode}`);
        } else {
          console.warn("Domain zaten satılmış:", domainName);
        }
      } catch (firestoreErr) {
        console.error("Firestore yazma hatası:", firestoreErr);
        await sendTG(TG_CHAT_ID, `⚠️ *DİKKAT:* Ödeme tamamlandı (txid: ${txid}) ama Firestore'a yazılamadı. Domain: ${domainName}, @${username}`);
      }
      return res.status(200).json({ ...data, purchaseCode, success: true });
    }

    return res.status(200).json({ ...data, success: true });
  } catch (e) {
    console.error("Sunucu hatası:", e);
    return res.status(500).json({ error: e.message });
  }
}
