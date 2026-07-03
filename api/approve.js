import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getDatabase } from 'firebase-admin/database';

// ─── Firebase Admin Başlatma ───────────────────────────────────────────────
function getAdminApp() {
  if (getApps().length > 0) return getApps()[0];

  // FIX (teşhis katmanı): Ortam değişkenlerinin VAR olması yetmez, doğru
  // FORMATTA olması gerekir. Bu loglar Vercel Function Logs'ta her cold
  // start'ta bir kez görünür ve yapılandırma hatasını net şekilde işaret
  // eder — "değişken tanımlı ama yanlış" durumunu "hiç tanımlı değil"
  // durumundan ayırt etmeyi sağlar.
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
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // örn: web3-domain-gateway.appspot.com
    databaseURL: dbUrl,     // örn: https://web3-domain-gateway-default-rtdb.firebaseio.com
  });
}
function getDb()      { getAdminApp(); return getFirestore(); }
function getBucket()  { getAdminApp(); return getStorage().bucket(); }
function getRtdb()    { getAdminApp(); return getDatabase(); }

// ─── Admin Token Cache (Pi API'ye her seferinde gitmeyi önler) ────────────
const adminCache = new Map(); // token -> { valid: bool, ts: timestamp }
const ADMIN_CACHE_TTL = 5 * 60 * 1000; // 5 dakika

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
// NOT: RTDB rules tamamen kapalı (read:false, write:false). Admin SDK bu
// kuralları bypass eder, dolayısıyla backend (Admin SDK) hem yazabilir hem
// okuyabilir. Frontend client SDK'sı ise hiçbir şekilde okuyamaz/yazamaz.
// Bu yüzden bildirim okuma/işaretleme de backend üzerinden (proxy) yapılır.
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
    // FIX: Bu hata önceden sadece console.error ile basılıyordu ve
    // çağıran kodun akışını hiç etkilemiyordu — bu doğru bir davranış
    // (bir bildirim gönderilemese de asıl işlem, örn. satın alma,
    // başarısız sayılmamalı). Ama teşhisi kolaylaştırmak için hatanın
    // TAM mesajını ve hangi kullanıcıya/hangi bildirim tipi için
    // gönderilmeye çalışıldığını da logluyoruz. En sık görülen neden:
    // process.env.FIREBASE_DATABASE_URL tanımlı değilse getDatabase()
    // burada "Can't determine Firebase Database URL" tarzı bir hata
    // fırlatır — Vercel loglarında bu satırı arayarak teşhis edilebilir.
    console.error(`Bildirim gönderilemedi (hedef: @${targetUsername}, tip: ${notification?.type||'?'}):`, e.message || e);
  }
}

