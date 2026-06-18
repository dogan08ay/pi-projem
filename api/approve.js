export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const { paymentId, action, txid } = req.body;
  const APP_SECRET = process.env.APP_SECRET;

  try {
    const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;
    const options = {
      method: "POST",
      headers: { 
        "Authorization": `Key ${APP_SECRET}`, 
        "Content-Type": "application/json" 
      },
      body: action === "complete" ? JSON.stringify({ txid }) : JSON.stringify({})
    };

    const response = await fetch(url, options);
    const data = await response.json();
    
    // Hatayı detaylı döndür
    if (!response.ok) {
        return res.status(response.status).json({ error: data.error || "Pi API Error", details: data });
    }
    
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
