export default function handler(req, res) {
  // Pi Network'ün her türlü isteğine "Tamam, onaylıyorum" diyoruz
  res.status(200).json({ status: "success" });
}
