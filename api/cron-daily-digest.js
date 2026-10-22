// ══════════════════════════════════════════════════════════════════════
//  Günlük Telegram Özeti — Vercel Cron ile her gün otomatik tetiklenir.
//
//  GÜVENLİK: Bu endpoint, approve.js'deki gibi bir Pi accessToken
//  ile korunamaz (Vercel Cron bir Pi hesabına sahip değil). Bunun yerine
//  Vercel'in resmi önerdiği yöntem kullanılıyor: Vercel ortam
//  değişkenlerinde bir CRON_SECRET tanımlarsanız, Vercel Cron bu
//  endpoint'i çağırırken otomatik olarak "Authorization: Bearer
//  <CRON_SECRET>" header'ını ekler. Biz de bunu doğruluyoruz — eşleşmezse
//  (ör. biri URL'yi tahmin edip elle çağırırsa) 401 ile reddediyoruz.
//  CRON_SECRET tanımlı DEĞİLSE, bu endpoint kimseyi doğrulayamaz ve
//  güvenlik açığı olmasın diye TAMAMEN devre dışı kalır (401 döner).
//
//  KURULUM (Vercel ortam değişkenleri):
//   1) Rastgele, uzun bir metin üretin (ör. bir şifre yöneticisiyle) ve
//      Vercel → Settings → Environment Variables → CRON_SECRET olarak
//      ekleyin.
//   2) vercel.json'daki "crons" bölümü zaten bu dosyayı her gün
//      belirlenen saatte (varsayılan: 06:00 UTC = Türkiye saatiyle
//      09:00) otomatik çağıracak şekilde ayarlı — ekstra bir şey
//      yapmanıza gerek yok, sadece CRON_SECRET'i eklemeniz yeterli.
// ══════════════════════════════════════════════════════════════════════
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'crypto';

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

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
async function sendTG(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' })
    });
  } catch (e) { console.error('[CronDigest] Telegram gönderilemedi:', e.message); }
}

export default async function handler(req, res) {
  // ── Doğrulama ──────────────────────────────────────────────────────
  if (!process.env.CRON_SECRET) {
    console.error('[CronDigest] CRON_SECRET tanımlı değil — endpoint güvenlik amacıyla devre dışı.');
    return res.status(401).json({ error: 'CRON_SECRET tanımlı değil' });
  }
  // GÜVENLİK (Adım 4): sabit-zamanlı karşılaştırma (approve.js'teki check_auctions ile aynı yaklaşım).
  const authHeader = req.headers['authorization'];
  const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET}`);
  const got = Buffer.from(typeof authHeader === 'string' ? authHeader : '');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return res.status(401).json({ error: 'Yetkisiz' });
  }

  try {
    const db = getDb();
    const now = Date.now();
    const since = now - 24 * 3600 * 1000; // son 24 saat

    // PERFORMANS (Adım 4): 'tickets' ve 'conversations' koleksiyonlarının TAMAMI her gün okunuyordu
    // (veri büyüdükçe maliyet artar). Artık önce "görüldü" zaman damgaları alınıp yalnızca gerekli
    // aralıktaki dokümanlar sorgulanıyor. Sonuç aynıdır: alanı olmayan/eşik altındaki dokümanlar
    // eskiden de sayılmıyordu (eksik alan 0 kabul edilip eşikle karşılaştırılıyordu).
    const [ticketSeenSnap, reportSeenSnap, msgSeenSnap] = await Promise.all([
      db.collection('system_config').doc('admin_ticket_seen').get(),
      db.collection('system_config').doc('admin_report_seen').get(),
      db.collection('system_config').doc('admin_messages_seen').get()
    ]);
    const ticketSeenAt = ticketSeenSnap.exists ? (ticketSeenSnap.data().seenAt || 0) : 0;
    const reportSeenAt = reportSeenSnap.exists ? (reportSeenSnap.data().seenAt || 0) : 0;
    const msgSeenAt = msgSeenSnap.exists ? (msgSeenSnap.data().seenAt || 0) : 0;

    const [
      salesSnap, sellReqSnap, newTicketsSnap, unseenTicketsSnap,
      pendingApprovalsSnap, pendingPayoutsSnap, pendingOffersSnap,
      tmSnap, reportsSnap, unseenConvSnap
    ] = await Promise.all([
      db.collection('global_sales').where('at', '>', since).get(),
      db.collection('sell_requests').where('submittedAt', '>', since).get(),
      db.collection('tickets').where('createdAt', '>', since).get(),
      db.collection('tickets').where('lastUpdate', '>', ticketSeenAt).get(),
      db.collection('sell_requests').where('status', '==', 'pending').get(),
      db.collection('global_sales').where('payoutStatus', '==', 'pending').get(),
      db.collection('offers').where('status', '==', 'pending').get(),
      db.collection('trademark_claims').where('status', 'in', ['new', 'reviewing']).get(),
      db.collection('listing_reports').where('status', 'in', ['new', 'reviewing', 'resolved']).get(),
      db.collection('conversations').where('lastMessageAt', '>', msgSeenAt).get()
    ]);

    // Son 24 saatte açılan ticket sayısı (createdAt > since)
    const newTicketsCount = newTicketsSnap.size;

    // Açık (kapatılmamış + görülmemiş) ticket sayısı — get_all_tickets ile AYNI mantık
    let openTickets = 0;
    unseenTicketsSnap.forEach(d => { if (d.data().status !== 'closed') openTickets++; });

    let unseenReports = 0;
    reportsSnap.forEach(d => { if ((d.data().createdAt || 0) > reportSeenAt) unseenReports++; });

    const unseenMessages = unseenConvSnap.size;

    // Dünkü satışların toplam hacmi ve komisyonu
    let grossVolume = 0, commissionEarned = 0;
    salesSnap.forEach(d => {
      const sd = d.data();
      const price = Number(sd.price || 0);
      grossVolume += price;
      const payout = Number(sd.payoutAmount || 0);
      commissionEarned += payout > 0 ? (price - payout) : 0;
    });

    const dateLabel = new Date(now).toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });

    const lines = [
      `📅 *Günlük Özet — ${dateLabel}*`,
      ``,
      `*Son 24 saat:*`,
      `🛒 ${salesSnap.size} satış (${grossVolume.toFixed(4)} Pi hacim, ~${commissionEarned.toFixed(4)} Pi komisyon)`,
      `🏷️ ${sellReqSnap.size} yeni domain listeleme talebi`,
      `🎫 ${newTicketsCount} yeni destek talebi`,
      ``,
      `*Şu an bekleyenler:*`,
      `🏷️ ${pendingApprovalsSnap.size} bekleyen onay`,
      `🎫 ${openTickets} açık destek talebi`,
      `🔖 ${tmSnap.size} marka hakkı talebi`,
      `💸 ${pendingPayoutsSnap.size} bekleyen ödeme`,
      `🔄 ${pendingOffersSnap.size} bekleyen teklif`,
      `🚩 ${unseenReports} okunmamış şikayet`,
      `💬 ${unseenMessages} okunmamış mesaj`
    ];
    await sendTG(lines.join('\n'));

    return res.status(200).json({ success: true, sent: true });
  } catch (e) {
    console.error('[CronDigest] hata:', e);
    // Hata olsa da Telegram'a haber vermeye çalış (sessiz başarısızlık olmasın)
    try { await sendTG(`⚠️ Günlük özet oluşturulurken hata oluştu: ${e.message}`); } catch (_) {}
    return res.status(500).json({ error: e.message });
  }
}
