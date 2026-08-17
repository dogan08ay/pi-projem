// ═══════════════════════════════════════════════════════════════════════
//  approve.js — Saf (side-effect'siz) fonksiyonlar için birim testleri
// ═══════════════════════════════════════════════════════════════════════
// NOT: approve.js'in tamamı Firestore/Pi Network/Telegram gibi dış
// servislere bağımlı olduğu için (ve bu servisleri gerçek bir ortamda
// mock'lamak ayrı, daha büyük bir iş olduğu için) burada BİLEREK sadece
// dış bağımlılığı olmayan, "saf" (aynı girdi → her zaman aynı çıktı)
// fonksiyonlar test ediliyor: calculatePayoutAmount ve isValidDomainName.
// Bu ikisi platformun en kritik iki noktası: biri parasal hesaplama
// (satıcıya ne kadar ödeme gidecek), diğeri güvenlik sınırı (hangi domain
// adları kabul edilir — bkz. approve.js içindeki stored-XSS önleme yorumu).
// Modülü import etmek Firebase/Pi'ye bağlanmaz; approve.js içindeki tüm
// dış-servis çağrıları fonksiyon gövdelerinin İÇİNDE (lazy), import anında
// çalışmaz — bu yüzden bu test dosyası .env değişkeni olmadan da çalışır.
import { describe, it, expect } from 'vitest';
import { calculatePayoutAmount, isValidDomainName } from './approve.js';

describe('calculatePayoutAmount', () => {
  it('varsayılan %5 komisyonu doğru düşer', () => {
    // 100 Pi satış → satıcıya %95 = 95 Pi gitmeli
    expect(calculatePayoutAmount(100)).toBe(95);
  });

  it('küsuratlı fiyatlarda 7 ondalık basamağa doğru yuvarlar', () => {
    // Önceki (tekrarlanan) formülle birebir aynı davranış: Math.round(x*1e7)/1e7
    expect(calculatePayoutAmount(33.333333)).toBeCloseTo(31.6666664, 7);
  });

  it('özel (domain\'e özgü) komisyon oranını kullanır', () => {
    // Örn. bir kampanya/anlaşma sonucu %10 komisyon uygulanan bir satış
    expect(calculatePayoutAmount(100, 0.10)).toBe(90);
  });

  it('0 Pi için 0 döner, negatif/NaN girdide çökmez', () => {
    expect(calculatePayoutAmount(0)).toBe(0);
    expect(calculatePayoutAmount(undefined)).toBe(0);
    expect(calculatePayoutAmount(null)).toBe(0);
    expect(calculatePayoutAmount('geçersiz')).toBe(0);
  });

  it('komisyon oranı sayı değilse varsayılan %5\'e düşer', () => {
    // Firestore\'dan gelen bozuk/eksik commissionRate alanına karşı koruma
    expect(calculatePayoutAmount(100, undefined)).toBe(95);
    expect(calculatePayoutAmount(100, 'bozuk-veri')).toBe(95);
  });
});

describe('isValidDomainName', () => {
  it('geçerli .pi domain adlarını kabul eder', () => {
    expect(isValidDomainName('example.pi')).toBe(true);
    expect(isValidDomainName('my-domain.pi')).toBe(true);
    expect(isValidDomainName('a1b2.sub.pi')).toBe(true);
  });

  it('çok kısa adları reddeder', () => {
    expect(isValidDomainName('ab')).toBe(false); // < 3 karakter
  });

  it('nokta (TLD ayracı) içermeyen adları reddeder', () => {
    expect(isValidDomainName('sadecemetin')).toBe(false);
  });

  it('tire ile başlayan/biten etiketleri reddeder', () => {
    expect(isValidDomainName('-baslar.pi')).toBe(false);
    expect(isValidDomainName('biter-.pi')).toBe(false);
  });

  it('KRİTİK — HTML/script enjeksiyonu içeren adları reddeder (stored-XSS koruması)', () => {
    // Bu test, approve.js içindeki isValidDomainName yorumunda anlatılan
    // tam senaryoyu doğrular: admin panelinde escape edilmeden basılan
    // domainName alanına <script> enjekte edilememesi GEREKİR.
    expect(isValidDomainName('<script>alert(1)</script>.pi')).toBe(false);
    expect(isValidDomainName('example.pi"><img src=x onerror=alert(1)>')).toBe(false);
    expect(isValidDomainName("'; DROP TABLE domains;--.pi")).toBe(false);
  });

  it('string olmayan veya boş girdilerde çökmez, false döner', () => {
    expect(isValidDomainName(null)).toBe(false);
    expect(isValidDomainName(undefined)).toBe(false);
    expect(isValidDomainName(123)).toBe(false);
    expect(isValidDomainName('')).toBe(false);
  });

  it('253 karakterden uzun adları reddeder', () => {
    const tooLong = 'a'.repeat(250) + '.pi';
    expect(isValidDomainName(tooLong)).toBe(false);
  });
});
