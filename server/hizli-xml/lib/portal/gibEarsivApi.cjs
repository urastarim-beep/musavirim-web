/**
 * GİB e-Arşiv Portal (earsivportal.efatura.gov.tr)
 *
 * Gelen e-Arşiv: EARSIV_PORTAL_ADIMA_KESILEN_BELGELERI_GETIR (Adıma Düzenlenen)
 * Giden e-Arşiv: EARSIV_PORTAL_TASLAKLARI_GETIR (portalda kesilen)
 * İndirme: /earsiv-services/download → ZIP → XML
 *
 * Kimlik: İnteraktif Vergi Dairesi / e-Arşiv portal kullanıcı kodu + şifre
 * (EDM/ICE web servis kullanıcısı değil).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const BASE_URL = 'https://earsivportal.efatura.gov.tr';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FATURA_TURLERI = {
  gelen_arsiv: { ad: 'Gelen e-Arsiv (Adima Duzenlenen)', mode: 'adima' },
  gelen_earsiv: { ad: 'Gelen e-Arsiv (Adima Duzenlenen)', mode: 'adima' },
  arsiv: { ad: 'Giden e-Arsiv (GIB Portal)', mode: 'taslak' },
  earsiv: { ad: 'Giden e-Arsiv (GIB Portal)', mode: 'taslak' },
  giden: { ad: 'Giden e-Arsiv (GIB Portal)', mode: 'taslak' },
  tumu: { ad: 'Gelen + Giden e-Arsiv', mode: 'tumu' },
  gelen: { ad: 'Gelen e-Fatura', mode: null, unsupported: true },
  mustahsil: { ad: 'e-Mustahsil', mode: null, unsupported: true },
};

const TUM_TURLER = ['gelen_arsiv', 'arsiv'];
const DOWNLOAD_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 60000;

async function mapPool(items, concurrency, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => runner()));
  return results;
}

function aySonGunu(yil, ay) {
  return new Date(yil, ay, 0).getDate();
}

function toYilAy(yil, ay) {
  const y = Number(yil);
  const a = Number(ay);
  if (!Number.isFinite(y) || !Number.isFinite(a) || a < 1 || a > 12) {
    throw new Error(`Gecersiz donem: ${yil}/${ay}`);
  }
  return { yil: y, ay: a };
}

/** GİB portal tarihleri DD/MM/YYYY */
function formatTrDate(yil, ay, gun) {
  return `${String(gun).padStart(2, '0')}/${String(ay).padStart(2, '0')}/${yil}`;
}

function donemTarihleri(yilRaw, ayRaw) {
  const { yil, ay } = toYilAy(yilRaw, ayRaw);
  const son = aySonGunu(yil, ay);
  return {
    yil,
    ay,
    baslangic: formatTrDate(yil, ay, 1),
    bitis: formatTrDate(yil, ay, son),
  };
}

function firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, yil, ay) {
  const guvenli = String(firmaAdi || 'firma').replace(/[<>:"/\\|?*]/g, '_').trim();
  const ayStr = String(ay).padStart(2, '0');
  return path.join(indirmeKlasoru, `${guvenli}_${vkn || 'vkn'}`, String(yil), ayStr);
}

function callId() {
  return crypto.randomUUID();
}

function httpRequest(method, urlStr, { headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          buffer: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`GIB istek zaman asimi (${timeoutMs}ms)`));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function postForm(pathSuffix, fields) {
  const body = new URLSearchParams(fields).toString();
  const res = await httpRequest('POST', `${BASE_URL}${pathSuffix}`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Referer: `${BASE_URL}/intragiris.html`,
    },
    body,
  });
  const text = res.buffer.toString('utf8');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`GIB yanit JSON degil (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.error) {
    const msg =
      typeof json.messages === 'string'
        ? json.messages
        : Array.isArray(json.messages)
          ? json.messages.map((m) => m?.text || m).join('; ')
          : json.error;
    throw new Error(String(msg || json.error || 'GIB hata'));
  }
  return json;
}

async function login(userid, sifre) {
  // mlevent/fatura ile ayni: parola = sifre
  const pass = String(sifre || '');
  const json = await postForm('/earsiv-services/assos-login', {
    assoscmd: 'anologin',
    rtype: 'json',
    userid: String(userid || '').trim(),
    sifre: pass,
    sifre2: pass,
    parola: pass,
  });
  const token = json.token;
  if (!token) throw new Error('GIB giris basarisiz: token alinamadi');
  return token;
}

async function logout(token) {
  if (!token) return;
  try {
    await postForm('/earsiv-services/assos-login', {
      assoscmd: 'logout',
      rtype: 'json',
      token,
    });
  } catch {
    /* ignore */
  }
}

async function dispatch(token, cmd, pageName, jpObj) {
  return postForm('/earsiv-services/dispatch', {
    cmd,
    callid: callId(),
    pageName,
    token,
    jp: JSON.stringify(jpObj),
  });
}

function normalizeBelge(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ettn = String(raw.ettn || raw.ettnId || raw.uuid || '').trim();
  if (!ettn) return null;
  return {
    ettn,
    belgeNo: String(raw.belgeNo || raw.belgeNumarasi || raw.documentNumber || '').trim(),
    belgeTip: String(raw.belgeTuru || raw.belgeTip || 'FATURA').trim() || 'FATURA',
    onayDurumu: String(raw.onayDurumu || 'Onaylandı').trim() || 'Onaylandı',
    faturaTarihi: String(raw.faturaTarihi || raw.belgeTarihi || '').trim(),
    saticiVknTckn: String(raw.saticiVknTckn || '').trim(),
    saticiUnvan: String(raw.saticiUnvanAdSoyad || '').trim(),
    aliciVknTckn: String(raw.aliciVknTckn || raw.taxid || '').trim(),
    aliciUnvan: String(raw.aliciUnvanAdSoyad || '').trim(),
    raw,
  };
}

async function listeAdima(token, baslangic, bitis) {
  // hourlySearchInterval zorunlu; yoksa GIB tarafinda NPE doner.
  const payloads = [
    { baslangic, bitis, hourlySearchInterval: 'NONE' },
    { baslangic, bitis, hourlySearchInterval: 'ALL' },
    { baslangic, bitis },
  ];
  let lastErr = null;
  for (const jp of payloads) {
    try {
      const json = await dispatch(
        token,
        'EARSIV_PORTAL_ADIMA_KESILEN_BELGELERI_GETIR',
        'RG_ALICI_TASLAKLAR',
        jp,
      );
      const rows = Array.isArray(json.data) ? json.data : [];
      return rows.map(normalizeBelge).filter(Boolean);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (!/NullPointerException|Genel Sistem Hatas/i.test(msg)) throw err;
    }
  }
  throw lastErr || new Error('Adima duzenlenen liste alinamadi');
}

async function listeTaslak(token, baslangic, bitis) {
  // mlevent/fatura getAll: RG_TASLAKLAR + hangiTip 5000/30000
  const pages = ['RG_TASLAKLAR', 'RG_BASITTASLAKLAR'];
  let lastErr = null;
  for (const pageName of pages) {
    try {
      const json = await dispatch(token, 'EARSIV_PORTAL_TASLAKLARI_GETIR', pageName, {
        baslangic,
        bitis,
        hangiTip: '5000/30000',
        table: [],
      });
      const rows = Array.isArray(json.data) ? json.data : [];
      return rows.map(normalizeBelge).filter(Boolean);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Taslak liste alinamadi');
}

/**
 * Minimal ZIP okuyucu: local file header'lardan XML cikarir (store / deflate).
 */
function extractXmlFromZip(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (data.length < 30 || data[0] !== 0x50 || data[1] !== 0x4b) {
    return null;
  }
  let offset = 0;
  const xmlCandidates = [];
  while (offset + 30 <= data.length) {
    if (data.readUInt32LE(offset) !== 0x04034b50) break;
    const method = data.readUInt16LE(offset + 8);
    const compSize = data.readUInt32LE(offset + 18);
    const nameLen = data.readUInt16LE(offset + 26);
    const extraLen = data.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = data.slice(nameStart, nameStart + nameLen).toString('utf8');
    const payloadStart = nameStart + nameLen + extraLen;
    const payload = data.slice(payloadStart, payloadStart + compSize);
    offset = payloadStart + compSize;

    let content;
    if (method === 0) {
      content = payload;
    } else if (method === 8) {
      try {
        content = zlib.inflateRawSync(payload);
      } catch {
        continue;
      }
    } else {
      continue;
    }
    const lower = name.toLowerCase();
    if (lower.endsWith('.xml') || content.slice(0, 100).toString('utf8').includes('Invoice')) {
      xmlCandidates.push({ name, content });
    }
  }
  if (!xmlCandidates.length) return null;
  const preferred =
    xmlCandidates.find((c) => c.name.toLowerCase().endsWith('.xml')) || xmlCandidates[0];
  return preferred.content.toString('utf8');
}

function xmlMakulMu(xml) {
  const s = String(xml || '').replace(/^\uFEFF/, '').trim();
  return s.startsWith('<') && (s.includes('Invoice') || s.includes('CreditNote') || s.includes('ubl:'));
}

const ADIMA_XML_ENGEL =
  'GIB Adima Duzenlenen belgelerde XML/ZIP indirmeye izin vermiyor (yalniz liste). ' +
  'Satıcının ilettigi XML veya ozel entegator gerekir.';

async function downloadBelgeXml(token, belge) {
  const onaylar = [belge.onayDurumu, 'Onaylandı', 'Onaylanmadı'].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  );
  const belgeTip = belge.belgeTip || 'FATURA';
  let lastErr = null;
  let yetkisiz = false;
  for (const onay of onaylar) {
    // mlevent/fatura getDownloadURL ile ayni parametreler
    const qs = new URLSearchParams({
      token,
      ettn: belge.ettn,
      onayDurumu: onay,
      belgeTip,
      cmd: 'EARSIV_PORTAL_BELGE_INDIR',
    });
    const res = await httpRequest('GET', `${BASE_URL}/earsiv-services/download?${qs}`, {
      headers: {
        Referer: `${BASE_URL}/index.jsp`,
        Accept: 'application/zip,application/octet-stream,*/*',
      },
    });
    if (res.status < 200 || res.status >= 300) {
      lastErr = new Error(`HTTP ${res.status}`);
      continue;
    }
    const buf = res.buffer;
    if (!buf.length) {
      // Adima belgelerde GIB bos JSON (len=0) doner — yetki yok
      yetkisiz = belge._kaynak === 'adima' || yetkisiz;
      lastErr = new Error('bos yanit');
      continue;
    }
    const head = buf.slice(0, 120).toString('utf8');
    if (head.includes('yetkiniz yok') || head.includes('Bu işlem için yetkiniz yok')) {
      yetkisiz = true;
      lastErr = new Error('yetki yok');
      continue;
    }
    if (head.trimStart().startsWith('<') || head.includes('<?xml')) {
      const xml = buf.toString('utf8');
      if (xmlMakulMu(xml)) return xml;
    }
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      const xml = extractXmlFromZip(buf);
      if (xml && xmlMakulMu(xml)) return xml;
      lastErr = new Error('ZIP icinde XML yok');
      continue;
    }
    try {
      const j = JSON.parse(head);
      if (j.error || j.messages) {
        const msg = Array.isArray(j.messages)
          ? j.messages.map((m) => m?.text || m).join('; ')
          : String(j.error);
        if (/yetki/i.test(msg)) yetkisiz = true;
        lastErr = new Error(msg || 'GIB indirme hatasi');
        continue;
      }
    } catch {
      /* binary/other */
    }
    lastErr = new Error(`beklenmeyen icerik: ${head.slice(0, 40)}`);
  }
  if (yetkisiz || belge._kaynak === 'adima') {
    throw new Error(ADIMA_XML_ENGEL);
  }
  throw lastErr || new Error('XML indirilemedi');
}

function dosyaAdi(belge) {
  const no = (belge.belgeNo || belge.ettn).replace(/[<>:"/\\|?*]/g, '_');
  return `${no}.xml`;
}

async function testBaglanti(params) {
  let token = null;
  try {
    const { kullaniciAdi, sifre } = params;
    if (!kullaniciAdi || !sifre) {
      return { ok: false, msg: 'GIB e-Arsiv kullanici kodu / sifre gerekli' };
    }
    token = await login(kullaniciAdi, sifre);
    const now = new Date();
    const { baslangic, bitis } = donemTarihleri(now.getFullYear(), now.getMonth() + 1);
    const list = await listeAdima(token, baslangic, bitis);
    return {
      ok: true,
      msg: `GIB e-Arsiv giris basarili. Bu ay Adima Duzenlenen: ${list.length} belge.`,
    };
  } catch (err) {
    return { ok: false, msg: err.message || String(err) };
  } finally {
    await logout(token);
  }
}

async function indirFaturaTekTur(params, callbacks = {}) {
  const { onLog } = callbacks;
  const log = (mesaj, tip = 'bilgi') => {
    if (typeof onLog === 'function') onLog({ mesaj, tip });
  };

  const {
    kullaniciAdi, sifre, vkn, firmaAdi, yil, ay, faturaKodu, indirmeKlasoru,
  } = params;

  if (!kullaniciAdi || !sifre) throw new Error('GIB kullanici kodu / sifre eksik');
  if (!indirmeKlasoru) throw new Error('indirmeKlasoru gerekli');

  const tur = FATURA_TURLERI[faturaKodu] || FATURA_TURLERI.gelen_arsiv;
  if (tur.unsupported || !tur.mode) {
    log(`${tur.ad}: GIB e-Arsiv portalinda yok; atlandi`, 'uyari');
    const { yil: y, ay: a } = toYilAy(yil, ay);
    const klasor = firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, y, a);
    return { basari: true, xmlSayisi: 0, yeni: 0, klasor };
  }

  const { yil: y, ay: a, baslangic, bitis } = donemTarihleri(yil, ay);
  const firmaKlasor = firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, y, a);
  if (!fs.existsSync(firmaKlasor)) fs.mkdirSync(firmaKlasor, { recursive: true });

  log(`${firmaAdi || vkn} — ${tur.ad} — ${y}/${String(a).padStart(2, '0')}`);
  log('GIB e-Arsiv oturumu aciliyor...');
  let token = null;
  try {
    token = await login(kullaniciAdi, sifre);
    log(`Liste aliniyor (${baslangic} .. ${bitis})...`);

    let belgeler = [];
    if (tur.mode === 'adima' || tur.mode === 'tumu') {
      const adima = await listeAdima(token, baslangic, bitis);
      log(`Adima Duzenlenen: ${adima.length}`, 'bilgi');
      belgeler = belgeler.concat(adima.map((b) => ({ ...b, _kaynak: 'adima' })));
    }
    if (tur.mode === 'taslak' || tur.mode === 'tumu') {
      const taslak = await listeTaslak(token, baslangic, bitis);
      log(`Portal taslak/giden: ${taslak.length}`, 'bilgi');
      belgeler = belgeler.concat(taslak.map((b) => ({ ...b, _kaynak: 'taslak' })));
    }

    const seen = new Set();
    belgeler = belgeler.filter((b) => {
      if (seen.has(b.ettn)) return false;
      seen.add(b.ettn);
      return true;
    });

    log(`${belgeler.length} belge indirilecek`, belgeler.length ? 'basari' : 'uyari');
    if (!belgeler.length) {
      return { basari: true, xmlSayisi: 0, yeni: 0, klasor: firmaKlasor };
    }

    // Liste her zaman kaydedilir (Adima'da XML olmasa bile ettn/no gorunur)
    try {
      const listePath = path.join(firmaKlasor, `_gib_${tur.mode}_liste.json`);
      fs.writeFileSync(
        listePath,
        JSON.stringify(
          belgeler.map((b) => ({
            belgeNo: b.belgeNo,
            ettn: b.ettn,
            tarih: b.faturaTarihi,
            onay: b.onayDurumu,
            satici: b.saticiUnvan || b.aliciUnvan,
            saticiVkn: b.saticiVknTckn || b.aliciVknTckn,
            kaynak: b._kaynak,
          })),
          null,
          2,
        ),
        'utf8',
      );
      log(`Liste kaydedildi: ${path.basename(listePath)}`, 'bilgi');
    } catch {
      /* ignore */
    }

    const outcomes = await mapPool(belgeler, DOWNLOAD_CONCURRENCY, async (belge) => {
      const hedef = path.join(firmaKlasor, dosyaAdi(belge));
      if (fs.existsSync(hedef)) {
        return { kind: 'skip' };
      }
      try {
        const xml = await downloadBelgeXml(token, belge);
        fs.writeFileSync(hedef, xml, 'utf8');
        log(`Indirildi: ${path.basename(hedef)}`, 'basari');
        return { kind: 'new' };
      } catch (err) {
        log(`Hata ${belge.belgeNo || belge.ettn}: ${err.message}`, 'hata');
        return { kind: 'error', adimaEngel: /Adima Duzenlenen/.test(String(err.message || '')) };
      }
    });

    const yeni = outcomes.filter((o) => o?.kind === 'new').length;
    const hata = outcomes.filter((o) => o?.kind === 'error').length;
    const xmlSayisi = outcomes.filter((o) => o?.kind === 'new' || o?.kind === 'skip').length;
    const adimaEngel = outcomes.some((o) => o?.adimaEngel);

    if (adimaEngel) {
      log(
        'Not: GIB e-Arsiv Portali "Adima Duzenlenen" icin sadece liste verir; XML indirme kapali ' +
          '(mlevent/fatura ile ayni kisit). XML satıcı e-postasından veya entegratorden gelmeli.',
        'uyari',
      );
    }
    if (hata) log(`${hata} belgede hata`, 'uyari');
    log(`Tamam: ${xmlSayisi} XML (${yeni} yeni)`, 'basari');
    return { basari: true, xmlSayisi, yeni, klasor: firmaKlasor, hata };
  } finally {
    await logout(token);
  }
}

async function indirFatura(params, callbacks = {}) {
  const kod = String(params.faturaKodu || 'gelen_arsiv').toLowerCase();
  if (kod === 'tumu') {
    let xmlSayisi = 0;
    let yeni = 0;
    let klasor = null;
    for (const k of TUM_TURLER) {
      const res = await indirFaturaTekTur({ ...params, faturaKodu: k }, callbacks);
      xmlSayisi += res.xmlSayisi || 0;
      yeni += res.yeni || 0;
      klasor = res.klasor || klasor;
    }
    return { basari: true, xmlSayisi, yeni, klasor };
  }
  return indirFaturaTekTur(params, callbacks);
}

module.exports = {
  indirFatura,
  testBaglanti,
  FATURA_TURLERI,
};
