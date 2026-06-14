// api/approve.js
export default async function handler(req, res) {
  if (req.method === 'POST') {
    // Burada Pi Network API ile haberleşmen gerekiyor
    // AppSecret anahtarını kontrol et
    res.status(200).json({ success: true });
  } else {
    res.status(405).end();
  }
}
