// tests/security.test.js — Güvenlik düzeltmeleri için regresyon testleri (vitest).
// Çalıştırma: npm test
// Ağ/Firebase gerektirmez: yalnızca approve.js'in saf yardımcı fonksiyonlarını ve CORS/yöntem kontrolünü sınar.
import { describe, it, expect, vi, beforeEach } from 'vitest';

async function load(env = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return await import('../api/approve.js');
}
beforeEach(() => { vi.unstubAllEnvs(); });

describe('sanitizeImgPath (stored-XSS koruması)', () => {
  it('kendi assets/ yollarını kabul eder', async () => {
    const { sanitizeImgPath } = await load();
    expect(sanitizeImgPath('assets/default.jpeg')).toBe('assets/default.jpeg');
    expect(sanitizeImgPath('assets/domains/a-1.png')).toBe('assets/domains/a-1.png');
  });
  it.each([
    'x" onerror="alert(1)', 'javascript:alert(1)', 'https://evil.com/a.png', 'assets/../../etc/passwd',
    '<img src=x>', 'data:text/html,<script>alert(1)</script>', 'a'.repeat(600), '', null, undefined, 123, {}, [],
  ])('zararlı/geçersiz girdiyi varsayılana çevirir: %s', async (bad) => {
    const { sanitizeImgPath } = await load();
    expect(sanitizeImgPath(bad)).toBe('assets/default.jpeg');
  });
});

describe('normalizeHttpUrl', () => {
  it('tırnak ve boşluğu yüzde-kodlar (attribute breakout engeli)', async () => {
    const { normalizeHttpUrl } = await load();
    const out = normalizeHttpUrl('https://example.com/a b"c');
    expect(out).toBe('https://example.com/a%20b%22c');
    expect(out).not.toContain('"');
  });
  it('http/https dışını reddeder', async () => {
    const { normalizeHttpUrl } = await load();
    expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeHttpUrl('ftp://x.com')).toBeNull();
    expect(normalizeHttpUrl('data:text/html,hi')).toBeNull();
    expect(normalizeHttpUrl('not a url')).toBeNull();
  });
});

describe('isPrivateOrReservedIp (SSRF)', () => {
  const blocked = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '100.127.255.255', '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.19.9.9', '198.51.100.7', '203.0.113.9', '224.0.0.1',
    '255.255.255.255', '0.0.0.0', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:101',
    '::ffff:a9fe:a9fe', 'fe80::1', 'febf::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::1', '::7f00:1', '100::1',
    '0:0:0:0:0:0:0:1', 'abc', '1:2:3:4:5:6:7:8:9'];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1',
    '198.17.0.1', '198.20.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::'];
  it.each(blocked)('engeller: %s', async (ip) => {
    const { isPrivateOrReservedIp } = await load();
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });
  it.each(allowed)('izin verir: %s', async (ip) => {
    const { isPrivateOrReservedIp } = await load();
    expect(isPrivateOrReservedIp(ip)).toBe(false);
  });
});

describe('yardımcılar', () => {
  it('isTooLong: tip ve uzunluk', async () => {
    const { isTooLong } = await load();
    expect(isTooLong(undefined, 5)).toBe(false);
    expect(isTooLong(null, 5)).toBe(false);
    expect(isTooLong('abc', 5)).toBe(false);
    expect(isTooLong('abcdef', 5)).toBe(true);
    expect(isTooLong({ a: 1 }, 5)).toBe(true);
    expect(isTooLong(['x'], 5)).toBe(true);
    expect(isTooLong(5, 5)).toBe(true);
  });
  it('maskUsername', async () => {
    const { maskUsername } = await load();
    expect(maskUsername('doganay0808')).toBe('do***');
    expect(maskUsername('a')).toBe('a***');
    expect(maskUsername('')).toBe('');
    expect(maskUsername(null)).toBe('');
  });
  it('getClientIp: sahte x-forwarded-for yerine Vercel başlığı öncelikli', async () => {
    const { getClientIp } = await load();
    expect(getClientIp({ headers: { 'x-vercel-forwarded-for': '1.2.3.4', 'x-forwarded-for': '6.6.6.6, 1.2.3.4' } })).toBe('1.2.3.4');
    expect(getClientIp({ headers: { 'x-real-ip': '2.2.2.2' } })).toBe('2.2.2.2');
    expect(getClientIp({ headers: { 'x-forwarded-for': '5.5.5.5, 9.9.9.9' } })).toBe('5.5.5.5');
    expect(getClientIp({ headers: {}, socket: { remoteAddress: '7.7.7.7' } })).toBe('7.7.7.7');
    expect(getClientIp({ headers: {} })).toBe('unknown');
  });
  it('publicErr: normal kullanıcıya iç hata metni sızmaz', async () => {
    const { publicErr } = await load();
    const msg = publicErr(new Error('FIRESTORE: /secret/path denied'), { body: {} });
    expect(msg).not.toContain('FIRESTORE');
    expect(msg).toBe('Sunucu hatası oluştu, lütfen tekrar deneyin.');
    expect(publicErr(new Error('x'), { body: { lang: 'en' } })).toMatch(/server error/i);
  });
});

