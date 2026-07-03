// api/config.js — Frontend'e public config bilgilerini döner
export default function handler(req, res) {
  // CORS headers
  const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
    .split(',').map(o => o.trim()).filter(Boolean);
  const requestOrigin = req.headers.origin;
  
  if (allowedOrigins.length === 0) {
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  }
  
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: "Sadece GET kabul edilir" });

  // Public config bilgileri (gizli bilgi YOK)
  res.status(200).json({
    adminUsername: process.env.ADMIN_USERNAME || 'doganay0808',
    contactEmail: process.env.NEXT_PUBLIC_CONTACT_EMAIL || 'doganay08@hotmail.com',
    telegramGroup: process.env.NEXT_PUBLIC_TELEGRAM_GROUP || 'https://t.me/+5jZi9vrcNMM2NGVk',
  });
}
