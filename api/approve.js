export default async function handler(req, res) {
  // Pi'den gelen isteği kabul ettiğimizi belirtelim
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const { paymentId, action } = req.body;

  try {
    // Burada Pi Network'ün ödeme kontrol mekanizmasına onay veriyoruz
    if (action === 'approve') {
      return res.status(200).json({ status: 'success' });
    }
    if (action === 'complete') {
      return res.status(200).json({ status: 'success' });
    }
    
    return res.status(200).json({ status: 'success' });
  } catch (error) {
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