describe('reservePayoutBudget (günlük para çıkışı tavanı)', () => {
  function fakeDb() {
    const store = new Map(); const ref = (p) => ({ p });
    return { store, collection: (c) => ({ doc: (d) => ref(c + '/' + d) }),
      async runTransaction(fn) { const writes = [];
        const tx = { async get(r) { const v = store.get(r.p); return { exists: v !== undefined, data: () => v && JSON.parse(JSON.stringify(v)) }; },
          set(r, d, o) { writes.push(() => store.set(r.p, { ...(o && o.merge ? (store.get(r.p) || {}) : {}), ...d })); } };
        const out = await fn(tx); writes.forEach((w) => w()); return out; } };
  }
  it('tavan tanımsızken hiçbir şey yazmaz/engellemez', async () => {
    const { reservePayoutBudget } = await load({ ADMIN_DAILY_PAYOUT_LIMIT_PI: '' });
    const db = fakeDb(); db.store.set('s/1', {});
    const r = await reservePayoutBudget(db, { p: 's/1' }, 999999, 'payoutBudgetDay');
    expect(r).toMatchObject({ ok: true, skipped: true });
    expect(db.store.size).toBe(1);
  });
  it('tavan 100: aşımı engeller, aynı satışı iki kez saymaz', async () => {
    const { reservePayoutBudget } = await load({ ADMIN_DAILY_PAYOUT_LIMIT_PI: '100' });
    const db = fakeDb(); for (const s of ['1', '2', '3']) db.store.set('s/' + s, {});
    expect((await reservePayoutBudget(db, { p: 's/1' }, 60, 'payoutBudgetDay')).used).toBe(60);
    expect((await reservePayoutBudget(db, { p: 's/1' }, 60, 'payoutBudgetDay')).already).toBe(true);
    const blocked = await reservePayoutBudget(db, { p: 's/2' }, 50, 'payoutBudgetDay');
    expect(blocked.ok).toBe(false);
    expect(db.store.get('s/2').payoutBudgetDay).toBeUndefined();
    expect((await reservePayoutBudget(db, { p: 's/3' }, 40, 'refundBudgetDay')).ok).toBe(true);
  });
});

describe('handler: CORS ve yöntem kontrolü', () => {
  const mkRes = () => ({ code: 0, h: {}, body: null, setHeader(k, v) { this.h[k.toLowerCase()] = v; },
    status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; }, end() { return this; } });
  it('ALLOWED_ORIGIN boşken dış origin yansıtılmaz (fail-closed)', async () => {
    const { default: handler } = await load({ ALLOWED_ORIGIN: '' });
    const res = mkRes(); await handler({ method: 'OPTIONS', headers: { origin: 'https://evil.com' } }, res);
    expect(res.code).toBe(200); expect(res.h['access-control-allow-origin']).toBeUndefined();
  });
  it('izinli origin yansıtılır, izinsiz yansıtılmaz', async () => {
    const { default: handler } = await load({ ALLOWED_ORIGIN: 'https://dofiay.com' });
    let res = mkRes(); await handler({ method: 'OPTIONS', headers: { origin: 'https://dofiay.com' } }, res);
    expect(res.h['access-control-allow-origin']).toBe('https://dofiay.com');
    res = mkRes(); await handler({ method: 'OPTIONS', headers: { origin: 'https://evil.com' } }, res);
    expect(res.h['access-control-allow-origin']).toBeUndefined();
  });
  it('GET 405 döner', async () => {
    const { default: handler } = await load();
    const res = mkRes(); await handler({ method: 'GET', headers: {} }, res);
    expect(res.code).toBe(405);
  });
});
