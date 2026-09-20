/**
 * e-Fatura UBL XML → sebze/meyve (kg) stok Excel motoru
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const DEFAULT_EXCLUDE = [
  'NAKLİYE', 'NAKLIYE', 'KARGO', 'HİZMET', 'HIZMET', 'İŞÇİLİK', 'ISCILIK',
  'KOMİSYON', 'KOMISYON', 'STOPAJ', 'FATURA', 'MASRAF', 'KIRA', 'KİRA',
  'PEYNİR', 'PEYNIR', 'SUCUK', 'PİLİÇ', 'PILIC', 'TAVUK', 'DANA', 'KIYMA',
  'ET ', ' YOĞURT', 'YOGURT',
];

function stripExtensions(xml) {
  return xml.replace(/<ext:UBLExtensions[\s\S]*?<\/ext:UBLExtensions>/gi, '');
}

function tagText(xml, tag) {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`,
    'i'
  );
  const m = xml.match(re);
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
}

function tagAttr(xml, tag, attr) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b([^>]*)>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  const am = m[1].match(new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, 'i'));
  return am ? am[1] : '';
}

function allBlocks(xml, tag) {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`,
    'gi'
  );
  const blocks = [];
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[0]);
  return blocks;
}

function partyName(partyBlock) {
  if (!partyBlock) return '';
  // PartyName/Name — unvan
  const partyNameBlock = (partyBlock.match(
    /<(?:[\w-]+:)?PartyName\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?PartyName>/i
  ) || [])[0];
  if (partyNameBlock) {
    const n = tagText(partyNameBlock, 'Name');
    if (n) return n;
  }
  // Müstahsil karşı tarafı çoğu zaman sadece Person olarak gelir
  // (genel Name arama Country/Name = TÜRKİYE yakalar — kullanma)
  const personBlock = (partyBlock.match(
    /<(?:[\w-]+:)?Person\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?Person>/i
  ) || [])[0] || partyBlock;
  const first = tagText(personBlock, 'FirstName');
  const family = tagText(personBlock, 'FamilyName');
  return [first, family].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function isMustahsilMakbuz(xml, filePath) {
  const tip = (tagText(xml, 'CreditNoteTypeCode') || '').toUpperCase();
  if (tip.includes('MUSTAHSIL')) return true;
  const base = path.basename(filePath || '').toUpperCase();
  if (/^(M01|MS1)/.test(base)) return true;
  const rootCredit = /<(?:[\w-]+:)?CreditNote\b/i.test(xml);
  const profile = (tagText(xml, 'ProfileID') || '').toUpperCase();
  return rootCredit && profile === 'EARSIVBELGE';
}

/** VKN / TCKN / CompanyID değerlerini toplar */
function partyTaxIds(partyBlock) {
  if (!partyBlock) return [];
  const ids = new Set();
  const re = /<(?:[\w-]+:)?ID\b([^>]*)>([^<]*)<\/(?:[\w-]+:)?ID>/gi;
  let m;
  while ((m = re.exec(partyBlock)) !== null) {
    const attrs = m[1] || '';
    const val = String(m[2] || '').replace(/\s+/g, '').trim();
    if (!val) continue;
    const scheme = ((attrs.match(/schemeID\s*=\s*"([^"]*)"/i) || [])[1] || '').toUpperCase();
    if (['VKN', 'TCKN', 'VKN_TCKN'].includes(scheme)) ids.add(val);
  }
  const companyId = String(tagText(partyBlock, 'CompanyID') || '').replace(/\s+/g, '').trim();
  if (companyId) ids.add(companyId);
  return [...ids];
}

function normalizeMarker(m) {
  return String(m || '').replace(/\s+/g, '').trim();
}

function parseFloatSafe(val) {
  if (val == null || val === '') return 0;
  const n = parseFloat(String(val).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Unvan parçası VEYA VKN/TC ile eşleşir */
function isFirma(name, taxIds, markers) {
  const nameU = (name || '').toUpperCase();
  const idSet = new Set((taxIds || []).map((id) => normalizeMarker(id)));
  for (const raw of markers) {
    if (!raw) continue;
    const marker = String(raw).trim();
    const digits = normalizeMarker(marker);
    if (/^\d{10,11}$/.test(digits)) {
      if (idSet.has(digits)) return true;
      continue;
    }
    if (marker && nameU.includes(marker.toUpperCase())) return true;
    if (digits && idSet.has(digits)) return true;
  }
  return false;
}

function isStockItem(name, unit, excludeKeywords) {
  if (!name) return false;
  const unitU = (unit || '').toUpperCase();
  if (unitU && !['KGM', 'KG', 'KILO'].includes(unitU)) return false;
  if (/^\d{5,}$/.test(name.trim())) return false;
  const n = name.toUpperCase();
  for (const kw of excludeKeywords) {
    if (kw && n.includes(String(kw).toUpperCase())) return false;
  }
  return true;
}

/**
 * Ana ürün kelimeleri (uzun → kısa).
 * "SALKIM DOMATES" / "ÇERY DOMATES" → DOMATES
 */
const ANA_URUNLER = [
  'BRÜKSEL LAHANASI', 'BRÜKSEL LAHANA', 'MALTA ERİĞİ', 'YENİ DÜNYA',
  'SALATALIK', 'DOMATES', 'PATLICAN', 'KARNABAHAR', 'MANDALİNA',
  'PORTAKAL', 'NEKTARİN', 'ŞEFTALİ', 'SARIMSAK', 'FASULYE', 'FASÜLYE',
  'BROKOLİ', 'KARPUZ', 'GREYFURT', 'ENGİNAR', 'KAYISI', 'BİBER',
  'SALATA', 'ARMUT', 'KAVUN', 'LIMON', 'LİMON', 'KİRAZ', 'ÜZÜM',
  'KABAK', 'BAKLA', 'ELMA', 'AYVA', 'ERİK', 'ERIK', 'MUZ', 'NAR',
  'DUT', 'KİVİ', 'MISIR', 'HURMA', 'KUMKUAT', 'KAMKAT',
].map((s) => s.toLocaleUpperCase('tr-TR'));

/** Tek başına / kısaltma yazılanlar → ana ürün */
const URUN_ESANLAM = {
  HIYAR: 'SALATALIK',
  'HIYAR DİKENLİ': 'SALATALIK',
  SİLÖR: 'SALATALIK',
  SILOR: 'SALATALIK',
  SİLOR: 'SALATALIK',
  SLOR: 'SALATALIK',
  FASÜLYE: 'FASULYE',
  KAYSI: 'KAYISI',
  ERIK: 'ERİK',
  PEMBE: 'DOMATES',
  DOMAT: 'DOMATES',
  KOKTEYL: 'DOMATES',
  KOKTEY: 'DOMATES',
  KOKTEYLL: 'DOMATES',
  BAMBUS: 'DOMATES',
  ELİKA: 'DOMATES',
  ÇERY: 'DOMATES',
  CERY: 'DOMATES',
  CHERRY: 'DOMATES',
  ÇRY: 'DOMATES',
  CRY: 'DOMATES',
  PETEMEK: 'DOMATES',
  SALKIM: 'DOMATES',

  KAPYA: 'BİBER',
  DOLMA: 'BİBER',
  DOLMALIK: 'BİBER',
  SİVRİ: 'BİBER',
  KILSİVRİ: 'BİBER',
  KILÇIK: 'BİBER',
  ÇARLİSTON: 'BİBER',
  CARLISTON: 'BİBER',
  ÇARLİ: 'BİBER',
  CARLI: 'BİBER',
  ÜÇBURUN: 'BİBER',
  ŞİLİ: 'BİBER',
  KALİFORNİYA: 'BİBER',
  KALİFORNİA: 'BİBER',
  KÖYBİBERİ: 'BİBER',
  'KÖY BİBERİ': 'BİBER',
  'TOPA PAT': 'PATLICAN',
  MALTA: 'MALTA ERİĞİ',
  FİNİKE: 'PORTAKAL',
  VALENCİA: 'PORTAKAL',
  WASHİNGTON: 'PORTAKAL',
  WMURCOT: 'MANDALİNA',
  NEKTERİN: 'NEKTARİN',
  ŞEFTYALİ: 'ŞEFTALİ',
  TAZESARIMSAK: 'SARIMSAK',
  SALTALIK: 'SALATALIK',
  SALATA: 'SALATALIK',
};

/**
 * Stok birleştirme:
 * - "DOMATES 1" → DOMATES
 * - "SALKIM DOMATES" / "ÇRY DOMATES" → DOMATES (içindeki ana kelime)
 * Detay satırında orijinal ad kalır; özet/stokta birleşir.
 */
function normalizeUrunAdi(name) {
  let u = String(name || '')
    .toLocaleUpperCase('tr-TR')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // "(20) 1073359... - SALKIM DOMATES" → "SALKIM DOMATES"
  u = u.replace(/^\(\d+\)\s*\d+\s*[-–]\s*/, '');
  u = u.replace(/^\d{10,}\s*[-–]\s*/, '');

  let prev;
  do {
    prev = u;
    u = u
      .replace(/[\s\-_/]+(?:NO\.?|N[OİI]\.?|:)?\s*\d+\s*$/i, '')
      .replace(/\s*\(\s*\d+\s*\)\s*$/, '')
      .replace(/\s*#\s*\d+\s*$/, '')
      .replace(/\s+[IVX]+\.?\s*$/i, '') // I, II, I.
      .replace(/\s*(İKİNCİ|IKINCI|DİĞER|DIGER|KG)\s*$/i, '')
      .replace(/\d+\s*$/, '')
      .replace(/[()[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } while (u !== prev && u);

  if (!u) return String(name || '').trim().toLocaleUpperCase('tr-TR');

  // 1) Tam eşanlam / kısaltma
  if (URUN_ESANLAM[u]) return URUN_ESANLAM[u];

  // 2) İçinde geçen ana kelime (en uzun eşleşme kazanır)
  let best = '';
  for (const ana of ANA_URUNLER) {
    if (u.includes(ana) && ana.length > best.length) best = ana;
  }
  if (best) {
    if (best === 'FASÜLYE') return 'FASULYE';
    if (best === 'ERIK') return 'ERİK';
    if (best === 'LIMON') return 'LİMON';
    if (best === 'SALATA') return 'SALATALIK';
    return best;
  }

  // 3) Kısmi eşanlam (örn. "KOKTEYL YUVARLAK", "SİLÖR PAKET")
  const esKeys = Object.keys(URUN_ESANLAM).sort((a, b) => b.length - a.length);
  for (const key of esKeys) {
    if (u.includes(key)) return URUN_ESANLAM[key];
  }

  return u;
}

function parseInvoice(filePath, markers, excludeKeywords) {
  let xml;
  try {
    xml = stripExtensions(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }

  const issueDate = tagText(xml, 'IssueDate');
  const invType = tagText(xml, 'InvoiceTypeCode') || tagText(xml, 'CreditNoteTypeCode');
  const profile = tagText(xml, 'ProfileID');
  const mustahsil = isMustahsilMakbuz(xml, filePath);

  const supplierBlock = (xml.match(
    /<(?:[\w-]+:)?AccountingSupplierParty\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?AccountingSupplierParty>/i
  ) || [])[0];
  const customerBlock = (xml.match(
    /<(?:[\w-]+:)?AccountingCustomerParty\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?AccountingCustomerParty>/i
  ) || [])[0];

  const supplier = partyName(supplierBlock);
  const customer = partyName(customerBlock);
  const supplierIds = partyTaxIds(supplierBlock);
  const customerIds = partyTaxIds(customerBlock);

  let yon;
  let karsiTaraf;
  const firmaSatici = isFirma(supplier, supplierIds, markers);
  const firmaAlici = isFirma(customer, customerIds, markers);

  if (mustahsil) {
    // e-Müstahsil: belgeyi mükellef keser (supplier) ama ekonomik olarak ALIŞtır
    if (!firmaSatici && !firmaAlici) return [];
    yon = 'GELEN';
    karsiTaraf = firmaSatici
      ? (customer || customerIds.join('/'))
      : (supplier || supplierIds.join('/'));
  } else if (firmaSatici) {
    yon = 'GİDEN';
    karsiTaraf = customer || customerIds.join('/');
  } else if (firmaAlici) {
    yon = 'GELEN';
    karsiTaraf = supplier || supplierIds.join('/');
  } else {
    return [];
  }

  // UBLExtensions (imza) silindikten sonra ilk ID genelde fatura / makbuz no
  const idMatch = xml.match(
    /<(?:[\w-]+:)?ID\b[^>]*>([^<]+)<\/(?:[\w-]+:)?ID>/i
  );
  const faturaNo = idMatch ? idMatch[1].trim() : '';

  const folder = path.basename(path.dirname(filePath));
  const rows = [];

  // Normal fatura: InvoiceLine / InvoicedQuantity
  // Müstahsil makbuzu: CreditNoteLine / CreditedQuantity
  const lineTag = mustahsil || /CreditNoteLine/i.test(xml) ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = lineTag === 'CreditNoteLine' ? 'CreditedQuantity' : 'InvoicedQuantity';

  for (const line of allBlocks(xml, lineTag)) {
    const qty = tagText(line, qtyTag);
    const unit = tagAttr(line, qtyTag, 'unitCode');
    const itemBlock = (line.match(
      /<(?:[\w-]+:)?Item\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?Item>/i
    ) || [])[0] || '';
    const itemName = tagText(itemBlock, 'Name');
    const brand = tagText(itemBlock, 'BrandName');
    const sku = tagText(
      (itemBlock.match(
        /<(?:[\w-]+:)?SellersItemIdentification\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?SellersItemIdentification>/i
      ) || [])[0] || '',
      'ID'
    );

    let malHks = '';
    for (const aid of allBlocks(itemBlock, 'AdditionalItemIdentification')) {
      const scheme = tagAttr(aid, 'ID', 'schemeID');
      if (scheme === 'MALHKSID' || scheme === 'KUNYENO') {
        malHks = tagText(aid, 'ID');
        if (scheme === 'MALHKSID') break;
      }
    }

    if (!isStockItem(itemName, unit, excludeKeywords)) continue;

    const price = tagText(
      (line.match(/<(?:[\w-]+:)?Price\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?Price>/i) || [])[0] || '',
      'PriceAmount'
    );
    const lineAmt = tagText(line, 'LineExtensionAmount');
    const taxAmt = tagText(
      (line.match(/<(?:[\w-]+:)?TaxTotal\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?TaxTotal>/i) || [])[0] || '',
      'TaxAmount'
    );
    const lineNo = tagText(line, 'ID');

    rows.push({
      Klasor: folder,
      FaturaNo: faturaNo,
      Tarih: issueDate,
      Yon: yon,
      FaturaTipi: invType || (mustahsil ? 'MUSTAHSILMAKBUZ' : ''),
      Profil: profile,
      KarsiTaraf: karsiTaraf,
      SatirNo: lineNo,
      Urun: itemName,
      UrunKodu: sku,
      HKS: malHks,
      Kalite: brand,
      Miktar_KG: parseFloatSafe(qty),
      Birim: unit || 'KGM',
      BirimFiyat: parseFloatSafe(price),
      Tutar: parseFloatSafe(lineAmt),
      KDV: parseFloatSafe(taxAmt),
      Dosya: path.basename(filePath),
    });
  }

  return rows;
}

function collectXmlFiles(rootDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.xml')) out.push(full);
    }
  }
  walk(rootDir);
  return out.sort();
}

async function styleHeader(sheet, ncols) {
  for (let col = 1; col <= ncols; col++) {
    const cell = sheet.getCell(1, col);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  }
}

function autosize(sheet, maxWidth = 45) {
  sheet.columns.forEach((col) => {
    let length = 10;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const val = cell.value == null ? '' : String(cell.value);
      length = Math.max(length, Math.min(val.length + 2, maxWidth));
    });
    col.width = length;
  });
}

async function writeSheet(wb, title, headers, rows) {
  const ws = wb.addWorksheet(title);
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  await styleHeader(ws, headers.length);
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: headers.length },
  };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  autosize(ws);
  return ws;
}

async function buildWorkbook(allRows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Muşavirim Stok Kontrol';

  const detailHeaders = [
    'Klasör', 'Fatura No', 'Tarih', 'Yön', 'Fatura Tipi', 'Karşı Taraf', 'Satır No',
    'Ürün', 'Ürün Kodu', 'HKS Kod', 'Kalite', 'Miktar (KG)', 'Birim',
    'Birim Fiyat', 'Tutar (KDV Hariç)', 'KDV', 'Dosya',
  ];
  const sorted = [...allRows].sort((a, b) =>
    `${a.Tarih}|${a.FaturaNo}|${a.SatirNo}`.localeCompare(`${b.Tarih}|${b.FaturaNo}|${b.SatirNo}`)
  );
  const toDetail = (r) => [
    r.Klasor, r.FaturaNo, r.Tarih, r.Yon, r.FaturaTipi, r.KarsiTaraf, r.SatirNo,
    r.Urun, r.UrunKodu, r.HKS, r.Kalite, r.Miktar_KG, r.Birim,
    r.BirimFiyat, r.Tutar, r.KDV, r.Dosya,
  ];
  const detailData = sorted.map(toDetail);
  await writeSheet(wb, 'Detay', detailHeaders, detailData);

  // Alış / satış ayrı sayfalar (Teksel stok mantığı)
  const alisData = sorted.filter((r) => r.Yon === 'GELEN').map(toDetail);
  const satisData = sorted.filter((r) => r.Yon === 'GİDEN').map(toDetail);
  await writeSheet(wb, 'Alis_Faturalar', detailHeaders, alisData);
  await writeSheet(wb, 'Satis_Faturalar', detailHeaders, satisData);

  const byUrun = new Map();
  const counts = new Map();
  for (const r of allRows) {
    const u = normalizeUrunAdi(r.Urun);
    if (!byUrun.has(u)) {
      byUrun.set(u, { GELEN: 0, GİDEN: 0, GELEN_TUTAR: 0, GIDEN_TUTAR: 0 });
    }
    const g = byUrun.get(u);
    g[r.Yon] += r.Miktar_KG;
    if (r.Yon === 'GELEN') g.GELEN_TUTAR += r.Tutar;
    else g.GIDEN_TUTAR += r.Tutar;
    counts.set(u, (counts.get(u) || 0) + 1);
  }

  const ozetHeaders = [
    'Ürün', 'Gelen KG (Alış)', 'Giden KG (Satış)', 'Net Stok KG (Gelen - Giden)',
    'Alış Tutarı', 'Satış Tutarı', 'Satır Sayısı',
  ];
  const ozetData = [...byUrun.keys()].sort().map((urun) => {
    const g = byUrun.get(urun);
    return [
      urun,
      round(g.GELEN, 3),
      round(g.GİDEN, 3),
      round(g.GELEN - g.GİDEN, 3),
      round(g.GELEN_TUTAR, 2),
      round(g.GIDEN_TUTAR, 2),
      counts.get(urun) || 0,
    ];
  });
  await writeSheet(wb, 'Urun_Ozet', ozetHeaders, ozetData);

  const stokHeaders = [
    'Ürün', 'Kalan Stok KG', 'Ortalama Alış Fiyatı (TL/KG)',
    'Ortalama Satış Fiyatı (TL/KG)', 'Ortalama Fiyat (Alış+Satış, TL/KG)',
    'Gelen KG', 'Giden KG',
  ];
  const stokData = [...byUrun.keys()].map((urun) => {
    const g = byUrun.get(urun);
    const gelenKg = g.GELEN;
    const gidenKg = g.GİDEN;
    const kalan = gelenKg - gidenKg;
    const ortAlis = gelenKg > 0 ? g.GELEN_TUTAR / gelenKg : null;
    const ortSatis = gidenKg > 0 ? g.GIDEN_TUTAR / gidenKg : null;
    const toplamKg = gelenKg + gidenKg;
    const toplamTutar = g.GELEN_TUTAR + g.GIDEN_TUTAR;
    const ortGenel = toplamKg > 0 ? toplamTutar / toplamKg : null;
    return [
      urun,
      round(kalan, 3),
      ortAlis != null ? round(ortAlis, 2) : '-',
      ortSatis != null ? round(ortSatis, 2) : '-',
      ortGenel != null ? round(ortGenel, 2) : '-',
      round(gelenKg, 3),
      round(gidenKg, 3),
    ];
  });
  stokData.sort((a, b) => (typeof b[1] === 'number' ? b[1] : 0) - (typeof a[1] === 'number' ? a[1] : 0));
  await writeSheet(wb, 'Stok_Durum', stokHeaders, stokData);

  const byAyUrun = new Map();
  for (const r of allRows) {
    const ay = (r.Tarih || '').slice(0, 7);
    const u = normalizeUrunAdi(r.Urun);
    const key = `${ay}|${u}`;
    if (!byAyUrun.has(key)) byAyUrun.set(key, { ay, urun: u, GELEN: 0, GİDEN: 0 });
    byAyUrun.get(key)[r.Yon] += r.Miktar_KG;
  }
  const ayHeaders = ['Ay', 'Ürün', 'Gelen KG', 'Giden KG', 'Net KG'];
  const ayData = [...byAyUrun.values()]
    .sort((a, b) => `${a.ay}|${a.urun}`.localeCompare(`${b.ay}|${b.urun}`))
    .map((g) => [g.ay, g.urun, round(g.GELEN, 3), round(g.GİDEN, 3), round(g.GELEN - g.GİDEN, 3)]);
  await writeSheet(wb, 'Aylik_Ozet', ayHeaders, ayData);

  const yonAgg = new Map();
  for (const r of allRows) {
    if (!yonAgg.has(r.Yon)) yonAgg.set(r.Yon, { kg: 0, tutar: 0, satir: 0, faturalar: new Set() });
    const v = yonAgg.get(r.Yon);
    v.kg += r.Miktar_KG;
    v.tutar += r.Tutar;
    v.satir += 1;
    v.faturalar.add(r.FaturaNo);
  }
  const yonHeaders = ['Yön', 'Toplam KG', 'Toplam Tutar', 'Satır Sayısı', 'Fatura Sayısı'];
  const yonData = [...yonAgg.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([yon, v]) => [yon, round(v.kg, 3), round(v.tutar, 2), v.satir, v.faturalar.size]);
  await writeSheet(wb, 'Yon_Ozet', yonHeaders, yonData);

  return { wb, byUrun, stokData };
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function sanitizeFilePart(name) {
  return String(name || 'Firma')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'Firma';
}

/**
 * @param {object} opts
 * @param {string} opts.klasor - XML kök klasörü
 * @param {string[]} opts.markers - firma anahtar kelimeleri
 * @param {string[]} [opts.excludeKeywords]
 * @param {string} [opts.ciktiYolu] - tam xlsx yolu; yoksa klasör içine üretir
 * @param {string} [opts.firmaAdi] - dosya adı için
 */
async function isle(opts) {
  const markers = (opts.markers || []).map((m) => String(m).trim()).filter(Boolean);
  if (!markers.length) {
    return { ok: false, msg: 'VKN, TC kimlik no veya unvan parçası girin.' };
  }
  if (!opts.klasor || !fs.existsSync(opts.klasor)) {
    return { ok: false, msg: 'XML klasörü bulunamadı.' };
  }

  const excludeKeywords = (opts.excludeKeywords && opts.excludeKeywords.length)
    ? opts.excludeKeywords
    : DEFAULT_EXCLUDE;

  const xmlFiles = collectXmlFiles(opts.klasor);
  const allRows = [];
  for (const p of xmlFiles) {
    allRows.push(...parseInvoice(p, markers, excludeKeywords));
  }

  const { wb, byUrun, stokData } = await buildWorkbook(allRows);

  const firma = sanitizeFilePart(opts.firmaAdi || markers[0]);
  let outPath = opts.ciktiYolu;
  if (!outPath) {
    outPath = path.join(opts.klasor, `${firma}_Stok_Kontrol_Sebze_Meyve.xlsx`);
  }

  try {
    await wb.xlsx.writeFile(outPath);
  } catch (err) {
    if (err.code === 'EBUSY' || /locked|EPERM|EBUSY/i.test(err.message)) {
      const alt = outPath.replace(/\.xlsx$/i, '_Yeni.xlsx');
      await wb.xlsx.writeFile(alt);
      outPath = alt;
    } else {
      throw err;
    }
  }

  return {
    ok: true,
    xmlSayisi: xmlFiles.length,
    satir: allRows.length,
    urun: byUrun.size,
    cikti: outPath,
    ornekStok: stokData.slice(0, 8).map((r) => ({
      urun: r[0],
      kalan: r[1],
      ortAlis: r[2],
      ortSatis: r[3],
    })),
  };
}

module.exports = {
  isle,
  DEFAULT_EXCLUDE,
  collectXmlFiles,
  parseInvoice,
  normalizeUrunAdi,
};
