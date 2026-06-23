import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// --- Firebase Admin SDK kurulumu ---
// FIREBASE_SERVICE_ACCOUNT env variable'ı, Firebase Console > Project Settings >
// Service Accounts > Generate new private key ile indirilen JSON dosyasının
// TAMAMININ (tek satır JSON string olarak) içeriğidir.
function getDb() {
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

// Domain fiyatları artık burada sabit DEĞİL. Firestore'daki 'domains'
// koleksiyonunun her belgesindeki 'price' alanından okunuyor. Bu sayede
// admin panelinden fiyat güncellendiğinde kod değişmeden yansır.
// Yeni bir domain için minimum varsayılan değerler (sadece domain hiç
// Firestore'da yoksa, ilk defa admin panelinden ekleninceye kadar kullanılır):
const KNOWN_DOMAIN_NAMES = [
  'test-domain', 'etstur.pi', 'eminevim.pi', 'fuzulev.pi',
  'fibabank.pi', 'sekerbank.pi', 'doganay.pi'
];

// Firestore'dan bir domain'in güncel/gerçek fiyatını okur.
// Domain Firestore'da yoksa null döner (geçersiz domain anlamına gelir).
async function getRealPrice(db, domainName) {
  const snap = await db.collection('domains').doc(domainName).get();
  if (!snap.exists) return null;
  const price = snap.data().price;
  return typeof price === 'number' ? price : null;
}

// --- GERÇEK admin doğrulaması ---
// Frontend'in gönderdiği bir 'adminUsername' string'ine güvenmek güvensizdir
// (sahte istekle taklit edilebilir). Bunun yerine, Pi.authenticate()'ten gelen
// accessToken'ı Pi'nin kendi /v2/me endpoint'ine soruyoruz. Pi, token geçerliyse
// gerçek kullanıcı adını döner; token sahteyse 401 ile reddeder. Böylece
// "doganay0808" olduğunu iddia eden biri, gerçekten o hesaba ait geçerli bir
// Pi access token'ı olmadan asla admin işlemi yapamaz.
async function verifyAdmin(accessToken) {
  if (!accessToken) return false;
  try {
    const response = await fetch('https://api.minepi.com/v2/me', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!response.ok) return false;
    const userDto = await response.json();
    return userDto.username === 'doganay0808';
  } catch (e) {
    console.error("Pi /v2/me doğrulama hatası:", e);
    return false;
  }
}

export default async function handler(req, res) {
  // --- CORS: artık '*' değil, izin verilen origin'den geliyor ---
  // Vercel panelinden bir ortam değişkeni ekleyin:
  //   ALLOWED_ORIGIN = https://pi-projem.vercel.app
  // Birden fazla origin'e izin vermek isterseniz virgülle ayırarak yazabilirsiniz:
  //   ALLOWED_ORIGIN = https://pi-projem.vercel.app,https://www.pi-projem.vercel.app
  const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  const requestOrigin = req.headers.origin;
  if (allowedOrigins.length === 0) {
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: "Sadece POST kabul edilir" });

  const { paymentId, action, txid, username, domainName, accessToken } = req.body;

  if (!action) {
    return res.status(400).json({ error: "action zorunludur" });
  }

  // --- 'relist' (tekrar satılık yapma) action'ı, Pi ödeme akışından tamamen
  // ayrı çalışır - paymentId gerektirmez, Pi API'sine hiç gitmez. Sadece
  // Firestore üzerinde işlem yapar ve SADECE admin tarafından çağrılabilir.
  if (action === 'relist') {
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) {
      console.warn("Yetkisiz relist denemesi, domain:", domainName);
      return res.status(403).json({ error: "Bu işlem için yetkiniz yok" });
    }
    if (!domainName) {
      return res.status(400).json({ error: "Geçersiz domain adı" });
    }

    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(domainName);
      const domainSnap = await domainRef.get();

      if (!domainSnap.exists || domainSnap.data().sold !== true) {
        return res.status(400).json({ error: "Bu domain zaten satılık durumda" });
      }

      const soldData = domainSnap.data();
      const soldPrice = Number(soldData.price || 0);
      const soldAt = soldData.at;

      // Domain'i tekrar satılık yap (sold:false), fiyatı OLDUĞU GİBİ bırak
      // (admin daha sonra ayrıca fiyat güncelleme formundan değiştirebilir),
      // satış bilgilerini temizle.
      await domainRef.set({
        sold: false,
        txid: null,
        buyer: null,
        at: null
      }, { merge: true });

      // Not: Sayfanın üstündeki "Satılan Domain" ve "Toplam Hacim" (stats-bar)
      // zaten domains koleksiyonundan canlı olarak hesaplanıyor (sold:true olan
      // domainleri sayıp topluyor). Domain'i sold:false yapmak bu toplamı
      // otomatik olarak düşürür, ekstra bir işlem gerekmez.

      // Eğer domain BUGÜN satılmışsa, günlük istatistikten de düş
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

      console.log(`Domain tekrar satılık yapıldı: ${domainName}`);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("Relist hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // --- 'update_price': Admin bir domain'in fiyatını güncellemek istediğinde.
  // Pi ödeme akışıyla ilgisi yok, sadece Firestore'da fiyatı değiştirir.
  if (action === 'update_price') {
    const { domainName: dName, newPrice } = req.body;
    const isAdminUP = await verifyAdmin(accessToken);
    if (!isAdminUP) {
      console.warn("Yetkisiz fiyat güncelleme denemesi, domain:", dName);
      return res.status(403).json({ error: "Bu işlem için yetkiniz yok" });
    }
    const priceNum = Number(newPrice);
    if (!dName || !priceNum || priceNum <= 0) {
      return res.status(400).json({ error: "Geçersiz domain adı veya fiyat" });
    }
    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(dName);
      const domainSnap = await domainRef.get();
      if (!domainSnap.exists) {
        return res.status(404).json({ error: "Domain bulunamadı" });
      }
      if (domainSnap.data().sold === true) {
        return res.status(400).json({ error: "Satılmış bir domain'in fiyatı değiştirilemez. Önce tekrar satılık yapın." });
      }
      await domainRef.set({ price: priceNum }, { merge: true });
      console.log(`Fiyat güncellendi: ${dName} -> ${priceNum} Pi`);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("Fiyat güncelleme hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // --- 'add_domain': Admin yeni bir domain eklemek istediğinde.
  if (action === 'add_domain') {
    const { domainName: newName, newPrice: newP, imgPath } = req.body;
    const isAdminAD = await verifyAdmin(accessToken);
    if (!isAdminAD) {
      console.warn("Yetkisiz domain ekleme denemesi, domain:", newName);
      return res.status(403).json({ error: "Bu işlem için yetkiniz yok" });
    }
    const priceNum2 = Number(newP);
    if (!newName || !priceNum2 || priceNum2 <= 0) {
      return res.status(400).json({ error: "Geçersiz domain adı veya fiyat" });
    }
    try {
      const db = getDb();
      const domainRef = db.collection('domains').doc(newName);
      const existing = await domainRef.get();
      if (existing.exists) {
        return res.status(400).json({ error: "Bu domain adı zaten kayıtlı" });
      }
      await domainRef.set({
        sold: false,
        price: priceNum2,
        img: imgPath || 'assets/default.jpeg',
        txid: null,
        buyer: null,
        at: null
      });
      console.log(`Yeni domain eklendi: ${newName} (${priceNum2} Pi)`);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("Domain ekleme hatası:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (!paymentId) {
    return res.status(400).json({ error: "paymentId zorunludur" });
  }

  const allowedActions = ['approve', 'complete', 'cancel'];
  if (!allowedActions.includes(action)) {
    return res.status(400).json({ error: "Geçersiz action" });
  }

  const PI_API_KEY = process.env.APP_SECRET;
  const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
  const TG_CHAT_ID = process.env.TG_CHAT_ID;
  const TG_GROUP_ID = process.env.TG_GROUP_ID;

  const sendTG = async (chatId, text) => {
    if (!TG_BOT_TOKEN || !chatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
      });
    } catch (e) { console.error("TG Error:", e); }
  };

  // 'cancel' işleminde Pi API'si genelde body beklemez/txid almaz;
  // sadece complete işleminde txid göndermek daha doğru.
  const body = action === 'complete' ? { txid } : {};

  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    let data;
    try {
      data = await response.json();
    } catch (e) {
      data = {};
    }

    if (!response.ok) {
      console.error("Pi API hatası:", action, paymentId, data);
      return res.status(response.status).json({ error: "Pi API hatası", details: data });
    }

    if (action === 'complete') {
      // --- Domain satışını Firestore'a SADECE burada (backend'de) yazıyoruz. ---
      // Frontend artık 'domains' koleksiyonuna doğrudan yazamıyor (Firestore
      // kuralında kapatıldı). Fiyat da client'tan gelen 'amount' ile değil,
      // Firestore'daki domain belgesinin GÜNCEL 'price' alanından okunuyor.
      // Bu, fiyat manipülasyonunu engellerken admin'in fiyatları Firestore
      // üzerinden (admin panelinden) güncelleyebilmesini de sağlar.
      let purchaseCode = null;
      if (domainName && username) {
        try {
          const db = getDb();
          const domainRef = db.collection('domains').doc(domainName);
          const domainSnap = await domainRef.get();
          const realPrice = domainSnap.exists ? domainSnap.data().price : null;

          if (typeof realPrice !== 'number') {
            console.error("Domain Firestore'da bulunamadı veya fiyatı geçersiz:", domainName);
            return res.status(400).json({ error: "Geçersiz domain" });
          }

          purchaseCode = "WEB3-" + Math.random().toString(36).substr(2, 6).toUpperCase();

          // Domain zaten satılmışsa (başka biri araya girmişse) ikinci kez satma
          if (domainSnap.data().sold !== true) {
            await domainRef.set({
              sold: true,
              price: realPrice,
              txid: txid || null,
              buyer: username,
              at: Date.now()
            }, { merge: true });

            await db.collection('global_sales').doc(txid || paymentId).set({
              user: username,
              domain: domainName,
              price: realPrice,
              at: Date.now()
            });

            // Admin panelinde "bugün X domain satıldı, Y Pi hacim" gösterebilmek
            // için günlük istatistikleri biriktiriyoruz. increment() kullanmak,
            // aynı anda birden fazla satış olsa bile sayının doğru toplanmasını
            // garanti eder (race condition oluşmaz).
            const today = new Date().toISOString().split('T')[0];
            await db.collection('daily_stats').doc(today).set({
              count: FieldValue.increment(1),
              volume: FieldValue.increment(realPrice)
            }, { merge: true });

            const groupMsg = `🎉 *YENİ SATIŞ!*\n\n👤 @${username}, *${domainName}* domainini başarıyla satın aldı! 🚀\n\n🌐 Sitemize hoş geldin yeni sahibi!`;
            await sendTG(TG_GROUP_ID, groupMsg);

            const adminMsg = `✅ *SATIŞ TAMAMLANDI*\n\n👤 *Alıcı:* @${username}\n🌐 *Domain:* ${domainName}\n💰 *Tutar:* ${realPrice} Pi\n🔑 *Üretilen Şifre:* \`${purchaseCode}\``;
            await sendTG(TG_CHAT_ID, adminMsg);
          } else {
            console.warn("Domain zaten satılmış, tekrar yazılmadı:", domainName);
          }
        } catch (firestoreErr) {
          console.error("Firestore yazma hatası:", firestoreErr);
          // Ödeme Pi tarafında tamamlandı ama Firestore yazımı başarısız oldu.
          // Bunu mutlaka loglayıp manuel kontrol edin (admin Telegram'a da bildirelim).
          await sendTG(TG_CHAT_ID, `⚠️ *DİKKAT:* Ödeme tamamlandı (txid: ${txid}) ama Firestore'a yazılamadı. Domain: ${domainName}, Kullanıcı: @${username}. Manuel kontrol edin.`);
        }
      }

      return res.status(200).json({ ...data, purchaseCode, success: true });
    }

    // approve ve cancel için sade dönüş
    return res.status(200).json({ ...data, success: true });
  } catch (e) {
    console.error("Sunucu hatası:", e);
    return res.status(500).json({ error: e.message });
  }
}
