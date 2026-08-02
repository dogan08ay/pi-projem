// ══════════════════════════════════════════════════════════════════════════
//  TELEGRAM WEBHOOK — Kullanıcı Telegram Hesabı Bağlama
//
//  NE İŞE YARAR:
//  Kullanıcı uygulamada "Telegram Bildirimlerini Bağla" dediğinde
//  (approve.js → action:'link_telegram_start'), kendisine özel, tek
//  kullanımlık bir kod üretilip https://t.me/BOTUNUZ?start=KOD linkine
//  yönlendirilir. Kullanıcı Telegram'da botu bu linkle açtığında, Telegram
//  botunuza otomatik olarak "/start KOD" mesajını gönderir — işte o mesajı
//  BURASI karşılar: kodu doğrular, kullanıcının Telegram chat_id'sini onun
//  app profiline (user_profiles/{username}.telegramChatId) kaydeder.
//  Bundan sonra approve.js'teki sendNotification() fonksiyonu, bu kullanıcıya
//  giden her bildirimi otomatik olarak Telegram'dan da gönderir.
//
//  KURULUM (bir kere yapılır):
//  1) Bu dosyayı approve.js ile aynı şekilde deploy edin (örn. Vercel'de
//     /api/telegram-webhook.js).
//  2) Ortam değişkenlerine TG_WEBHOOK_SECRET adında rastgele, uzun bir gizli
//     anahtar ekleyin (örn. 32 karakterlik rastgele bir string).
//  3) Deploy sonrası, tarayıcınızdan (sadece BİR KERE) şu URL'yi ziyaret
//     edin — kendi TG_BOT_TOKEN, sitenizin adresi ve TG_WEBHOOK_SECRET
//     değerlerinizi yerine koyarak:
//
//     https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=https://<SITENIZ>/api/telegram-webhook&secret_token=<TG_WEBHOOK_SECRET>
//
//     Dönen yanıtta "ok":true görürseniz kurulum tamamdır. Bunu tekrar
//     yapmanıza gerek yok (bot token'ı ya da webhook adresi değişmediği
//     sürece).
// ══════════════════════════════════════════════════════════════════════════

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ─── Firebase Admin Kurulumu (approve.js ile birebir aynı desen) ─────────
function getAdminApp() {
  if (getApps().length > 0) return getApps()[0];
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
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}
function getDb() { getAdminApp(); return getFirestore(); }

// ─── Telegram Yardımcısı (approve.js'teki sendTG ile aynı) ────────────────
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET;

async function sendTG(chatId, text) {
  if (!TG_BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
  } catch (e) {
    console.error("[Telegram Webhook] sendTG hatası:", e.message || e);
  }
}

// Bağlama kodları 10 dakika geçerli — link_telegram_start'ta üretilen koda
// eşleşiyor olmalı (approve.js).
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Sadece POST kabul edilir" });

  // ── GÜVENLİK: Bu endpoint'e SADECE Telegram'ın kendisi istek atabilmeli.
  // setWebhook'a secret_token verildiyse, Telegram her istekte bu header'ı
  // ekliyor. Eşleşmiyorsa, bu Telegram'dan gelen gerçek bir istek değildir
  // (biri rastgele bu URL'yi bulup sahte "/start KOD" mesajları göndermeye
  // çalışıyor olabilir) — reddediyoruz.
  if (TG_WEBHOOK_SECRET) {
    const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (incomingSecret !== TG_WEBHOOK_SECRET) {
      console.error('[Telegram Webhook] Geçersiz secret_token ile istek — reddedildi.');
      return res.status(401).json({ error: "unauthorized" });
    }
  } else {
    // TG_WEBHOOK_SECRET tanımlanmamışsa endpoint teorik olarak herkese açık
    // demektir — bunu loglarda görünür kılıyoruz ki kurulum eksik unutulmasın.
    console.error('[Telegram Webhook UYARI] TG_WEBHOOK_SECRET tanımlı değil — webhook doğrulamasız çalışıyor. Ortam değişkenlerine eklemeniz önerilir.');
  }

  // Telegram, cevap gecikirse aynı güncellemeyi TEKRAR gönderebilir. Bu
  // yüzden içeride ne olursa olsun (hata dahil) Telegram'a hızlıca 200
  // dönüyoruz — aksi halde hatalı bir mesaj sonsuza kadar tekrar tekrar
  // gönderilip loglarınızı doldurabilir.
  try {
    const update = req.body;
    const message = update?.message;
    const chatId = message?.chat?.id;
    const text = (message?.text || '').trim();

    if (!chatId || !text) {
      return res.status(200).json({ ok: true }); // ilgilenmediğimiz bir güncelleme türü (ör. düzenlenen mesaj)
    }

    const db = getDb();

    // "/start KOD" formatını işliyoruz. Telegram derin linkleri (deep link)
    // botu "/start <parametre>" mesajıyla açar.
    const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/i);
    if (startMatch) {
      const code = (startMatch[1] || '').toUpperCase();
      if (!code) {
        await sendTG(chatId, "👋 Merhaba! Telegram bildirimlerini bağlamak için lütfen uygulama içinden \"Telegram Bildirimlerini Bağla\" butonuna basıp açılan linki kullanın.");
        return res.status(200).json({ ok: true });
      }

      const codeRef = db.collection('telegram_link_codes').doc(code);
      const codeSnap = await codeRef.get();
      if (!codeSnap.exists) {
        await sendTG(chatId, "❌ Bu bağlantı kodu geçersiz ya da daha önce kullanılmış. Lütfen uygulamadan yeni bir bağlantı linki oluşturun.");
        return res.status(200).json({ ok: true });
      }
      const codeData = codeSnap.data();
      if (!codeData.createdAt || Date.now() - codeData.createdAt > LINK_CODE_TTL_MS) {
        await codeRef.delete().catch(() => {});
        await sendTG(chatId, "⏱️ Bu bağlantı kodunun süresi dolmuş. Lütfen uygulamadan yeni bir bağlantı linki oluşturun.");
        return res.status(200).json({ ok: true });
      }

      const username = codeData.username;
      if (!username) {
        await codeRef.delete().catch(() => {});
        await sendTG(chatId, "❌ Bir sorun oluştu, lütfen uygulamadan tekrar deneyin.");
        return res.status(200).json({ ok: true });
      }

      await db.collection('user_profiles').doc(username).set({
        telegramChatId: chatId,
        telegramLinkedAt: Date.now()
      }, { merge: true });
      await codeRef.delete().catch(() => {});

      await sendTG(chatId, `✅ Telegram bağlandı! Artık @${username} hesabınıza ait satış, teklif ve escrow bildirimleri buraya da gelecek.\n\nBağlantıyı istediğiniz zaman uygulama içinden kaldırabilirsiniz.`);
      console.log(`[Telegram Webhook] @${username} → chatId:${chatId} bağlandı.`);
      return res.status(200).json({ ok: true });
    }

    // Tanımadığımız herhangi bir mesaj — kısa bir yönlendirme yapıyoruz.
    await sendTG(chatId, "Bu bot sadece bildirim bağlama için kullanılıyor. Uygulama içinden \"Telegram Bildirimlerini Bağla\" diyerek buraya yönlendirilebilirsiniz.");
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[Telegram Webhook] Beklenmeyen hata:", e.message || e);
    return res.status(200).json({ ok: true }); // Telegram'ın tekrar tekrar denemesini önlemek için yine de 200
  }
}
