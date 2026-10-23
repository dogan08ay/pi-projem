// CSP ihlal raporu alıcısı (Content-Security-Policy-Report-Only → report-uri /api/csp-report).
// Amaç: sıkı CSP'yi ZORUNLU kılmadan önce, gerçek kullanıcı trafiğinde hangi kaynakların
// engelleneceğini Vercel Function Logs'ta görmek ("[CSP-REPORT]" araması).
// Veritabanına yazmaz, yanıt gövdesi dönmez; kötüye kullanıma karşı log hacmi sınırlıdır.
let windowStart = 0;
let count = 0;
const MAX_PER_MIN = 60;      // örnek başına dakikada en fazla 60 satır log
const MAX_BODY_BYTES = 20000; // akıştan okunacak en fazla bayt
const MAX_LOG_CHARS = 600;   // tek rapor için log boyutu sınırı

// Tarayıcılar CSP raporunu "application/csp-report" türüyle gönderir; Vercel bu türü
// otomatik ayrıştırmadığı için req.body boş kalabilir. Bu durumda gövde doğrudan akıştan okunur.
async function readRaw(req) {
  let raw = req.body;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  else if (raw && typeof raw === 'object') raw = JSON.stringify(raw);
  else raw = typeof raw === 'string' ? raw : '';
  if (raw) return raw;
  if (req.readableEnded || typeof req[Symbol.asyncIterator] !== 'function') return '';
  const chunks = [];
  let total = 0;
  try {
    for await (const c of req) {
      const remaining = MAX_BODY_BYTES - total;
      if (remaining <= 0) break;
      chunks.push(c.length > remaining ? c.subarray(0, remaining) : c); // büyük parça atılmaz, KIRPILIR
      total += c.length;
      if (total >= MAX_BODY_BYTES) break;
    }
  } catch (_) { /* akış okunamazsa boş say */ }
  return Buffer.concat(chunks).toString('utf8');
}

// Okunabilir tek satır: yalnızca işe yarayan alanlar (varsa), aksi halde ham metin.
function summarize(raw) {
  try {
    const j = JSON.parse(raw);
    const r = j['csp-report'] || j;
    const pick = (k) => (r[k] === undefined ? '' : String(r[k]));
    const doc = pick('document-uri').split(/[?#]/)[0];
    return JSON.stringify({
      directive: pick('effective-directive') || pick('violated-directive'),
      blocked: pick('blocked-uri'),
      page: doc,
      source: pick('source-file') + (r['line-number'] ? ':' + r['line-number'] : ''),
    });
  } catch (_) {
    return raw;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const now = Date.now();
  if (now - windowStart > 60000) { windowStart = now; count = 0; }
  if (++count > MAX_PER_MIN) { res.status(204).end(); return; }
  try {
    const raw = await readRaw(req);
    // Log enjeksiyonunu önlemek için satır sonlarını ve kontrol karakterlerini temizle.
    const safe = summarize(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MAX_LOG_CHARS);
    console.warn('[CSP-REPORT]', safe || '(boş rapor gövdesi)');
  } catch (_) { /* rapor işlenemese de tarayıcıya hata dönme */ }
  res.status(204).end();
}
