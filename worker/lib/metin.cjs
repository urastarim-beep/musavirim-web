'use strict';

function formatTl(n) {
  const x = Number(n) || 0;
  return x.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTlSembol(n) {
  return `${formatTl(n)} ₺`;
}

function normalizeTip(tip) {
  const t = String(tip || 'makbuz').toLowerCase();
  return t === 'tahakkuk' ? 'tahakkuk' : 'makbuz';
}

function bugunTarih() {
  const d = new Date();
  const gg = String(d.getDate()).padStart(2, '0');
  const aa = String(d.getMonth() + 1).padStart(2, '0');
  return `${gg}.${aa}.${d.getFullYear()}`;
}

/** Kalem adini makbuzda kisa aciklamaya cevir */
function makbuzAciklama(ad) {
  const s = String(ad || '').trim();
  if (!s) return 'Odenecek';
  const u = s.toLocaleUpperCase('tr-TR');
  if (/MUHASEBE/.test(u)) return 'Muhasebe Ücreti';
  if (/BA[GĞ]KUR/.test(u)) return 'BAĞKUR';
  // MUHSGK = muhtasar (stopaj); makbuzda STOPAJ yaz
  if (/MUHSGK|MUHTASAR/.test(u)) return 'STOPAJ';
  if (/STOPAJ|MUHS?TOP|GEL[Iİ]R\s*VERG/.test(u)) return 'STOPAJ';
  if (/\bSGK\b/.test(u) && !/MUHSGK/.test(u)) {
    const subeAd = s.match(/\(\s*[ŞşSs]ube\s*[:：\-–—]\s*([^)]+?)\)/i);
    if (subeAd && String(subeAd[1] || '').trim()) {
      return `SGK (Şube: ${String(subeAd[1]).trim()})`;
    }
    if (/[ŞşSs]ube/i.test(s)) return 'SGK (Şube)';
    if (/[Mm]erkez/i.test(s)) return 'SGK (Merkez)';
    return 'SGK';
  }
  if (/KDV\s*2|KDV2/.test(u)) return 'KDV2';
  if (/KDV\s*1|KDV1/.test(u)) return 'KDV1';
  if (/\bKDV\b/.test(u)) return 'KDV';
  return s.replace(/\s*ödemesi\s*$/i, '').trim() || s;
}

