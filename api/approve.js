export default async function handler(req, res) {
  // Sadece POST isteklerini kabul et
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { paymentId, action, txid } = req.body;

  if (!paymentId || !action) {
    return res.status(400).json({ error: "Missing paymentId or action" });
  }

  // Pi Network API URL
  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Authorization': `Key ${process.env.APP_SECRET}`, 
        'Content-Type': 'application/json' 
      },
      // 'complete' aksiyonu txid bekler, 'approve' ise boş gövde bekler
      body: action === 'complete' ? JSON.stringify({ txid }) : JSON.stringify({})
    });

    const data = await response.json();

    // Pi Network'ten gelen yanıtı olduğu gibi döndür
    res.status(response.status).json(data);
    
  } catch (e) {
    console.error("API Error:", e);
    res.status(500).json({ error: e.message });
  }
}
