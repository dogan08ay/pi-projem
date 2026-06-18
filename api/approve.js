export default async function handler(req, res) {
  // Sadece POST isteklerine izin ver
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { paymentId, action, txid } = req.body;
  const APP_SECRET = process.env.APP_SECRET;

  if (!APP_SECRET) {
    return res.status(500).json({ error: "APP_SECRET yapılandırması eksik!" });
  }

  try {
    const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;
    
    // Modern JavaScript 'fetch' (Node.js 18+ ile yerleşik gelir, import gerekmez)
    const response = await fetch(url, {
      method: "POST",
      headers: { 
        "Authorization": `Key ${APP_SECRET}`, 
        "Content-Type": "application/json" 
      },
      body: action === "complete" ? JSON.stringify({ txid }) : JSON.stringify({})
    });

    const data = await response.json();
    return res.status(response.status).json(data);
    
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
