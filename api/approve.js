export default async function handler(req, res) {
  // 1. CORS izinleri
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // 2. İstek içeriğini al (txid eklendi)
  const { paymentId, action, txid } = req.body;

  if (!paymentId || !action) {
    return res.status(400).json({ error: "Eksik parametre: paymentId veya action yok." });
  }

  // 3. Pi API URL'si
  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;

  try {
    // 4. Pi API'ye istek gönder
    // KRİTİK DÜZELTME: 'complete' aksiyonu için txid göndermek zorunludur!
    const bodyData = action === 'complete' ? JSON.stringify({ txid }) : JSON.stringify({});

    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Authorization': `Key ${process.env.APP_SECRET}`, 
        'Content-Type': 'application/json' 
      },
      body: bodyData
    });
    
    const data = await response.json();

    // 5. Pi API'den gelen hata durumlarını yakala
    if (!response.ok) {
      console.error("Pi API Hatası:", data);
      return res.status(response.status).json({ 
        error: "Pi API Hatası", 
        details: data 
      });
    }

    return res.status(200).json(data);
  } catch (e) {
    console.error("Sunucu Hatası:", e);
    return res.status(500).json({ error: e.message });
  }
}
