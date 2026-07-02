import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getDatabase } from 'firebase-admin/database';

// ─── Firebase Admin Başlatma ───────────────────────────────────────────────
function getAdminApp() {
  if (getApps().length > 0) return getApps()[0];

  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  if (!dbUrl) {
    console.error("[FIREBASE INIT UYARI] FIREBASE_DATABASE_URL ortam değişkeni BOŞ/tanımsız. RTDB (bildirimler) çalışmayacak.");
  } else if (!/^https:\/\/.+\.firebaseio\.com\/?$/.test(dbUrl) && !/^https:\/\/.+\.(firebasedatabase\.app)\/?$/.test(dbUrl)) {
    console.error(`[FIREBASE INIT UYARI] FIREBASE_DATABASE_URL formatı beklenmedik görünüyor: "${dbUrl}".`);
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
    const valid = userDto.username === 'doganay0808';
    adminCache.set(accessToken, { valid, ts: Date.now() });
    return valid;
  } catch (e) {
    console.error("Pi /v2/me admin doğrulama hatası:", e);
    return false;
  }
}

// Kullanıcı token cache
const userCache = new Map();
async function getRealUsername(accessToken) {
  if (!accessToken) return null;
  const cached = userCache.get(accessToken);
  if (cached && Date.now() - cached.ts < ADMIN_CACHE_TTL) return cached.username;
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

// ─── Rate Limiter ─────────────────────────────────────────────────────────
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

// ─── Bildirim Yardımcıları ────────────────────────────────────────────────
async function sendNotification(targetUsername, notification) {
  if (!targetUsername) return;
  try {
    const rtdb = getRtdb();
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
  await sendNotification('doganay0808', notification);
}

// ─── Telegram Yardımcısı ────────────────────────────────────────────────────
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

// ─── Puan Güncelle ─────────────────────────────────────────────────────────
async function updateUserPoints(username, points, reason) {
  try {
    const db = getDb();
    const ref = db.collection('user_profiles').doc(username);
    await ref.set({
      points: FieldValue.increment(points),
      updatedAt: Date.now()
    }, { merge: true });
    const snap = await ref.get();
    const totalPoints = Math.max(0, snap.data()?.points || 0);
    let badge = null;
    if (totalPoints >= 500) badge = 'diamond';
    else if (totalPoints >= 200) badge = 'gold';
    else if (totalPoints >= 50)  badge = 'silver';
    else if (totalPoints >= 10)  badge = 'bronze';
    await ref.set({ badge }, { merge: true });
  } catch (e) { console.error("Puan güncelleme hatası:", e); }
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

      if (realUsername !== 'doganay0808') {
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

  // ── Logout ── ✅ YENİ EKLENDİ ──────────────────────────────────────────
  if (action === 'logout') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      // Kullanıcı cache'inden temizle
      userCache.delete(accessToken);
      // Active users'tan sil
      const db = getDb();
      await db.collection('active_users').doc(realUsername).delete().catch(() => {});
      console.log(`Kullanıcı çıkış yaptı: @${realUsername}`);
      return res.status(200).json({ success: true, message: "Çıkış başarılı" });
    } catch (e) {
      console.error("Logout hatası:", e);
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

      if (prevBuyer) {
        try {
          const matchSnap = await db.collection('global_sales')
            .where('user', '==', prevBuyer)
            .where('domain', '==', domainName)
            .where('at', '==', soldAt)
            .get();
          if (!matchSnap.empty) {
            const batch = db.batch();
            matchSnap.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
          }
          await updateUserPoints(prevBuyer, -soldPrice, 'domain_relisted_point_reversal');
        } catch (reversalErr) {
          console.error("Relist sırasında harcama/puan geri alma hatası:", reversalErr);
        }
      }

      await domainRef.set({ sold: false, txid: null, buyer: null, at: null }, { merge: true });

      if (soldAt) {
        const soldDate = new Date(soldAt).toISOString().split('T')[0];
        const today = new Date().toISOString().split('T')[0];
        if (soldDate === today) {
          await db.collection('daily_stats').doc(today).set({
            count: FieldValue.increment(-1),
            volume: FieldValue.increment(-soldPrice)
          }, { merge: true });
        }
      }

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
      if (domainSnap.data().sold === true) return res.status(400).json({ error: "Satılmış domain silinemez" });

      const domainDataForDelete = domainSnap.data();
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

  // ── Domain Kalıcı Sil (PERMA DELETE) ── ✅ YENİ EKLENDİ ────────────────
  if (action === 'perma_delete_domain') {
    const { domainName: permaDelName } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (!permaDelName) return res.status(400).json({ error: "Geçersiz domain adı" });
    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(permaDelName);
      const domainSnap = await domainRef.get();
      if (!domainSnap.exists) return res.status(404).json({ error: "Domain bulunamadı" });

      // İlişkili global_sales kayıtlarını sil
      const salesSnap = await db.collection('global_sales')
        .where('domain', '==', permaDelName)
        .get();
      if (!salesSnap.empty) {
        const batch = db.batch();
        salesSnap.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }

      // Domain'i tamamen sil
      await domainRef.delete();
      console.log(`Domain kalıcı olarak silindi: ${permaDelName}`);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("Kalıcı silme hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Domain Geri Getir ──────────────────────────────────────────────────
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

  // ── Platform İstatistiklerini Sıfırla ──────────────────────────────────
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
        resetBy: 'doganay0808'
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

  // ── Kullanıcı Profili Getir ───────────────────────────────────────────
  if (action === 'get_user_profile') {
    const realUsername = await getRealUsername(accessToken);
    if (!realUsername) return res.status(403).json({ error: "Geçersiz oturum" });
    try {
      const db = getDb();
      const profileSnap = await db.collection('user_profiles').doc(realUsername).get();
      const profileData = profileSnap.exists ? profileSnap.data() : { points: 0, badge: null };

      const myPurchasedDomainsSnap = await db.collection('domains')
        .where('buyer', '==', realUsername)
        .where('sold', '==', true)
        .get();
      let totalSpent = 0;
      myPurchasedDomainsSnap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        totalSpent += Number(data.price || 0);
      });

      const salesSnap = await db.collection('global_sales').where('user', '==', realUsername).get();
      const purchases = [];
      salesSnap.forEach(d => { purchases.push(d.data()); });

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
      const allSalesSnap = await db.collection('global_sales').get();
      let totalVolume = 0;
      const salesByDomain = {};
      allSalesSnap.forEach(d => {
        const data = d.data();
        totalVolume += Number(data.price || 0);
        salesByDomain[data.domain] = (salesByDomain[data.domain] || 0) + Number(data.price || 0);
      });

      const userOwnedDomainsSnap = await db.collection('domains')
        .where('sold', '==', true)
        .get();
      let userOwnedVolume = 0;
      userOwnedDomainsSnap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        if (data.sellerUsername) userOwnedVolume += Number(data.price || 0);
      });

      const adminOwnSalesSnap = await db.collection('domains')
        .where('sellerUsername', '==', 'doganay0808')
        .where('sold', '==', true)
        .get();
      let adminOwnEarnings = 0;
      const adminOwnSoldDomains = [];
      adminOwnSalesSnap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        adminOwnEarnings += Number(data.price || 0);
        adminOwnSoldDomains.push({ name: d.id, price: data.price, buyer: data.buyer || null });
      });

      const platformEarnings = totalVolume - userOwnedVolume;

      return res.status(200).json({
        success: true,
        totalVolume,
        userOwnedVolume,
        platformEarnings,
        adminOwnEarnings,
        adminOwnSoldDomains,
        salesByDomain
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Satış Detaylarını Getir ── ✅ YENİ EKLENDİ ─────────────────────────
  if (action === 'get_sales_details') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    const { date } = req.body;
    try {
      const db = getDb();
      let query = db.collection('global_sales').orderBy('at', 'desc');
      if (date) {
        const startOfDay = new Date(date); startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date); endOfDay.setHours(23, 59, 59, 999);
        query = query.where('at', '>=', startOfDay.getTime()).where('at', '<=', endOfDay.getTime());
      }
      const salesSnap = await query.limit(100).get();
      const sales = [];
      salesSnap.forEach(d => {
        const data = d.data();
        sales.push({ domain: data.domain || '', buyer: data.user || '', price: Number(data.price || 0), at: data.at || Date.now(), sellerUsername: data.sellerUsername || null });
      });
      return res.status(200).json({ success: true, sales });
    } catch (e) {
      console.error("Satış detayları hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Günlük Giriş Kaydını Getir ── ✅ YENİ EKLENDİ ──────────────────────
  if (action === 'get_daily_log') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "Tarih zorunludur" });
    try {
      const db = getDb();
      const snap = await db.collection('daily_users').doc(date).get();
      const users = snap.exists ? (snap.data().users || {}) : {};
      const sorted = Object.keys(users).sort((a, b) => users[b] - users[a]);
      return res.status(200).json({ success: true, users: sorted, userData: users, count: sorted.length, date });
    } catch (e) {
      console.error("Günlük log hatası:", e);
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
