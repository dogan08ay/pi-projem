export default async function handler(req, res) {
  // Pi Network'ten gelen tüm istekleri doğrudan "success" olarak cevapla
  res.status(200).json({ status: 'success' });
}
