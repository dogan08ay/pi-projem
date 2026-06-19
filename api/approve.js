export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: "Sadece POST kabul edilir" });

  const { paymentId, action, txid, username, domainName, amount, step } = req.body;
  const PI_API_KEY = process.env.APP_SECRET;
  const TG_BOT_TOKEN = "8540258785:AAFbI0MAUR1RFsvPPsOyGEgnqhx_3ZAYgOU";
  const TG_CHAT_ID = "850838849"; // Doğan Bey'in ID'si
  const TG_GROUP_ID = "-1003987952631"; // Grup ID'si

  const sendTG = async (chatId, text) => {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
  };

  // ADIM 1: ŞİFRE TALEBİ (Kullanıcı Satın Al'a bastığında)
  if (step === 'request_code') {
    const tempCode = Math.floor(1000 + Math.random() * 9000); // 4 haneli kod
    const msg = `🔔 *ONAY KODU TALEBİ*\n\n👤 *Kullanıcı:* @${username}\n🌐 *Domain:* ${domainName}\n💰 *Fiyat:* ${amount} Pi\n\n🔑 *Onay Kodu:* \`${tempCode}\`\n\n_Lütfen bu kodu kullanıcıya iletin veya kullanıcının gruptan görmesini sağlayın._`;
    
    await sendTG(TG_CHAT_ID, msg);
    await sendTG(TG_GROUP_ID, msg);
    
    return res.status(200).json({ tempCode });
  }

  // ADIM 2: ÖDEME ONAYI VE TAMAMLAMA
  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid }) 
    });
    
    const data = await response.json();

    if (action === 'complete' && response.ok) {
      const purchaseCode = "WEB3-" + Math.random().toString(36).substr(2, 6).toUpperCase();
      
      // Gruba Duyuru
      const groupMsg = `🎉 *TEBRİKLER!*\n\n👤 @${username}, *${domainName}* domainini başarıyla satın aldı! 🚀\n\n🌐 Sitemize hoş geldin yeni sahibi!`;
      await sendTG(TG_GROUP_ID, groupMsg);

      // Kullanıcıya Özel (Size gelen mesaj üzerinden veya bota /start diyen kullanıcıya id ile de gönderilebilir)
      // Şimdilik size (admin) bilgi gidiyor, kullanıcıya da ekranda gösteriyoruz.
      const adminMsg = `✅ *SATIŞ TAMAMLANDI*\n\n👤 *Alıcı:* @${username}\n🌐 *Domain:* ${domainName}\n💰 *Tutar:* ${amount} Pi\n🔑 *Şifre:* \`${purchaseCode}\``;
      await sendTG(TG_CHAT_ID, adminMsg);

      return res.status(200).json({ ...data, purchaseCode });
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
