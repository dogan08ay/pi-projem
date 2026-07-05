import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getDatabase } from 'firebase-admin/database';

// ─── Admin Config ───────────────────────────────────────────────────────
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'doganay0808';

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
//  YENİ: Satış kaydını ve puanları geri alma yardımcı fonksiyonu
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

    // 2. Kullanıcı puanlarını geri al (negatif ekle = pozitif puanı azalt)
    await updateUserPoints(buyerUsername, -soldPrice, `sale_reversed_${domainName}`);

    // 3. daily_stats'ten de düş (eğer soldAt varsa)
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

      // Önce satılmış mı kontrol et - satılmışsa relist yapılmadan silinemez
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

    const { domainName: reqDomainName, price: reqPrice, domainType, imgPath: reqImgPath, sellerWallet, description } = req.body;
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

      const existingReq = await db.collection('sell_requests')
        .where('submittedBy', '==', realUsername)
        .where('status', '==', 'pending')
        .where('domainName', '==', reqDomainName)
        .get();
      if (!existingReq.empty) return res.status(400).json({ error: "Bu domain için zaten bekleyen bir öneriniz var" });

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


  // ── Ticket Oluştur (Kullanıcı) ───────────────────────────────────────────
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
      const ticketId = ticketRef.id;

      await ticketRef.set({
        ticketId,
        subject,
        category: category || 'genel',
        priority: priority || 'normal',
        status: 'new',
        createdBy: realUsername,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{
          sender: realUsername,
          message,
          timestamp: Date.now(),
          isAdmin: false
        }],
        adminNotes: '',
        assignedTo: null
      });

      // Kullanıcıya bildirim
      await sendNotification(realUsername, {
        type: 'ticket_created',
        title: '📬 Talebiniz Alındı',
        body: `"${subject}" konulu talebiniz başarıyla oluşturuldu. En kısa sürede incelenecektir.`,
        ticketId,
        status: 'new'
      });

      // Admin'e bildirim
      await sendNotificationToAdmin({
        type: 'new_ticket',
        title: '🎫 Yeni Destek Talebi',
        body: `@${realUsername} tarafından "${subject}" konulu yeni bir talep oluşturuldu.`,
        ticketId,
        category
      });

      // Telegram bildirimi
      await sendTG(TG_CHAT_ID, `🎫 *YENİ DESTEK TALEBİ*\n\n👤 @${realUsername}\n📌 ${subject}\n🏷️ ${category || 'genel'}\n🎫 ${ticketId}`);

      return res.status(200).json({ success: true, ticketId });
    } catch (e) {
      console.error("Ticket oluşturma hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Kullanıcı Ticket'larını Getir ──────────────────────────────────────
  if (action === 'get_my_tickets') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const snap = await db.collection('tickets')
        .where('createdBy', '==', realUsername)
        .orderBy('updatedAt', 'desc')
        .get();

      const tickets = [];
      snap.forEach(doc => tickets.push({ id: doc.id, ...doc.data() }));
      return res.status(200).json({ success: true, tickets });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Ticket Detayını Getir ─────────────────────────────────────────────
  if (action === 'get_ticket_detail') {
    const { ticketId } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!ticketId) return res.status(400).json({ error: "ticketId zorunludur" });
    try {
      const db = getDb();
      const snap = await db.collection('tickets').doc(ticketId).get();
      if (!snap.exists) return res.status(404).json({ error: "Talep bulunamadı" });

      const data = snap.data();
      const isAdmin = await verifyAdmin(accessToken);
      if (data.createdBy !== realUsername && !isAdmin) {
        return res.status(403).json({ error: "Bu talebi görme yetkiniz yok" });
      }

      return res.status(200).json({ success: true, ticket: { id: snap.id, ...data } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Ticket'a Mesaj Ekle (Kullanıcı) ────────────────────────────────────
  if (action === 'add_ticket_message') {
    const { ticketId, message } = req.body;
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    if (!ticketId || !message) return res.status(400).json({ error: "ticketId ve mesaj zorunludur" });
    try {
      const db = getDb();
      const ticketRef = db.collection('tickets').doc(ticketId);
      const ticketSnap = await ticketRef.get();
      if (!ticketSnap.exists) return res.status(404).json({ error: "Talep bulunamadı" });

      const ticketData = ticketSnap.data();
      if (ticketData.createdBy !== realUsername) {
        return res.status(403).json({ error: "Bu talebe mesaj ekleme yetkiniz yok" });
      }
      if (ticketData.status === 'closed') {
        return res.status(400).json({ error: "Kapatılmış taleplere mesaj eklenemez" });
      }

      // DÜZELTME: admin.firestore.FieldValue yerine FieldValue kullan
      await ticketRef.update({
        messages: FieldValue.arrayUnion({
          sender: realUsername,
          message,
          timestamp: Date.now(),
          isAdmin: false
        }),
        updatedAt: Date.now()
      });

      await sendNotificationToAdmin({
        type: 'ticket_message',
        title: '💬 Yeni Mesaj',
        body: `@${realUsername} "${ticketData.subject}" talebine yeni mesaj gönderdi.`,
        ticketId
      });

      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Tüm Ticket'ları Getir ──────────────────────────────────────
  if (action === 'admin_get_all_tickets') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    try {
      const db = getDb();
      const { status, category } = req.body;
      let query = db.collection('tickets').orderBy('updatedAt', 'desc');
      if (status) query = query.where('status', '==', status);
      if (category) query = query.where('category', '==', category);

      const snap = await query.get();
      const tickets = [];
      snap.forEach(doc => tickets.push({ id: doc.id, ...doc.data() }));
      return res.status(200).json({ success: true, tickets });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Ticket Durumunu Güncelle ────────────────────────────────────
  if (action === 'admin_update_ticket_status') {
    const { ticketId, newStatus, adminNote } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!ticketId || !newStatus) return res.status(400).json({ error: "ticketId ve yeni durum zorunludur" });

    const validStatuses = ['new', 'reviewing', 'answered', 'resolved', 'closed'];
    if (!validStatuses.includes(newStatus)) {
      return res.status(400).json({ error: "Geçersiz durum" });
    }
    try {
      const db = getDb();
      const ticketRef = db.collection('tickets').doc(ticketId);
      const ticketSnap = await ticketRef.get();
      if (!ticketSnap.exists) return res.status(404).json({ error: "Talep bulunamadı" });

      const ticketData = ticketSnap.data();
      const updates = { status: newStatus, updatedAt: Date.now() };
      if (adminNote) updates.adminNotes = adminNote;

      await ticketRef.update(updates);

      const statusMessages = {
        'reviewing': { title: '🔍 Talebiniz İnceleniyor', body: `"${ticketData.subject}" konulu talebiniz incelenmeye başlandı.` },
        'answered': { title: '💬 Geri Bildirim', body: `"${ticketData.subject}" konulu talebinize yanıt verildi. Lütfen kontrol edin.` },
        'resolved': { title: '✅ Talep Çözüldü', body: `"${ticketData.subject}" konulu talebiniz çözüldü. Teşekkür ederiz!` },
        'closed': { title: '📪 Talep Kapatıldı', body: `"${ticketData.subject}" konulu talep kapatıldı.` }
      };

      const msg = statusMessages[newStatus];
      if (msg) {
        await sendNotification(ticketData.createdBy, {
          type: 'ticket_status_update',
          title: msg.title,
          body: msg.body,
          ticketId,
          status: newStatus
        });
      }

      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Admin: Ticket'a Cevap Yaz ─────────────────────────────────────────
  if (action === 'admin_reply_ticket') {
    const { ticketId, message } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!ticketId || !message) return res.status(400).json({ error: "ticketId ve mesaj zorunludur" });
    try {
      const db = getDb();
      const ticketRef = db.collection('tickets').doc(ticketId);
      const ticketSnap = await ticketRef.get();
      if (!ticketSnap.exists) return res.status(404).json({ error: "Talep bulunamadı" });

      const ticketData = ticketSnap.data();
      if (ticketData.status === 'closed') {
        return res.status(400).json({ error: "Kapatılmış taleplere cevap yazılamaz" });
      }

      // DÜZELTME: admin.firestore.FieldValue yerine FieldValue kullan
      await ticketRef.update({
        messages: FieldValue.arrayUnion({
          sender: ADMIN_USERNAME,
          message,
          timestamp: Date.now(),
          isAdmin: true
        }),
        status: 'answered',
        updatedAt: Date.now()
      });

      await sendNotification(ticketData.createdBy, {
        type: 'ticket_admin_reply',
        title: '💬 Yöneticiden Yeni Mesaj',
        body: `"${ticketData.subject}" talebinize yönetici tarafından yanıt verildi.`,
        ticketId
      });

      return res.status(200).json({ success: true });
    } catch (e) {
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

      platformEarnings = 0;

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

          await domainRef.set({
            sold: true, price: realPrice,
            txid: txid || null, buyer: username, at: Date.now()
          }, { merge: true });

          await db.collection('global_sales').doc(txid || paymentId).set({
            user: username, domain: domainName, price: realPrice, at: Date.now(),
            sellerUsername: sellerUsername || null
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
              body: `"${domainName}" domaininiz @${username} tarafından ${realPrice} Pi'ye satın alındı!`,
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
