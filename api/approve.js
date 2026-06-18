export default async function handler(req, res) {
  // 1. CORS izinlerini ayarla (Bazen 405 hatası CORS yüzünden de tetiklenir)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 2. Metot POST değilse hata ver ama 405'i özelleştir
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method Not Allowed - Sadece POST kabul edilir" });
  }

  // 3. İstek içeriğini al
  const { paymentId, action } = req.body;

  // 4. Pi API'ye bağlan
  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Authorization': `Key ${process.env.APP_SECRET}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({}) 
    });
    
    const data = await response.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
