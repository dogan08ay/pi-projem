export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { paymentId, action, txid } = req.body;
  const APP_SECRET = process.env.APP_SECRET;

  if (!APP_SECRET) {
    console.error("HATA: APP_SECRET ortam değişkeni bulunamadı!");
    return res.status(500).json({ error: "Server Configuration Error" });
  }

  try {
    const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;
    
    // Node 18+ kullanıyorsan global fetch çalışır, çalışmazsa node-fetch gerekir.
    const response = await fetch(url, {
      method: "POST",
      headers: { 
        "Authorization": `Key ${APP_SECRET}`, 
        "Content-Type": "application/json" 
      },
      body: action === "complete" ? JSON.stringify({ txid }) : undefined
    });

    const data = await response.json();
    return res.status(response.status).json(data);
    
  } catch (err) {
    console.error("API İSTEK HATASI:", err); // Loglara hatayı yazdır
    return res.status(500).json({ error: err.message });
  }
}
