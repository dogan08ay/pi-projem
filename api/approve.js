// api/approve.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { paymentId, action } = req.body; // action: 'approve' veya 'complete'
  
  // Önemli: Pi API'de 'cancel' yerine 'complete' de kullanmalısın
  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Authorization': `Key ${process.env.APP_SECRET}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ txid: "SISTEM_ONAYI_" + Date.now() }) // Complete için body gerekebilir
    });
    
    const data = await response.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
