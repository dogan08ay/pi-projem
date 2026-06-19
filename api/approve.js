export default async function handler(req, res) {
  // CORS ayarları
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: "Sadece POST kabul edilir" });

  const { paymentId, action, txid, username, domainName, amount } = req.body;
  const PI_API_KEY = process.env.APP_SECRET;
  const TG_BOT_TOKEN = "8540258785:AAFbI0MAUR1RFsvPPsOyGEgnqhx_3ZAYgOU";
  const TG_CHAT_ID = "850838849";

  // Pi API URL
  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Authorization': `Key ${PI_API_KEY}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ txid }) 
    });
    
    const data = await response.json();

    // Eğer işlem 'complete' ise ve başarılıysa Telegram'a mesaj gönder
    if (action === 'complete' && response.ok) {
      // Benzersiz bir şifre üret (Örn: WEB3-XXXX)
      const purchaseCode = "WEB3-" + Math.random().toString(36).substr(2, 6).toUpperCase();
      
      const message = `🚀 *YENİ SATIŞ!*\n\n` +
                      `👤 *Alıcı:* @${username}\n` +
                      `🌐 *Domain:* ${domainName}\n` +
                      `💰 *Tutar:* ${amount} Pi\n` +
                      `🔑 *Üretilen Şifre:* ${purchaseCode}\n` +
                      `📄 *TXID:* \`${txid}\``;

      // Telegram Botuna gönder
      await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text: message,
          parse_mode: 'Markdown'
        })
      });

      // Şifreyi kullanıcıya dön
      return res.status(200).json({ ...data, purchaseCode });
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
