export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Only POST allowed" });
  
  const { paymentId, action } = req.body;
  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Key ${process.env.APP_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    
    const data = await response.json();
    console.log(`Pi API Yanıtı (${action}):`, data); // Vercel Logs kısmında bunu görmelisin
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
