/**
 * api/approve.js  —  Güvenli sunucu tarafı API
 *
 * Vercel / Next.js API Route olarak kullanılır.
 * Tüm kritik işlemler (Pi token doğrulama, admin yetkisi,
 * Firestore yazma) SADECE burada yapılır — client'tan asla doğrudan.
 *
 * Gerekli environment variable'lar (.env dosyasında):
 *   PI_API_KEY          — Pi Developer Portal'dan alınan API key
 *   ADMIN_USERNAME      — Admin Pi kullanıcı adı (doganay0808)
 *   FIREBASE_PROJECT_ID — Firebase proje ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// ── Firebase Admin başlatma (singleton) ───────────────────────────
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}
const db = getFirestore();

// ── Pi token doğrulama ─────────────────────────────────────────────
async function verifyPiToken(accessToken) {
  if (!accessToken) throw new Error("Access token eksik");

  const res = await fetch("https://api.minepi.com/v2/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) throw new Error(`Pi token geçersiz (${res.status})`);

  const data = await res.json();
  // Sandbox modda uid "test_..." ile başlar
  if (!data.uid || !data.username) throw new Error("Pi kullanıcı bilgisi alınamadı");

  return data; // { uid, username }
}

// ── Rate limiting (basit in-memory, production'da Redis kullan) ────
const rateLimitMap = new Map();
function checkRateLimit(ip, action, maxPerMinute = 20) {
  const key  = `${ip}:${action}`;
  const now  = Date.now();
  const prev = rateLimitMap.get(key) || [];
  const recent = prev.filter(t => now - t < 60_000);
  if (recent.length >= maxPerMinute) throw new Error("Çok fazla istek. Bir dakika bekleyin.");
  recent.push(now);
  rateLimitMap.set(key, recent);
}

// ── Input sanitization ─────────────────────────────────────────────
function sanitizeString(str, maxLen = 200) {
  if (typeof str !== "string") throw new Error("Geçersiz girdi");
  const s = str.trim().slice(0, maxLen);
  // Sadece izin verilen karakterler (domain adı, yol vb.)
  if (/[<>"']/.test(s)) throw new Error("Geçersiz karakter");
  return s;
}

function sanitizeDomainName(name) {
  const s = sanitizeString(name, 100);
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) throw new Error("Geçersiz domain adı");
  return s;
}

function sanitizePrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new Error("Geçersiz fiyat");
  return n;
}

// ── Ana handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — sadece kendi domain'inden gelen isteklere izin ver
  const allowedOrigins = [
    process.env.NEXT_PUBLIC_SITE_URL || "",
    "https://web3-domain-gateway.vercel.app", // production URL
  ].filter(Boolean);

  const origin = req.headers.origin || "";
  if (allowedOrigins.length && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "Yetkisiz kaynak" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
  const { action, accessToken } = req.body || {};

  try {
    // Genel rate limit
    checkRateLimit(ip, action || "unknown");

    switch (action) {

      // ── Ödeme onayı (Pi → server) ────────────────────────────────
      case "approve": {
        const { paymentId } = req.body;
        if (!paymentId) throw new Error("paymentId eksik");

        // Pi SDK ödemeyi doğrula
        const piRes = await fetch(
          `https://api.minepi.com/v2/payments/${paymentId}/approve`,
          {
            method: "POST",
            headers: {
              Authorization: `Key ${process.env.PI_API_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );
        if (!piRes.ok) throw new Error(`Pi approve başarısız (${piRes.status})`);
        return res.json({ success: true });
      }

      // ── Ödeme tamamlama ──────────────────────────────────────────
      case "complete": {
        const { paymentId, txid, username, domainName } = req.body;
        if (!paymentId || !txid || !username || !domainName) throw new Error("Eksik parametre");

        // Pi'den ödemeyi çek ve doğrula
        const piRes = await fetch(
          `https://api.minepi.com/v2/payments/${paymentId}/complete`,
          {
            method: "POST",
            headers: {
              Authorization: `Key ${process.env.PI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ txid }),
          }
        );
        if (!piRes.ok) throw new Error(`Pi complete başarısız (${piRes.status})`);
        const piPayment = await piRes.json();

        // Güvenlik: ödeme tutarı ve domain adı eşleşiyor mu?
        const domainRef  = db.collection("domains").doc(domainName);
        const domainSnap = await domainRef.get();
        if (!domainSnap.exists) throw new Error("Domain bulunamadı");
        const domainDoc = domainSnap.data();

        if (domainDoc.sold) throw new Error("Bu domain zaten satılmış");
        if (Math.abs(piPayment.amount - domainDoc.price) > 0.001) {
          throw new Error(`Fiyat uyuşmuyor: beklenen ${domainDoc.price}, ödenen ${piPayment.amount}`);
        }

        // Atomik güncelleme
        const today = new Date().toISOString().split("T")[0];
        const batch = db.batch();

        batch.update(domainRef, {
          sold:  true,
          buyer: username,
          txid:  txid,
          at:    Date.now(),
          price: domainDoc.price,
        });

        const statsRef = db.collection("daily_stats").doc(today);
        batch.set(statsRef, {
          count:  FieldValue.increment(1),
          volume: FieldValue.increment(domainDoc.price),
        }, { merge: true });

        await batch.commit();
        return res.json({ success: true });
      }

      // ── Aktif kullanıcı sayısı (public, token gerekmez) ──────────
      case "active_count": {
        const now = Date.now();
        const snap = await db.collection("active_users").get();
        let count = 0;
        snap.forEach(d => { if (d.data().lastSeen && (now - d.data().lastSeen) < 30000) count++; });
        return res.json({ count });
      }

      // ── Login doğrulama + admin kontrolü ────────────────────────
      case "login": {
        const piUser = await verifyPiToken(accessToken);
        const isAdmin = piUser.username === process.env.ADMIN_USERNAME;
        // Kullanıcı adı client'tan değil, token'dan okundu — güvenli
        return res.json({ success: true, isAdmin, username: piUser.username });
      }

      // ── Login log + first-seen hesaplama ─────────────────────────
      case "log_login": {
        const piUser = await verifyPiToken(accessToken);
        const today  = new Date().toISOString().split("T")[0];

        // Günlük login log
        const dailyRef = db.collection("daily_users").doc(today);
        await dailyRef.set({
          users: { [piUser.username]: Date.now() }
        }, { merge: true });

        // Active users
        await db.collection("active_users").doc(piUser.username).set({
          lastSeen: Date.now(),
          username: piUser.username,
        }, { merge: true });

        // First-seen: tüm kayıtlarda en eski timestamp
        const allDays = await db.collection("daily_users").get();
        let firstSeen = Date.now();
        allDays.forEach(d => {
          const u = d.data().users || {};
          if (u[piUser.username] && u[piUser.username] < firstSeen)
            firstSeen = u[piUser.username];
        });

        return res.json({ success: true, firstSeen });
      }

      // ── Aktif kullanıcı heartbeat ─────────────────────────────────
      case "heartbeat": {
        const piUser = await verifyPiToken(accessToken);
        await db.collection("active_users").doc(piUser.username).set({
          lastSeen: Date.now(),
        }, { merge: true });
        return res.json({ success: true });
      }

      // ── Logout (active_users temizle) ─────────────────────────────
      case "logout": {
        const piUser = await verifyPiToken(accessToken);
        await db.collection("active_users").doc(piUser.username).delete();
        return res.json({ success: true });
      }

      // ── İptal ────────────────────────────────────────────────────
      case "cancel": {
        const { paymentId } = req.body;
        if (!paymentId) throw new Error("paymentId eksik");
        // Sadece logla, Pi tarafında zaten cancel olur
        console.warn("Ödeme iptal edildi:", paymentId);
        return res.json({ success: true });
      }

      // ── Domain satış isteği gönder ───────────────────────────────
      case "submit_sell_request": {
        checkRateLimit(ip, "submit_sell_request", 5); // Dakikada max 5

        // Kullanıcıyı Pi token ile doğrula
        const piUser = await verifyPiToken(accessToken);

        const domainName  = sanitizeDomainName(req.body.domainName);
        const price       = sanitizePrice(req.body.price);
        const domainType  = sanitizeString(req.body.domainType || "genel", 20);
        const imgPath     = sanitizeString(req.body.imgPath || "assets/default.jpeg", 200);
        const sellerWallet = sanitizeString(req.body.sellerWallet || "", 100);

        // Aynı domain zaten var mı?
        const existing = await db.collection("domains").doc(domainName).get();
        if (existing.exists) throw new Error("Bu domain adı zaten kayıtlı");

        // Bekleyen istek var mı?
        const pendingSnap = await db.collection("sell_requests")
          .where("domainName", "==", domainName)
          .where("status", "==", "pending")
          .get();
        if (!pendingSnap.empty) throw new Error("Bu domain için zaten bekleyen bir istek var");

        await db.collection("sell_requests").add({
          domainName,
          price,
          domainType,
          imgPath,
          sellerWallet,
          submittedBy:  piUser.username,
          submittedUid: piUser.uid,      // username yerine uid'i de sakla
          submittedAt:  Date.now(),
          status:       "pending",
        });

        return res.json({ success: true });
      }

      // ── ─── ADMIN İŞLEMLERİ ─────────────────────────────────────
      // Tüm admin işlemlerinde: Pi token doğrula → username sunucuda karşılaştır
      // Admin username client'tan asla güvenilmez; token'dan okunur.

      case "approve_sell_request":
      case "reject_sell_request":
      case "relist":
      case "delete_domain":
      case "update_price":
      case "add_domain": {
        checkRateLimit(ip, "admin_action", 30);

        // Pi token ile kim olduğunu sunucuda doğrula
        const piUser = await verifyPiToken(accessToken);

        // Admin kontrolü — username env'den okunur, client'tan değil
        const adminUsername = process.env.ADMIN_USERNAME;
        if (!adminUsername) throw new Error("Sunucu yapılandırma hatası");
        if (piUser.username !== adminUsername) {
          // Yetkisiz erişim girişimini logla
          console.error(`Yetkisiz admin erişimi: @${piUser.username} (${ip})`);
          return res.status(403).json({ error: "Yetkisiz erişim" });
        }

        // Admin işlemleri
        if (action === "approve_sell_request") {
          const { requestId } = req.body;
          if (!requestId) throw new Error("requestId eksik");

          const reqRef  = db.collection("sell_requests").doc(requestId);
          const reqSnap = await reqRef.get();
          if (!reqSnap.exists) throw new Error("İstek bulunamadı");
          const reqData = reqSnap.data();
          if (reqData.status !== "pending") throw new Error("İstek zaten işlenmiş");

          const batch = db.batch();
          batch.update(reqRef, { status: "approved", approvedAt: Date.now(), approvedBy: piUser.username });
          batch.set(db.collection("domains").doc(reqData.domainName), {
            price:     reqData.price,
            img:       reqData.imgPath,
            type:      reqData.domainType,
            sold:      false,
            createdAt: Date.now(),
            addedBy:   reqData.submittedBy,
          });
          await batch.commit();
          return res.json({ success: true });
        }

        if (action === "reject_sell_request") {
          const { requestId } = req.body;
          if (!requestId) throw new Error("requestId eksik");
          const reqRef = db.collection("sell_requests").doc(requestId);
          const reqSnap = await reqRef.get();
          if (!reqSnap.exists || reqSnap.data().status !== "pending") throw new Error("İstek bulunamadı veya zaten işlenmiş");
          await reqRef.update({ status: "rejected", rejectedAt: Date.now(), rejectedBy: piUser.username });
          return res.json({ success: true });
        }

        if (action === "relist") {
          const domainName = sanitizeDomainName(req.body.domainName);
          const domainRef  = db.collection("domains").doc(domainName);
          const domainSnap = await domainRef.get();
          if (!domainSnap.exists) throw new Error("Domain bulunamadı");

          const domainData = domainSnap.data();
          if (!domainData.sold) throw new Error("Domain zaten satışta");

          // Satış istatistiklerinden düş
          const today    = new Date().toISOString().split("T")[0];
          const batch    = db.batch();
          batch.update(domainRef, {
            sold:  false,
            buyer: FieldValue.delete(),
            txid:  FieldValue.delete(),
            at:    FieldValue.delete(),
          });
          const statsRef = db.collection("daily_stats").doc(today);
          batch.set(statsRef, {
            count:  FieldValue.increment(-1),
            volume: FieldValue.increment(-domainData.price),
          }, { merge: true });
          await batch.commit();
          return res.json({ success: true });
        }

        if (action === "delete_domain") {
          const domainName = sanitizeDomainName(req.body.domainName);
          const domainRef  = db.collection("domains").doc(domainName);
          const domainSnap = await domainRef.get();
          if (!domainSnap.exists) throw new Error("Domain bulunamadı");
          if (domainSnap.data().sold) throw new Error("Satılmış domain silinemez");
          await domainRef.delete();
          return res.json({ success: true });
        }

        if (action === "update_price") {
          const domainName = sanitizeDomainName(req.body.domainName);
          const newPrice   = sanitizePrice(req.body.newPrice);
          const domainRef  = db.collection("domains").doc(domainName);
          const domainSnap = await domainRef.get();
          if (!domainSnap.exists) throw new Error("Domain bulunamadı");
          if (domainSnap.data().sold) throw new Error("Satılmış domain fiyatı değiştirilemez");
          await domainRef.update({ price: newPrice, priceUpdatedAt: Date.now(), priceUpdatedBy: piUser.username });
          return res.json({ success: true });
        }

        if (action === "add_domain") {
          const domainName = sanitizeDomainName(req.body.domainName);
          const newPrice   = sanitizePrice(req.body.newPrice);
          const imgPath    = sanitizeString(req.body.imgPath || "assets/default.jpeg", 200);
          const domainType = sanitizeString(req.body.domainType || "genel", 20);

          const existing = await db.collection("domains").doc(domainName).get();
          if (existing.exists) throw new Error("Bu domain zaten mevcut");

          await db.collection("domains").doc(domainName).set({
            price:     newPrice,
            img:       imgPath,
            type:      domainType,
            sold:      false,
            createdAt: Date.now(),
            addedBy:   piUser.username,
          });
          return res.json({ success: true });
        }

        break;
      }

      default:
        return res.status(400).json({ error: "Geçersiz işlem" });
    }
  } catch (err) {
    console.error(`[${action}] Hata:`, err.message);
    // Kullanıcıya stack trace gösterme
    return res.status(400).json({ success: false, error: err.message });
  }
}
