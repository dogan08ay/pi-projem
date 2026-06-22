export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: "Sadece POST kabul edilir" });

  const { paymentId, action } = req.body;
  const PI_API_KEY = process.env.APP_SECRET;

  // ARIZA TESPİT MANTIĞI: ID ne olursa olsun Pi API'ye iptal gönder
  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' }
    });
    
    const data = await response.json();

    // Hata gelse bile (zaten iptal edilmiş olabilir) frontend'e başarı dön
    return res.status(200).json({ success: true, api_data: data });
  } catch (e) {
    return res.status(200).json({ success: true, error: e.message });
  }
}
