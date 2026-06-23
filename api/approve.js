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
    // ALLOWED_ORIGIN henüz ayarlanmadıysa eski davranışa düşmeyelim,
    // ama site çalışmaya devam etsin diye gelen origin'i yansıtıyoruz.
    // Bunu fark eder etmez Vercel'de ALLOWED_ORIGIN'i tanımlayın.
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: "Sadece POST kabul edilir" });

  const { paymentId, action, txid, username, domainName, amount } = req.body;

  if (!paymentId || !action) {
    return res.status(400).json({ error: "paymentId ve action zorunludur" });
  }

  // İzin verilen action'lar dışında bir şey gelirse reddet
  // (Pi Platform API'sinin gerçek endpoint'leri: approve, complete, cancel)
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
      const purchaseCode = "WEB3-" + Math.random().toString(36).substr(2, 6).toUpperCase();

      if (domainName && username) {
        const groupMsg = `🎉 *YENİ SATIŞ!*\n\n👤 @${username}, *${domainName}* domainini başarıyla satın aldı! 🚀\n\n🌐 Sitemize hoş geldin yeni sahibi!`;
        await sendTG(TG_GROUP_ID, groupMsg);

        const adminMsg = `✅ *SATIŞ TAMAMLANDI*\n\n👤 *Alıcı:* @${username}\n🌐 *Domain:* ${domainName}\n💰 *Tutar:* ${amount} Pi\n🔑 *Üretilen Şifre:* \`${purchaseCode}\``;
        await sendTG(TG_CHAT_ID, adminMsg);
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
