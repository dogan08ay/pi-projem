export default async function handler(req, res) {
  const { paymentId, action, txid } = req.body;

  if (action === 'approve') {
    // Pi'ye işlemin onaylandığını bildiriyoruz
    return res.status(200).json({ status: 'approved' });
  } 
  
  if (action === 'complete') {
    // İşlemin tamamlandığını Pi'ye bildiriyoruz
    return res.status(200).json({ status: 'completed' });
  }

  res.status(400).json({ error: 'Geçersiz aksiyon' });
}
