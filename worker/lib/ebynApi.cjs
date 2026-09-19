'use strict';

/**
 * e-Beyanname (ebeyanname.gib.gov.tr)
 * Beyanname Ara → tahakkuk fişi PDF → tutar parse
 */

const https = require('https');
const zlib = require('zlib');
const { URLSearchParams } = require('url');
const { TextDecoder } = require('util');

const HOST = 'ebeyanname.gib.gov.tr';
const BASE = `https://${HOST}`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function request(method, pathOrUrl, body, headers = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`;
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        ...headers,
      },
    };
    if (body != null) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
      if (!opts.headers['Content-Type']) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          buf: Buffer.concat(chunks),
          contentType: res.headers['content-type'] || '',
          contentDisposition: res.headers['content-disposition'] || '',
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('e-Beyanname zaman asimi')));
    if (body != null) req.write(body);
    req.end();
  });
}

function parseTag(xml, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open);
  if (start < 0) return '';
  const valStart = start + open.length;
  const end = xml.indexOf(close, valStart);
  if (end < 0) return '';
  return xml.slice(valStart, end);
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '')
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function monthRange(yil, ay) {
  const y = Number(yil);
  const a = Number(ay);
  const son = new Date(y, a, 0).getDate();
  return {
    baslangicTarihi: `${y}${pad2(a)}01`,
    bitisTarihi: `${y}${pad2(a)}${pad2(son)}`,
    baslangicTarihiGun: '01',
    baslangicTarihiAy: pad2(a),
    baslangicTarihiYil: String(y),
    bitisTarihiGun: pad2(son),
    bitisTarihiAy: pad2(a),
    bitisTarihiYil: String(y),
  };
}

function recentMonths(count = 2) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < count; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ yil: x.getFullYear(), ay: x.getMonth() + 1 });
  }
  return out;
}

/** Dönem MM/YYYY ifadesi beyanname donem alanında var mı (06/2026-06/2026 vb.) */
function donemMatches(donemStr, yil, ay) {
  const needle = `${pad2(ay)}/${yil}`;
  return String(donemStr || '').includes(needle);
}

/** Vergi dönemi seçilince GIB'de taranacak yükleme ayları (dönem + 2 ay sonrası) */
function yuklemeAylariForDonem(yil, ay) {
  const out = [];
  let y = Number(yil);
  let a = Number(ay);
  for (let i = 0; i < 3; i++) {
    out.push({ yil: y, ay: a });
    a += 1;
    if (a > 12) {
      a = 1;
      y += 1;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EbynSession {
  constructor() {
    this.token = null;
    this._lastReqAt = 0;
  }

  async _pace() {
    const minGap = 1200;
    const wait = this._lastReqAt + minGap - Date.now();
    if (wait > 0) await sleep(wait);
    this._lastReqAt = Date.now();
  }

  async login({ kullanici, parola, sifre }) {
    await this._pace();
    const body = new URLSearchParams({
      username: String(kullanici || '').trim(),
      password2: String(parola || ''),
      password1: String(sifre || ''),
      eyekscommand: 'ajaxlogin',
      redirectionpath: 'context1',
    }).toString();
    const res = await request('POST', '/eyeks', body, {
      Origin: BASE,
      Referer: `${BASE}/giris.html`,
    });
    const xml = res.buf.toString('utf8');
    const err = parseTag(xml, 'ERROR');
    if (err) throw new Error(err);
    const token = parseTag(xml, 'TOKEN');
    if (!token) throw new Error('e-Beyanname TOKEN alinamadi');
    const changePwd = parseTag(xml, 'CHANGEPWD') === 'TRUE';

    await this._pace();
    const boot = await request(
      'GET',
      `/dispatch?cmd=LOGIN&TOKEN=${token}`,
      null,
      { Referer: `${BASE}/giris.html` },
    );
    const html = boot.buf.toString('utf8');
    this.token =
      (html.match(/id="TOKEN"[^>]*value="([^"]+)"/i) || [])[1] || token;
    return { token: this.token, changePwd };
  }

  async dispatch(fields, { retries = 2 } = {}) {
    if (!this.token) throw new Error('e-Beyanname oturumu yok');
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this._pace();
      const body = new URLSearchParams({ TOKEN: this.token, ...fields }).toString();
      const res = await request('POST', '/dispatch', body, {
        Origin: BASE,
        Referer: `${BASE}/dispatch`,
      });
      const text = res.buf.toString('utf8');
      const next = parseTag(text, 'TOKEN');
      if (next) this.token = next;
      const serverError = parseTag(text, 'SERVERERROR');
      const eyeksError = parseTag(text, 'EYEKSERROR');
      const errText = serverError || eyeksError;
      if (errText) {
        lastErr = new Error(errText);
        if (/en az\s*1\s*sn|1 sn olabilir/i.test(errText) && attempt < retries) {
          await sleep(1500);
          continue;
        }
        throw lastErr;
      }
      return { text, buf: res.buf, contentType: res.contentType };
    }
    throw lastErr || new Error('e-Beyanname istek basarisiz');
  }

  async listBeyanname({ vknTckn, yil, ay, durum = '0', donemYil, donemAy }) {
    const id = String(vknTckn || '').trim();
    if (!/^\d{10,11}$/.test(id)) {
      throw new Error('e-Beyanname icin VKN (10) veya TCKN (11) gerekli');
    }
    const isTckn = id.length === 11;
    await this.dispatch({ cmd: 'BEYANNAMESORGU' });
    const range = monthRange(yil, ay);
    const fields = {
      cmd: 'BEYANNAMELISTESI',
      ...(isTckn
        ? { sorguTipiT: '1', tcKimlikNo: id }
        : { sorguTipiN: '1', vergiNo: id }),
      sorguTipiZ: '1',
      durum: String(durum),
      ...range,
    };
    // Dönem filtresi: GIB ayı sıfırsız bekliyor (6, 06 değil)
    if (donemYil && donemAy) {
      fields.sorguTipiP = '1';
      fields.donemBasAy = String(Number(donemAy));
      fields.donemBasYil = String(donemYil);
      fields.donemBitAy = String(Number(donemAy));
      fields.donemBitYil = String(donemYil);
    }
    let text;
    try {
      ({ text } = await this.dispatch(fields));
    } catch (err) {
      if (/uymayan|bulunamam/i.test(err.message)) return [];
      throw err;
    }
    return parseBeyannameList(text);
  }

  /**
   * Vergi dönemine göre ara (ör. 06/2026).
   * GIB listeyi yükleme tarihiyle verdiği için dönem ayı + sonraki 2 ay taranır,
   * sonuçlar donem alanına göre süzülür.
   */
  async listByVergiDonemi({ vknTckn, yil, ay }) {
    const seen = new Set();
    const out = [];
    const windows = yuklemeAylariForDonem(yil, ay);
    for (const w of windows) {
      let rows = [];
      try {
        rows = await this.listBeyanname({
          vknTckn,
          yil: w.yil,
          ay: w.ay,
          donemYil: yil,
          donemAy: ay,
        });
      } catch (err) {
        if (!/uymayan|bulunamam/i.test(err.message)) throw err;
      }
      // Dönem filtresi GIB'de bazen boş döner; yükleme penceresini de dene
      if (!rows.length) {
        try {
          rows = await this.listBeyanname({
            vknTckn,
            yil: w.yil,
            ay: w.ay,
          });
        } catch (err) {
          if (!/uymayan|bulunamam/i.test(err.message)) throw err;
          rows = [];
        }
      }
      for (const row of rows) {
        if (!donemMatches(row.donem, yil, ay)) continue;
        const key = `${row.beyannameOid}:${row.tahakkukOid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
      }
    }
    return out;
  }

  async downloadTahakkukPdf({ beyannameOid, tahakkukOid }) {
    await this._pace();
    // GIB bazen oid'yi zaten %xx encoded verir; encodeURIComponent çift kodlama yapmasın
    const url =
      `${BASE}/dispatch?cmd=IMAJ&subcmd=TAHAKKUKGORUNTULE&TOKEN=${this.token}` +
      `&beyannameOid=${String(beyannameOid || '')}` +
      `&tahakkukOid=${String(tahakkukOid || '')}&inline=true`;
    const res = await request('GET', url, null, {
      Referer: `${BASE}/dispatch`,
    });
    if (!res.buf.slice(0, 4).equals(Buffer.from('%PDF'))) {
      const t = res.buf.toString('utf8');
      const err = parseTag(t, 'SERVERERROR') || parseTag(t, 'EYEKSERROR') || 'PDF alinamadi';
      // GIB gecici hatalari ("en az 1 sn", "Bir sistem hatası oluştu") — artan bekleme ile tekrar dene
      const gecici = /en az\s*1\s*sn|1 sn olabilir|sistem hatas|daha sonra tekrar|yogun|meşgul|mesgul/i.test(err);
      if (gecici) {
        for (const bekle of [1500, 3000, 5000]) {
          await sleep(bekle);
          await this._pace();
          const tekrar = await request('GET', url, null, {
            Referer: `${BASE}/dispatch`,
          });
          if (tekrar.buf.slice(0, 4).equals(Buffer.from('%PDF'))) {
            const filename =
              ((tekrar.contentDisposition || '').match(/filename=([^;]+)/i) || [])[1] ||
              `tahakkuk_${tahakkukOid}.pdf`;
            return { pdf: tekrar.buf, filename: filename.replace(/["']/g, '') };
          }
        }
      }
      throw new Error(err);
    }
    const filename =
      ((res.contentDisposition || '').match(/filename=([^;]+)/i) || [])[1] ||
      `tahakkuk_${tahakkukOid}.pdf`;
    return { pdf: res.buf, filename: filename.replace(/["']/g, '') };
  }
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBeyannameList(html) {
  const rows = [];
  const trs = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const tr of trs) {
    const raw = tr[1];
    const cells = [...raw.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((c) => stripTags(c[1]))
      .filter(Boolean);
    const tah = raw.match(
      /tahakkukGoruntule\('([^']+)','([^']+)',(true|false),(true|false)\)/,
    );
    if (!tah) continue;
    rows.push({
      beyannameOid: tah[1],
      tahakkukOid: tah[2],
      arsiv: tah[3] === 'true',
      tur: cells[0] || '',
      vknTckn: cells[1] || '',
      unvan: cells[2] || '',
      vergiDairesi: cells[3] || '',
      donem: cells[4] || '',
      sube: cells[5] || '',
      yuklemeZamani: cells[6] || '',
      vergiTahakkukDurumu: cells[7] || '',
      sgkTahakkukDurumu: cells[8] || '',
    });
  }
  return rows;
}

function unescapePdfString(s) {
  return String(s || '')
    .replace(/\\([nrtbf()\\])/g, (_, c) => {
      const map = {
        n: '\n', r: '\r', t: '\t', b: '\b', f: '\f',
        '(': '(', ')': ')', '\\': '\\',
      };
      return map[c] || c;
    })
    .replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

function extractPdfTjStrings(pdfBuf) {
  const raw = pdfBuf.toString('latin1');
  const streams = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(raw))) {
    const data = Buffer.from(m[1], 'latin1');
    for (const fn of [
      () => zlib.inflateSync(data),
      () => zlib.unzipSync(data),
      () => zlib.inflateRawSync(data),
    ]) {
      try {
        streams.push(fn());
        break;
      } catch {
        /* next */
      }
    }
  }
  if (!streams.length) return [];
  const decoded = new TextDecoder('windows-1254').decode(Buffer.concat(streams));
  return [...decoded.matchAll(/\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g)].map((x) =>
    unescapePdfString(x[1]),
  );
}

function kodAdi(kod, anaVergiKodu, anaVergiAdi) {
  if (kod === anaVergiKodu && anaVergiAdi) return anaVergiAdi;
  const map = {
    '0003': 'Gelir Vergisi (Muhtasar)',
    '1048': 'Damga Vergisi (STPJ)',
    '0015': 'KDV',
    '0121': 'KDV',
  };
  return map[kod] || `Vergi ${kod}`;
}

function parseTahakkukPdf(pdfBuf) {
  const tj = extractPdfTjStrings(pdfBuf);
  const moneyRe = /^\d{1,3}(?:\.\d{3})*,\d{2}$/;
  const dateRe = /^\d{2}\/\d{2}\/\d{4}$/;
  const codeRe = /^\d{4}$/;

  let anaVergiAdi = '';
  let anaVergiKodu = '';
  let donem = '';
  let fisNo = '';
  for (let i = 0; i < tj.length; i++) {
    if (/^\d{2}\/\d{4}-\d{2}\/\d{4}$/.test(tj[i])) donem = tj[i];
    if (/ana\s*vergi\s*kodu/i.test(tj[i]) && codeRe.test(tj[i + 1] || '')) {
      anaVergiKodu = tj[i + 1];
      if (tj[i + 2] && !moneyRe.test(tj[i + 2]) && !dateRe.test(tj[i + 2])) {
        anaVergiAdi = tj[i + 2];
      }
    }
    if (!fisNo && /^20\d{6}.+/.test(tj[i])) fisNo = tj[i];
  }

  const kalemler = [];
  let toplam = 0;
  const headerWords = new Set([
    'TÜRÜ', 'TURU', 'ORAN', 'MATRAH', 'VADESİ', 'VADESI',
    'ÖDENECEK', 'ODENECEK', 'OLAN', 'MAHSUP', 'EDİLEN', 'EDILEN',
    'TAHAKKUK', 'EDEN', 'TOPLAM',
  ]);

  for (let i = 0; i < tj.length; i++) {
    if (tj[i] === 'TOPLAM' && moneyRe.test(tj[i + 1] || '')) {
      toplam = toNumber(tj[i + 1]);
      continue;
    }

    // NAME + CODE + 4 money + date (ör. STPJ 1048 ...)
    if (
      tj[i]
      && !codeRe.test(tj[i])
      && !moneyRe.test(tj[i])
      && !dateRe.test(tj[i])
      && !headerWords.has(tj[i].toLocaleUpperCase('tr-TR'))
      && codeRe.test(tj[i + 1] || '')
      && moneyRe.test(tj[i + 2] || '')
      && moneyRe.test(tj[i + 3] || '')
      && moneyRe.test(tj[i + 4] || '')
      && moneyRe.test(tj[i + 5] || '')
      && dateRe.test(tj[i + 6] || '')
    ) {
      kalemler.push({
        kod: tj[i + 1],
        ad: tj[i] === 'STPJ' ? kodAdi(tj[i + 1], anaVergiKodu, anaVergiAdi) : `${tj[i]} / ${kodAdi(tj[i + 1], anaVergiKodu, anaVergiAdi)}`,
        matrah: toNumber(tj[i + 2]),
        tahakkukEden: toNumber(tj[i + 3]),
        mahsup: toNumber(tj[i + 4]),
        odenecek: toNumber(tj[i + 5]),
        vade: tj[i + 6],
      });
      i += 6;
      continue;
    }

    // CODE + 4 money + date
    if (
      codeRe.test(tj[i])
      && moneyRe.test(tj[i + 1] || '')
      && moneyRe.test(tj[i + 2] || '')
      && moneyRe.test(tj[i + 3] || '')
      && moneyRe.test(tj[i + 4] || '')
      && dateRe.test(tj[i + 5] || '')
    ) {
      kalemler.push({
        kod: tj[i],
        ad: kodAdi(tj[i], anaVergiKodu, anaVergiAdi),
        matrah: toNumber(tj[i + 1]),
        tahakkukEden: toNumber(tj[i + 2]),
        mahsup: toNumber(tj[i + 3]),
        odenecek: toNumber(tj[i + 4]),
        vade: tj[i + 5],
      });
      i += 5;
    }
  }

  if (!toplam && kalemler.length) {
    toplam = kalemler.reduce((s, k) => s + (k.odenecek || 0), 0);
  }

  return { anaVergiAdi, anaVergiKodu, donem, fisNo, toplam, kalemler, tj };
}

async function getTahakkuklar(opts) {
  const { kullanici, parola, sifre, vknTckn, aylar, session: existingSession } = opts || {};
  if (!existingSession && (!kullanici || !parola || !sifre)) {
    throw new Error('e-Beyanname kullanici / parola / sifre gerekli');
  }

  let session = existingSession;
  let oturum = { changePwd: false };
  if (!session) {
    session = new EbynSession();
    oturum = await session.login({ kullanici, parola, sifre });
  }
  // aylar = vergi dönemleri (yükleme değil)
  const donemler = Array.isArray(aylar) && aylar.length ? aylar : recentMonths(1);
  const seen = new Set();
  const beyannameler = [];

  for (const d of donemler) {
    const list = await session.listByVergiDonemi({
      vknTckn,
      yil: d.yil,
      ay: d.ay,
    });
    for (const row of list) {
      const key = `${row.beyannameOid}:${row.tahakkukOid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      beyannameler.push(row);
    }
  }

  const kalemler = [];
  const fisler = [];
  for (const row of beyannameler) {
    if (!row.tahakkukOid) continue;
    try {
      const { pdf, filename } = await session.downloadTahakkukPdf(row);
      const parsed = parseTahakkukPdf(pdf);
      const toplam =
        parsed.toplam > 0
          ? parsed.toplam
          : (parsed.kalemler || []).reduce((s, k) => s + (k.odenecek || 0), 0);
      const vade =
        (parsed.kalemler || []).find((k) => k.vade)?.vade || '';
      fisler.push({
        ...row,
        filename,
        fisNo: parsed.fisNo,
        donem: parsed.donem || row.donem || '',
        toplam,
        pdf,
      });

      // Makbuzda satır satır vergi kodu değil; fişteki TOPLAM (ödenecek) tek kalem
      if (toplam > 0) {
        const tur = String(row.tur || 'Tahakkuk').trim();
        kalemler.push({
          kaynak: 'ebyn',
          kod: parsed.anaVergiKodu || '',
          ad: `${tur} ödemesi`,
          donem: parsed.donem || row.donem || '',
          tutar: toplam,
          vade,
          beyannameTur: tur,
          fisNo: parsed.fisNo,
          filename,
          detay: (parsed.kalemler || [])
            .filter((k) => k.odenecek > 0)
            .map((k) => ({ ad: k.ad, kod: k.kod, tutar: k.odenecek, vade: k.vade })),
        });
      }
    } catch (err) {
      fisler.push({ ...row, hata: err.message });
    }
  }

  return {
    ok: true,
    changePwd: oturum.changePwd,
    beyannameler,
    fisler: fisler.map(({ pdf, ...rest }) => rest),
    kalemler,
    pdfMap: Object.fromEntries(
      fisler.filter((f) => f.pdf).map((f) => [f.tahakkukOid, {
        pdf: f.pdf,
        filename: f.filename,
        donem: f.donem || '',
        tur: f.tur || '',
        tahakkukOid: f.tahakkukOid,
      }]),
    ),
  };
}

async function testBaglanti({ kullanici, parola, sifre, vknTckn }) {
  try {
    const session = new EbynSession();
    const oturum = await session.login({ kullanici, parola, sifre });
    let msg = 'e-Beyanname giris basarili.';
    if (oturum.changePwd) {
      msg += ' (Sifre/parola degisiklik uyarisi var; cekim yine de calisabilir.)';
    }
    if (vknTckn) {
      const now = new Date();
      const list = await session.listBeyanname({
        vknTckn,
        yil: now.getFullYear(),
        ay: now.getMonth() + 1,
      });
      msg += ` Bu ay ${list.length} tahakkuklu beyanname.`;
    }
    return { ok: true, msg, changePwd: oturum.changePwd };
  } catch (err) {
    return { ok: false, msg: err.message || String(err) };
  }
}

module.exports = {
  EbynSession,
  getTahakkuklar,
  testBaglanti,
  parseTahakkukPdf,
  parseBeyannameList,
  donemMatches,
  yuklemeAylariForDonem,
  portalUrl: BASE,
  recentMonths,
  monthRange,
};