/** 06/2026-06/2026 → 06/2026 · Haziran 2026 → 06/2026 */
function normalizeDonem(d) {
  let raw = String(d || '').trim();
  if (!raw) return '';

  const AY_MAP = {
    ocak: 1, subat: 2, şubat: 2, mart: 3, nisan: 4, mayis: 5, mayıs: 5,
    haziran: 6, temmuz: 7, agustos: 8, ağustos: 8, eylul: 9, eylül: 9,
    ekim: 10, kasim: 11, kasım: 11, aralik: 12, aralık: 12,
  };

  // "Haziran 2026" / "haziran-2026"
  const ayAd = raw.match(/^([A-Za-zÇĞİÖŞÜçğıöşü]+)\s*[\/\-\s]\s*(\d{4})$/i)
    || raw.match(/^([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})$/i);
  if (ayAd) {
    const key = ayAd[1].toLocaleLowerCase('tr-TR');
    const ayNo = AY_MAP[key];
    if (ayNo) return `${String(ayNo).padStart(2, '0')}/${ayAd[2]}`;
  }

  let s = raw.replace(/\s+/g, '');
  const same = s.match(/^(\d{1,2}\/\d{4})[-–—]\1$/i);
  if (same) {
    const [aa, yy] = same[1].split('/');
    return `${String(aa).padStart(2, '0')}/${yy}`;
  }
  const m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${String(m[1]).padStart(2, '0')}/${m[2]}`;
  const parts = s.split(/[-–—]/);
  if (parts.length === 2 && parts[0].replace(/\s/g, '') === parts[1].replace(/\s/g, '')) {
    const p = parts[0].match(/(\d{1,2})\/(\d{4})/);
    if (p) return `${String(p[1]).padStart(2, '0')}/${p[2]}`;
  }
  // Metin icinde MM/YYYY ara
  const embedded = raw.match(/(\d{1,2})\s*\/\s*(\d{4})/);
  if (embedded) return `${String(embedded[1]).padStart(2, '0')}/${embedded[2]}`;
  return raw;
}

function filterKalemler(kalemler) {
  const out = [];
  for (const k of kalemler || []) {
    const t = Number(k.tutar) || 0;
    // 0 TL satirlari makbuza/tabloda gosterme (bos manuel KDV dahil)
    if (!(t > 0)) continue;
    out.push({
      donem: normalizeDonem(k.donem),
      aciklama: makbuzAciklama(k.ad),
      ad: k.ad,
      tutar: t,
      vade: k.vade || '',
      fisNo: k.fisNo || '',
      kaynak: k.kaynak || '',
    });
  }
  return out;
}

function toplamKalem(list) {
  return (list || []).reduce((s, k) => s + (Number(k.tutar) || 0), 0);
}

/* ---------- Türkçe tutar yazisi (cek/makbuz stili, bitisik) ---------- */
const BIRLER = ['', 'BİR', 'İKİ', 'ÜÇ', 'DÖRT', 'BEŞ', 'ALTI', 'YEDİ', 'SEKİZ', 'DOKUZ'];
const ONLAR = ['', 'ON', 'YİRMİ', 'OTUZ', 'KIRK', 'ELLİ', 'ALTMİŞ', 'YETMİŞ', 'SEKSEN', 'DOKSAN'];

function ucBasamakYazi(n) {
  n = Math.floor(Number(n) || 0);
  if (n <= 0) return '';
  const yuz = Math.floor(n / 100);
  const on = Math.floor((n % 100) / 10);
  const bir = n % 10;
  let s = '';
  if (yuz === 1) s += 'YÜZ';
  else if (yuz > 1) s += BIRLER[yuz] + 'YÜZ';
  s += ONLAR[on] + BIRLER[bir];
  return s;
}

/**
 * 112943 → YÜZONİKİBİNDOKUZYÜZKIRKÜÇ TÜRK LİRASI
 */
function sayiyiYaziya(tutar) {
  let n = Math.floor(Math.abs(Number(tutar) || 0));
  const kurus = Math.round((Math.abs(Number(tutar) || 0) - n) * 100);
  if (n === 0 && kurus === 0) return 'SIFIR TÜRK LİRASI';

  const milyar = Math.floor(n / 1e9);
  n %= 1e9;
  const milyon = Math.floor(n / 1e6);
  n %= 1e6;
  const bin = Math.floor(n / 1e3);
  const yuzler = n % 1e3;

  let s = '';
  if (milyar) {
    s += (milyar === 1 ? 'BİR' : ucBasamakYazi(milyar)) + 'MİLYAR';
  }
  if (milyon) {
    s += (milyon === 1 ? 'BİR' : ucBasamakYazi(milyon)) + 'MİLYON';
  }
  if (bin) {
    s += (bin === 1 ? '' : ucBasamakYazi(bin)) + 'BİN';
  }
  s += ucBasamakYazi(yuzler);

  let out = `${s || 'SIFIR'} TÜRK LİRASI`;
  if (kurus > 0) {
    out += ` ${ucBasamakYazi(kurus)} KURUŞ`;
  }
  return out;
}

/**
 * Makbuz stili — ornek: MUHASEBE ÖDEME BİLDİRİM MAKBUZU
 */
function makbuzMetni({ firmaAdi, kalemler, tarih }) {
  const satirlar = filterKalemler(kalemler);
  const toplam = toplamKalem(satirlar);
  const tarihStr = tarih || bugunTarih();
  const musteri = String(firmaAdi || 'Müşteri').trim().toLocaleUpperCase('tr-TR');

  const lines = [];
  lines.push('MUHASEBE ÖDEME BİLDİRİM MAKBUZU');
  lines.push(`TARİH: ${tarihStr}`);
  lines.push('');
  lines.push(`MÜŞTERİ: ${musteri}`);
  lines.push('');
  lines.push('DÖNEM      AÇIKLAMA              TUTAR (₺)');
  lines.push('--------------------------------------------');
  for (const k of satirlar) {
    const donem = (k.donem || '-').padEnd(10, ' ');
    const aciklama = k.aciklama.slice(0, 20).padEnd(20, ' ');
    lines.push(`${donem}${aciklama}${formatTlSembol(k.tutar)}`);
  }
  lines.push('--------------------------------------------');
  lines.push(`TOPLAM: ${formatTlSembol(toplam)}`);
  lines.push('');
  lines.push(`YALNIZ: ${sayiyiYaziya(toplam)}`);
  return lines.join('\n');
}

/**
 * Tahakkuk stili — fis / donem / vade detayli
 */
function tahakkukMetni({ firmaAdi, vkn, donemEtiket, kalemler }) {
  const satirlar = filterKalemler(kalemler);
  const toplam = toplamKalem(satirlar);
  const lines = [];
  lines.push(`Sayın ${String(firmaAdi || 'Mükellef').trim()},`);
  lines.push('');
  lines.push('Tahakkuk özeti:');
  if (donemEtiket) lines.push(`Dönem etiketi: ${donemEtiket}`);
  if (vkn) lines.push(`VKN/TCKN: ${vkn}`);
  lines.push('');
  for (const k of satirlar) {
    const donem = k.donem ? ` · ${k.donem}` : '';
    const vade = k.vade ? ` · Vade: ${k.vade}` : '';
    const fis = k.fisNo ? ` · Fiş: ${k.fisNo}` : '';
    lines.push(`• ${k.ad || k.aciklama}${donem}${vade}${fis}`);
    lines.push(`  ${formatTlSembol(k.tutar)}`);
  }
  lines.push('');
  lines.push(`Genel toplam (ödenecek): ${formatTlSembol(toplam)}`);
  lines.push('');
  lines.push('Resmi tahakkuk fişi esas alınmalıdır.');
  return lines.join('\n');
}

/** Gorunur makbuz karti icin veri paketi */
function makbuzVeri(opts) {
  const satirlar = filterKalemler(opts?.kalemler);
  const toplam = toplamKalem(satirlar);
  return {
    baslik: 'MUHASEBE ÖDEME BİLDİRİM MAKBUZU',
    tarih: opts?.tarih || bugunTarih(),
    musteri: String(opts?.firmaAdi || 'Müşteri').trim().toLocaleUpperCase('tr-TR'),
    satirlar,
    toplam,
    toplamYazi: sayiyiYaziya(toplam),
    toplamFormat: formatTlSembol(toplam),
  };
}

function olusturMetin(opts) {
  const tip = normalizeTip(opts?.tip);
  if (tip === 'tahakkuk') return tahakkukMetni(opts);
  return makbuzMetni(opts);
}

/** wa.me icin telefon: sadece rakam, TR 05xx → 905xx */
function normalizeTelefon(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = `90${d.slice(1)}`;
  if (d.length === 10 && d.startsWith('5')) d = `90${d}`;
  return d;
}

function whatsappUrl(telefon, metin) {
  const phone = normalizeTelefon(telefon);
  const hasText = metin != null && String(metin).length > 0;
  if (phone && hasText) return `https://wa.me/${phone}?text=${encodeURIComponent(String(metin))}`;
  if (phone) return `https://wa.me/${phone}`;
  if (hasText) return `https://wa.me/?text=${encodeURIComponent(String(metin))}`;
  return 'https://wa.me/';
}

module.exports = {
  formatTl,
  formatTlSembol,
  makbuzMetni,
  tahakkukMetni,
  makbuzVeri,
  makbuzAciklama,
  normalizeDonem,
  sayiyiYaziya,
  bugunTarih,
  olusturMetin,
  normalizeTip,
  normalizeTelefon,
  whatsappUrl,
  toplamKalem,
  filterKalemler,
};
