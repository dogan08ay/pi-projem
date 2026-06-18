// Kodun en üstüne ekle
const fetch = require('node-fetch'); // Eğer hata alırsan bu satırı aktif et
// api/approve.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const { paymentId, action, txid } = req.body;
  const APP_SECRET = process.env.APP_SECRET; // Vercel Settings -> Environment Variables'dan ekleyin!

  try {
    const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;
    const options = {
      method: "POST",
      headers: { 
        "Authorization": `Key ${APP_SECRET}`, 
        "Content-Type": "application/json" 
      }
    };
    
    if (action === "complete") {
      options.body = JSON.stringify({ txid });
    }

    const response = await fetch(url, options);
    const data = await response.json();
    
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
