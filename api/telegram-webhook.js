// telegram-webhook.js
//
// BU DOSYA /api/telegram-webhook.js OLARAK (approve.js İLE AYNI KLASÖRE)
// YÜKLENMELİDİR.
//
// NEDEN GEREKLİ: Uygulama, "Telegram Bağla" butonuna basılınca bir bağlama
// kodu üretip (approve.js -> action:'link_telegram_start') kullanıcıyı
// Telegram botuna yönlendiriyordu. Ama kullanıcı bottan "Başlat"a bastığında
// Telegram'ın gönderdiği o mesajı YAKALAYIP hesaba bağlayacak hiçbir kod
// yoktu — yani döngü hiç tamamlanmıyordu, kullanıcı ne yaparsa yapsın
// uygulamada hep "Bağla" görünmeye devam ediyordu. Bu dosya tam olarak o
// eksik parça: Telegram'ın "/start KOD" mesajını alıp, kodu doğrulayıp,
// kullanıcının hesabına telegramChatId'yi yazan bir webhook.
//
// KURULUM (bir kere yapılır):
//   1) Bu dosyayı /api/telegram-webhook.js olarak deploy edin.
//   2) Tarayıcıda şu adresi ziyaret edin (KENDİ bot token'ınızı ve
//      alan adınızı yazarak):
//      https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=https://<SIZIN-ALAN-ADINIZ>/api/telegram-webhook
//      Dönen cevapta "ok":true görürseniz kurulum tamamdır.
//   3) Test edin: uygulamada Telegram Bağla'ya basın, botta Başlat'a basın,
//      bot size "✅ Bağlandı" mesajı göndermeli ve uygulamaya dönünce
//      buton "Bağlantıyı Kes" olarak görünmeli.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
// Bir bağlama kodu ne kadar süre geçerli sayılsın — bu süreden eski bir
// kod artık kullanılamaz (kullanıcı "Bağla"ya tekrar basıp yeni kod
// almalı). link_telegram_start action'ındaki kod üretiminden bağımsız,
// sadece burada (tüketim anında) kontrol ediliyor.
const CODE_TTL_MS = 15 * 60 * 1000; // 15 dakika

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

async function sendTG(chatId, text) {
  if (!TG_BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
  } catch (e) {
    console.error('[telegram-webhook] sendTG hatası:', e.message || e);
  }
}

export default async function handler(req, res) {
  // Telegram, webhook'un HER ZAMAN hızlıca 200 dönmesini bekler — aksi
  // halde aynı güncellemeyi tekrar tekrar dener. Bu yüzden aşağıdaki tüm
  // dallar (hata dahil) 200 ile bitiyor; hatalar sadece loglanıyor.
  if (req.method !== 'POST') { res.status(200).json({ ok: true }); return; }

  try {
    const update = req.body || {};
    const message = update.message;
    if (!message || !message.text || !message.chat || !message.chat.id) {
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = message.chat.id;
    const text = String(message.text).trim();

    // Sadece "/start" veya "/start KOD" ile ilgileniyoruz; botun aldığı
    // diğer her türlü mesajı (serbest metin, diğer komutlar) sessizce
    // yok sayıyoruz — bu bot bir sohbet botu değil, sadece hesap
    // bağlama aracı.
    if (!text.startsWith('/start')) {
      res.status(200).json({ ok: true });
      return;
    }

    const parts = text.split(/\s+/);
    const code = parts[1] || null;

    if (!code) {
      await sendTG(chatId, '👋 Merhaba! Hesabınızı bağlamak için lütfen Web3 Domain Gateway uygulamasında *Profil Ayarları → Bildirim Tercihleri* bölümünden "Telegram Bağla" butonuna basın — sizi otomatik olarak doğru bağlantı koduyla buraya yönlendirecek.');
      res.status(200).json({ ok: true });
      return;
    }

    const db = getDb();
    const codeRef = db.collection('telegram_link_codes').doc(code.toUpperCase());
    const codeSnap = await codeRef.get();

    if (!codeSnap.exists) {
      await sendTG(chatId, '⚠️ Bu bağlantı kodu geçersiz veya daha önce kullanılmış. Lütfen uygulamada "Telegram Bağla" butonuna tekrar basıp yeni bir bağlantı açın.');
      res.status(200).json({ ok: true });
      return;
    }

    const codeData = codeSnap.data();
    const age = Date.now() - (codeData.createdAt || 0);
    if (age > CODE_TTL_MS) {
      await codeRef.delete();
      await sendTG(chatId, '⚠️ Bu bağlantı kodunun süresi dolmuş (15 dakikadan eski). Lütfen uygulamada "Telegram Bağla" butonuna tekrar basıp yeni bir bağlantı açın.');
      res.status(200).json({ ok: true });
      return;
    }

    const username = codeData.username;
    if (!username) {
      await codeRef.delete();
      res.status(200).json({ ok: true });
      return;
    }

    // Hesaba bağla — approve.js içindeki get_notification_prefs ve
    // sendNotification, TAM OLARAK bu alanı (telegramChatId) okuyor.
    await db.collection('user_profiles').doc(username).set({
      telegramChatId: chatId,
      telegramLinkedAt: Date.now()
    }, { merge: true });

    // Kod tek kullanımlık — tekrar kullanılmasın diye hemen sil.
    await codeRef.delete();

    await sendTG(chatId, `✅ *Bağlandı!* @${username} hesabınız artık bu Telegram'a bağlı. Domain onayı, satış, mesaj gibi bildirimleri buradan da alacaksınız.`);

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[telegram-webhook] Hata:', e);
    res.status(200).json({ ok: true }); // Telegram'ın tekrar denemesini önlemek için yine de 200
  }
}
