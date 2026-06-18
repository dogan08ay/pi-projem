export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { paymentId, action, txid } = req.body;
  const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Key ${process.env.APP_SECRET}`, 'Content-Type': 'application/json' },
      body: action === 'complete' ? JSON.stringify({ txid }) : JSON.stringify({})
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