async function sendNotificationToAdmin(notification) {
  await sendNotification('doganay0808', notification);
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

      // Max 2MB kontrol
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

  // ── Bildirimleri Getir (RTDB rules kapalı olduğu için backend proxy) ───
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
        .slice(0, 100); // son 100 bildirim ile sınırla
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

  // ── Puan Güncelle (satın alma sonrası otomatik çağrılır) ───────────────
  async function updateUserPoints(username, points, reason) {
    try {
      const db = getDb();
      const ref = db.collection('user_profiles').doc(username);
      await ref.set({
        points: FieldValue.increment(points),
        updatedAt: Date.now()
      }, { merge: true });
      // Rozet kontrolü — puan düşünce rozet de güncellenmeli (null dahil)
      const snap = await ref.get();
      const totalPoints = Math.max(0, snap.data()?.points || 0);
      let badge = null;
      if (totalPoints >= 500) badge = 'diamond';
      else if (totalPoints >= 200) badge = 'gold';
      else if (totalPoints >= 50)  badge = 'silver';
      else if (totalPoints >= 10)  badge = 'bronze';
      // FIX: badge null olsa bile yaz — önceki if(badge) kontrolü
      // puan düşünce rozeti sıfırlamıyordu.
      await ref.set({ badge }, { merge: true });
    } catch (e) { console.error("Puan güncelleme hatası:", e); }
  }

  // ── Giriş Bildirimi (yeni kullanıcı girişinde admin'e + login event log) ─
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

      // İlk giriş tarihini hesapla (tüm daily_users kayıtlarından en eski)
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

      // Admin'e "kullanıcı girişi" bildirimi (admin kendisi değilse)
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

      // FIX (karar: harcama VE puan geri alınır): Domain relist edildiğinde
      // eski alıcı için bu satış artık "geçerli" sayılmaz — kullanıcı
      // panelinde harcama ve puan gerçek durumu yansıtmalı. Bu yüzden:
      //  1) global_sales kaydı silinir (artık "satın aldım" geçmişinde
      //     görünmemeli — toplam harcamadan da otomatik düşer çünkü
      //     totalSpent bu koleksiyondan toplanıyor).
      //  2) Eski alıcının kazandığı puan (satış anında verilen, fiyat
      //     kadar puan) geri alınır.
      // Domain'in kendisi (açıklama, görsel, satıcı bilgisi) ASLA silinmez
      // — sadece bu işleme ait fiyatsal/puansal etkiler geri alınır.
      if (prevBuyer) {
        try {
          // FIX: global_sales dokümanı ID'si txid VEYA (txid yoksa) paymentId
          // olabilir — relist anında elimizde paymentId yok, txid de null
          // olabilir. Bu yüzden ID tahmin etmiyoruz; her durumda alıcı+
          // domain+satış zamanına göre SORGU ile doğru kaydı/kayıtları
          // bulup siliyoruz. Bu yaklaşım txid'in var/yok olmasından bağımsız
          // olarak güvenilir çalışır.
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

      // Eski alıcıya bildirim
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
      // FIX (güvenlik/veri bütünlüğü): Bu isim daha önce kullanılmışsa
      // (silinmiş olsa bile) burada YENİ bir kayıt olarak ASLA
      // oluşturulmaz. Aksi halde .set() çağrısı eski (silinmiş) domain'in
      // sellerUsername, sellerWallet, description, görsel geçmişi gibi
      // tüm alanlarını sessizce ezer — bu, "silinen veriler korunur"
      // garantisini bozar. Admin bu ismi geri istiyorsa restore_domain
      // action'ını kullanmalı.
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

  // ── Domain Sil (SOFT DELETE — kalıcı silme yerine işaretleme) ─────────
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

      // FIX (karar: puan geri alınır): Eğer bu domain bir kullanıcının
      // onaylanmış satış ilanıysa (sellerUsername var), o ilan onaylanırken
      // satıcıya +20 puan verilmişti (approve_sell_request içinde). Domain
      // şimdi siliniyorsa (henüz satılmamış haliyle), bu puan artık
      // gerçekte karşılığı olmayan bir kazanç haline gelir — geri alınır.
      const domainDataForDelete = domainSnap.data();
      if (domainDataForDelete.sellerUsername) {
        await updateUserPoints(domainDataForDelete.sellerUsername, -20, 'domain_deleted_point_reversal');
      }

      // FIX (önemli mantık değişikliği): Önceden domainRef.delete() ile
      // belge tamamen siliniyordu. Bu durumda:
      //  - Geçmiş fiyat hareketleri / istatistikler korunsa da domain'in
      //    kendisi geri getirilemez hale geliyordu.
      //  - "Panelim" tarafında kullanıcıların sellRequests/soldDomains
      //    listelerinde silinen domain'e ait kayıtlar query'lerde
      //    görünmeye devam edebiliyordu çünkü sell_requests koleksiyonu
      //    ayrı ve dokunulmuyordu.
      // Çözüm: documenti SİLMEK yerine deleted:true olarak işaretliyoruz.
      // Frontend tarafında "deleted === true" olan domainler hem markette
      // hem kullanıcı panellerinde gösterilmez ama veri kalıcı olarak
      // saklanır (admin ileride geri getirebilir / denetim izi kalır).
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

  // ── Domain Geri Getir (Soft-delete edilmiş bir domain'i canlandırır) ──
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

      // FIX (simetri): delete_domain, satıcının onay puanını (-20)
      // geri alıyordu (eğer domain bir sellerUsername'e aitse, henüz
      // satılmamışsa). Restore işlemi bunun tersini yapmalı: domain
      // geri geldiğinde, eğer hâlâ satılmamışsa, o puan tekrar verilir.
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

  // ── Domain Kalıcı Sil (sadece deleted:true olanlar) ──────────────────
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
      if (snap.data().deleted !== true) return res.status(400).json({ error: "Sadece soft-delete edilmiş domainler kalıcı silinebilir" });
      await domainRef.delete();
      console.log(`Domain kalıcı silindi: ${permDelName}`);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Platform İstatistiklerini Sıfırla (KARAR: kalıcı silme + epoch) ───
  // Bu işlem geri alınamaz, bu yüzden ekstra bir confirmReset:true
  // parametresi zorunlu kılınmıştır — yanlışlıkla tetiklenmeyi önler.
  //
  // Ne yapar:
  //  1) global_sales koleksiyonundaki TÜM dokümanları kalıcı olarak siler
  //     (artık totalSpent zaten domains'ten hesaplanıyor, ama "karışmasın"
  //     talebi gereği bu geçmiş veri de temizlenir).
  //  2) daily_stats koleksiyonundaki TÜM dokümanları siler (platform
  //     kazancının totalVolume hesabını besleyen günlük hacim geçmişi).
  //  3) user_profiles koleksiyonundaki TÜM dokümanlarda points alanını
  //     0'a, badge alanını null'a sıfırlar (rozet de puana bağlı olduğu
  //     için sıfırdan başlamalı).
  //  4) system_config/reset_epoch dokümanına bugünün timestamp'ini yazar.
  //     Bu epoch, gelecekteki tüm yeni satış/puan/onay işlemlerinin
  //     "bugünden sonraki gerçek veri" olduğunu işaretler — ileride
  //     ihtiyaç olursa bu tarihten önceki/sonraki ayrımı yapılabilir.
  //
  // Ne YAPMAZ (bilinçli olarak dokunulmaz):
  //  - domains koleksiyonu silinmez/değiştirilmez (market ve
  //    "satılmış/satışta" durumları, ayrıca totalSpent/totalEarned
  //    hesaplamaları bu koleksiyona bağımlı — silinirse market çöker).
  //  - sell_requests koleksiyonu silinmez (ilan geçmişi/durumu kalır).
  if (action === 'reset_platform_stats') {
    const { confirmReset } = req.body;
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: "Yetki yok" });
    if (confirmReset !== true) {
      return res.status(400).json({ error: "Bu kalıcı bir işlemdir. confirmReset:true parametresi olmadan çalıştırılamaz." });
    }
    try {
      const db = getDb();

      // 1) global_sales — tamamen sil
      const salesSnap = await db.collection('global_sales').get();
      let batch = db.batch();
      let opCount = 0;
      for (const doc of salesSnap.docs) {
        batch.delete(doc.ref);
        opCount++;
        if (opCount >= 450) { await batch.commit(); batch = db.batch(); opCount = 0; }
      }
      if (opCount > 0) await batch.commit();

      // 2) daily_stats — tamamen sil
      const statsSnap = await db.collection('daily_stats').get();
      batch = db.batch();
      opCount = 0;
      for (const doc of statsSnap.docs) {
        batch.delete(doc.ref);
        opCount++;
        if (opCount >= 450) { await batch.commit(); batch = db.batch(); opCount = 0; }
      }
      if (opCount > 0) await batch.commit();

      // 3) user_profiles — points/badge sıfırla
      const profilesSnap = await db.collection('user_profiles').get();
      batch = db.batch();
      opCount = 0;
      for (const doc of profilesSnap.docs) {
        batch.set(doc.ref, { points: 0, badge: null, resetAt: Date.now() }, { merge: true });
        opCount++;
        if (opCount >= 450) { await batch.commit(); batch = db.batch(); opCount = 0; }
      }
      if (opCount > 0) await batch.commit();

      // 4) Reset epoch'u kaydet
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
      // FIX: Silinmiş bir domain ismi de dahil, bu isim hiçbir şekilde
      // yeni bir satış önerisine konu olamaz — aksi halde approve_sell_request
      // eski silinmiş domain'in verisini ezerdi (bkz. add_domain'deki not).
      if (existingDomain.exists) {
        return res.status(400).json({
          error: existingDomain.data().deleted === true
            ? "Bu domain adı daha önce kullanılmış ve silinmiş, tekrar kullanılamaz."
            : "Bu domain zaten markette mevcut"
        });
      }

      // Aynı kullanıcının bekleyen önerisi var mı? (spam koruması)
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

      // Admin'e bildirim
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
      // FIX: submit_sell_request aşamasında zaten engellenmiş olsa da,
      // bu ikinci kontrol (onay anında) bir güvenlik katmanı olarak
      // korunuyor — örn. öneri gönderildikten SONRA admin domain'i
      // silmiş olabilir, bu durumda onay anında yine reddedilmeli.
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

      // Satıcıya bildirim
      await sendNotification(reqData.submittedBy, {
        type: 'sell_request_approved',
        title: '✅ Domain Öneriniz Onaylandı!',
        body: `"${reqData.domainName}" domaininiz markete eklendi. Satışa hazır!`,
        domainName: reqData.domainName
      });

      // Satıcıya puan
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

      // Kullanıcıya bildirim
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

      // Satın alınan domainler — FIX (karar): totalSpent artık global_sales
      // yerine DOĞRUDAN domains koleksiyonundaki "sold:true, buyer:ben"
      // kayıtlarını baz alıyor. Bu, market listesinde "satılmış" olarak
      // görünen gerçek durumla %100 tutarlı olmasını garantiler — iki ayrı
      // koleksiyonun (domains ve global_sales) senkron kalma riskini
      // ortadan kaldırır. global_sales hâlâ "purchases" (satın alma
      // geçmişi/detay listesi) için ayrıca kullanılmaya devam ediyor,
      // ama TOPLAM HARCAMA rakamı artık domains'ten hesaplanıyor.
      const myPurchasedDomainsSnap = await db.collection('domains')
        .where('buyer', '==', realUsername)
        .where('sold', '==', true)
        .get();
      let totalSpent = 0;
      myPurchasedDomainsSnap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return; // silinmiş domain harcamaya dahil edilmez
        totalSpent += Number(data.price || 0);
      });

      const salesSnap = await db.collection('global_sales').where('user', '==', realUsername).get();
      const purchases = [];
      salesSnap.forEach(d => {
        purchases.push(d.data());
      });

      // Satışa sunulan domainler — FIX: Silinmiş (deleted:true) bir
      // domain'e ait HİÇBİR sell_request kaydı "İlanlarım" sekmesinde
      // görünmemeli. Önceki sürümde sadece status==='approved' olan
      // kayıtların domain adı kontrol ediliyordu; ama bir domain önce
      // approve edilip SONRA silinmiş olsa bile teorik olarak doğru
      // çalışmalıydı. Sorunun asıl kaynağı kontrolün KENDİSİ değil,
      // frontend'in bu güncel veriyi hiç tekrar ÇEKMEMESİYDİ (ayrı bir
      // fix ile çözüldü — domains/sell_requests onSnapshot tetikleyince
      // profil otomatik yenileniyor). Burada ekstra bir güvenlik/garanti
      // katmanı olarak: approved OLMASA BİLE, aynı domain adına sahip
      // BAŞKA bir kayıt (örn. tekrar başvuru) varsa ve o domain artık
      // silinmişse, tutarlılık için yine gizlenir.
      const sellReqSnap = await db.collection('sell_requests').where('submittedBy', '==', realUsername).get();
      const sellRequests = [];
      const allDomainNamesInRequests = new Set();
      sellReqSnap.forEach(d => {
        const data = d.data();
        allDomainNamesInRequests.add(data.domainName);
        sellRequests.push({ id: d.id, ...data });
      });

      // Onaylanmış domainlerin şu anki "deleted" durumunu kontrol et
      let deletedDomainNames = new Set();
      if (allDomainNamesInRequests.size > 0) {
        const domainDocs = await Promise.all(
          Array.from(allDomainNamesInRequests).map(name => db.collection('domains').doc(name).get())
        );
        domainDocs.forEach(snap => {
          if (snap.exists && snap.data().deleted === true) deletedDomainNames.add(snap.id);
        });
      }
      // Silinmiş domain'lere ait listeleme kayıtlarını (statüsü ne olursa
      // olsun) çıkar — soft-delete edilen bir domain, kullanıcı tarafında
      // hiç var olmamış gibi davranır.
      const visibleSellRequests = sellRequests.filter(r => !deletedDomainNames.has(r.domainName));

      // Satılan domainlerden gelir (silinmemiş olanlar)
      const domainsSnap = await db.collection('domains')
        .where('sellerUsername', '==', realUsername)
        .where('sold', '==', true)
        .get();
      let totalEarned = 0;
      const soldDomains = [];
      domainsSnap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return; // silinmiş domain'in geliri panelde gösterilmez
        totalEarned += Number(data.price || 0);
        soldDomains.push({ name: d.id, ...data });
      });

      // Şu anda satışta olan (henüz satılmamış, silinmemiş) kendi domainleri
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
      // Tüm satışları topla (toplam hacim için)
      const allSalesSnap = await db.collection('global_sales').get();
      let totalVolume = 0;
      const salesByDomain = {};
      allSalesSnap.forEach(d => {
        const data = d.data();
        totalVolume += Number(data.price || 0);
        salesByDomain[data.domain] = (salesByDomain[data.domain] || 0) + Number(data.price || 0);
      });

      // Kullanıcıların kendi ilan verdiği (sellerUsername var) domain satışları
      const userOwnedDomainsSnap = await db.collection('domains')
        .where('sold', '==', true)
        .get();
      let userOwnedVolume = 0;
      userOwnedDomainsSnap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        if (data.sellerUsername) userOwnedVolume += Number(data.price || 0);
      });

      // Platform kazancı = sellerUsername'i OLMAYAN (admin/sistem tarafından
      // eklenen) domain satışları. Başka kullanıcıların ilan verip satılan
      // domainleri bu hesaba dahil değil.
      const platformEarnings = totalVolume - userOwnedVolume;

      // Admin'in KENDİ satıcı olarak ilan verdiği domainlerden kazancı
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

      // Tüm satış detayları (admin satış istatistikleri için)
      const allSoldDomainsSnap = await db.collection('domains')
        .where('sold', '==', true)
        .get();
      const allSalesDetail = [];
      allSoldDomainsSnap.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        allSalesDetail.push({
          name: d.id,
          price: data.price,
          buyer: data.buyer || null,
          at: data.at || null,
          sellerUsername: data.sellerUsername || null,
          type: data.type || 'genel'
        });
      });
      // En son satışlar önce
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
          // FIX: Bu domain daha önce başka bir kullanıcı tarafından satın
          // alınıp admin tarafından "tekrar satışa çıkarılmış" olabilir.
          // Bu durumda en son alıcıya "X kişisi de bu domaini satın aldı"
          // tarzı bilgilendirme bildirimi gönderiyoruz (rekabet/sosyal kanıt).
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

          // Puan ver
          await updateUserPoints(username, realPrice, 'purchase');

          // Alıcıya bildirim
          await sendNotification(username, {
            type: 'purchase_success',
            title: '🎉 Satın Alma Başarılı!',
            body: `"${domainName}" domainini ${realPrice} Pi karşılığında satın aldınız!`,
            domainName, txid
          });

          // Admin'e bildirim
          await sendNotificationToAdmin({
            type: 'new_sale',
            title: '💰 Yeni Satış!',
            body: `@${username} tarafından "${domainName}" ${realPrice} Pi'ye satıldı.`,
            domainName, buyer: username, price: realPrice
          });

          // Eğer domain bir kullanıcıya aitse (satıcı varsa) ona da bildirim
          if (sellerUsername && sellerUsername !== username) {
            await sendNotification(sellerUsername, {
              type: 'your_domain_sold',
              title: '🏆 Domaininiz Satıldı!',
              body: `"${domainName}" domaininiz @${username} tarafından ${realPrice} Pi'ye satın alındı!`,
              domainName, buyer: username, price: realPrice
            });
          }

          // FIX: Domain daha önce relist edilip yeniden satıldıysa, eski
          // alıcıya "yerine biri aldı" bilgisi gönder (sadece yeni alıcı
          // farklıysa ve eski alıcı kaydı varsa).
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
