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
//   1) Vercel'e YENİ bir env değişkeni ekleyin: TG_WEBHOOK_SECRET
//      (rastgele, uzun, tahmin edilemez bir metin — örn. bir şifre
//      üretici ile oluşturulmuş 32+ karakterlik bir dize).
//   2) Bu dosyayı /api/telegram-webhook.js olarak deploy edin.
//   3) Tarayıcıda şu adresi ziyaret edin (KENDİ bot token'ınızı,
//      alan adınızı VE 1. adımda seçtiğiniz TG_WEBHOOK_SECRET'ı yazarak):
//      https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=https://<SIZIN-ALAN-ADINIZ>/api/telegram-webhook&secret_token=<TG_WEBHOOK_SECRET>
//      Dönen cevapta "ok":true görürseniz kurulum tamamdır.
//   4) Test edin: uygulamada Telegram Bağla'ya basın, botta Başlat'a basın,
//      bot size "✅ Bağlandı" mesajı göndermeli ve uygulamaya dönünce
//      buton "Bağlantıyı Kes" olarak görünmeli.
//
// GÜVENLİK NOTU (FIX — kök neden: "webhook kimliği doğrulanmıyordu"):
// Önceki halde bu endpoint, isteğin gerçekten Telegram'dan geldiğini HİÇ
// doğrulamıyordu — /api/telegram-webhook adresini bilen herkes Telegram'ın
// gönderdiği JSON formatını taklit ederek doğrudan POST atabilirdi.
// Telegram'ın resmi çözümü "secret_token": setWebhook çağrısına eklenen bu
// gizli değer, Telegram'dan gelen HER istekte X-Telegram-Bot-Api-Secret-Token
// header'ı olarak geri gönderiliyor. Aşağıda bu header, ortam
// değişkenindeki değerle sabit-zamanlı (timing-safe) karşılaştırılıyor;
// uyuşmazsa istek Telegram'dan gelmiyor demektir ve sessizce reddediliyor.
// NOT: Bu, sadece isteğin KAYNAĞINI doğrular — bir saldırgan yine de kendi
// Telegram hesabından bota "/start <tahmin>" mesajları göndererek kod
// tahmin etmeye çalışabilir. Ona karşı ayrıca aşağıda chatId bazlı bir
// rate limit var.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import crypto from 'crypto';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET;
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

// Sabit-zamanlı karşılaştırma: normal `===` kullanılsaydı, string'in ilk
// kaç karakterinin doğru olduğuna göre yanıt süresi mikroskobik de olsa
// değişebilir (timing attack). Buffer uzunlukları farklıysa
// timingSafeEqual hata fırlatır, o yüzden önce uzunluk kontrolü yapılıyor
// (bu kontrolün kendisi bir bilgi sızdırmıyor çünkü secret'ın uzunluğu
// zaten gizli değil, sadece değeri gizli).
function isValidSecret(received) {
  if (!TG_WEBHOOK_SECRET) return false; // secret tanımlı değilse hiçbir isteği kabul etme
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(TG_WEBHOOK_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// FIX: chatId bazlı basit rate limit — secret_token doğrulaması isteğin
// Telegram'dan geldiğini garanti eder ama saldırganın KENDİ Telegram
// hesabından bota art arda "/start <tahmin>" göndermesini engellemez.
// Aynı chatId 10 dakikada 8'den fazla deneme yaparsa reddediliyor.
// approve.js'teki checkRateLimit ile aynı desende (Firestore transaction +
// in-memory yedek) ama bu ayrı serverless function olduğu için burada
// küçük bir kopyası tutuluyor.
const rlMemoryMap = new Map();
async function checkWebhookRateLimit(db, chatId) {
  const maxReq = 8;
  const windowMs = 10 * 60 * 1000;
  const now = Date.now();
  const docId = `tgwh_${chatId}`;
  try {
    const ref = db.collection('rate_limits').doc(docId);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : null;
      if (!data || now - data.start > windowMs) {
        tx.set(ref, { count: 1, start: now, expiresAt: Timestamp.fromMillis(now + windowMs) });
        return true;
      }
      if (data.count >= maxReq) return false;
      tx.set(ref, { count: data.count + 1, start: data.start, expiresAt: Timestamp.fromMillis(now + windowMs) }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error('[telegram-webhook] RateLimit Firestore hatası, in-memory yedeğe düşülüyor:', e.message);
    const entry = rlMemoryMap.get(chatId) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 1; entry.start = now; }
    else entry.count++;
    rlMemoryMap.set(chatId, entry);
    return entry.count <= maxReq;
  }
}

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

  // FIX: isteğin gerçekten Telegram'dan geldiğini doğrula. Telegram bu
  // header'ı setWebhook'ta secret_token verildiyse OTOMATİK ekler; başka
  // hiçbir gönderici bu header'ı doğru değerle üretemez. Uyuşmazsa
  // sessizce 200 dönülüyor (Telegram'a hata gösterilmez çünkü zaten
  // Telegram'dan gelen bir istek değil; muhtemel saldırgana da bilgi
  // sızdırılmıyor).
  const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (!isValidSecret(receivedSecret)) {
    console.warn('[telegram-webhook] Geçersiz veya eksik secret_token — istek reddedildi (Telegram kaynaklı değil).');
    res.status(200).json({ ok: true });
    return;
  }

  try {
    const update = req.body || {};
    const message = update.message;
    if (!message || !message.text || !message.chat || !message.chat.id) {
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = message.chat.id;
    const text = String(message.text).trim();
    const db = getDb();

    // FIX: sadece kod tahmin etmeye çalışılan "/start KOD" akışını
    // sınırlıyoruz — parametresiz "/start" (karşılama mesajı) ve diğer
    // mesajlar zaten aşağıda ayrıca filtreleniyor, onlara rate limit
    // uygulamaya gerek yok çünkü kaba kuvvet riski taşımıyorlar.
    const looksLikeCodeAttempt = /^\/start\s+\S+/.test(text);
    if (looksLikeCodeAttempt) {
      if (!await checkWebhookRateLimit(db, chatId)) {
        await sendTG(chatId, '⚠️ Çok fazla deneme yaptınız. Lütfen birkaç dakika sonra tekrar deneyin.');
        res.status(200).json({ ok: true });
        return;
      }
    }

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
