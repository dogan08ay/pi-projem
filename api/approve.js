export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const { paymentId, action, txid } = req.body;
  const APP_SECRET = process.env.APP_SECRET; // Vercel'den otomatik okur

  try {
    let piResponse;

    if (action === 'approve') {
      // Pi Network API'sine onay isteği
      piResponse = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${APP_SECRET}`,
          'Content-Type': 'application/json'
        }
      });
    } else if (action === 'complete') {
      // Pi Network API'sine tamamla isteği
      piResponse = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${APP_SECRET}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ txid: txid })
      });
    }

    const data = await piResponse.json();
    res.status(200).json(data);

  } catch (error) {
    console.error("Pi API Hatası:", error);
    res.status(500).json({ error: "Pi Network API hatası" });
  }
}
