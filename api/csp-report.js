// CSP ihlal raporu alıcısı (Content-Security-Policy-Report-Only → report-uri /api/csp-report).
// Amaç: sıkı CSP'yi ZORUNLU kılmadan önce, gerçek kullanıcı trafiğinde hangi kaynakların
// engelleneceğini Vercel Function Logs'ta görmek ("[CSP-REPORT]" araması).
// Veritabanına yazmaz, yanıt gövdesi dönmez; kötüye kullanıma karşı log hacmi sınırlıdır.
let windowStart = 0;
let count = 0;
const MAX_PER_MIN = 60;      // örnek başına dakikada en fazla 60 satır log
const MAX_BODY_CHARS = 1500; // tek rapor için log boyutu sınırı

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const now = Date.now();
  if (now - windowStart > 60000) { windowStart = now; count = 0; }
  if (++count > MAX_PER_MIN) { res.status(204).end(); return; }
  try {
    let raw = req.body;
    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
    else if (raw && typeof raw === 'object') raw = JSON.stringify(raw);
    else raw = String(raw || '');
    // Log enjeksiyonunu önlemek için satır sonlarını ve kontrol karakterlerini temizle.
    const safe = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MAX_BODY_CHARS);
    console.warn('[CSP-REPORT]', safe);
  } catch (_) { /* rapor işlenemese de tarayıcıya hata dönme */ }
  res.status(204).end();
}
