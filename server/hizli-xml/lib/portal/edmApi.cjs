/**
 * EDM Bilişim e-Fatura SOAP API (EFaturaEDM.svc)
 * Portal: nlbui.edmbilisim.com.tr
 *
 * Dokuman: https://developer.edmbilisim.com.tr/Home/Document
 * SOAPAction: islemin adi (ornegin "LoginRequest") — WSDL'den dogrulandi.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const NS = 'http://tempuri.org/';
const ENDPOINTS = [
  'https://portal2.edmbilisim.com.tr/EFaturaEDM/EFaturaEDM.svc',
  'https://interaktif.edmbilisim.com.tr/EFaturaEDM/EFaturaEDM.svc',
];
const ENDPOINT = ENDPOINTS[0];

const FATURA_TURLERI = {
  gelen: { ad: 'Gelen e-Fatura', direction: 'IN', contentType: 'XML', filter: 'efatura' },
  giden: { ad: 'Giden e-Fatura', direction: 'OUT-EINVOICE', contentType: 'XML', filter: null },
  // UI kodu "arsiv"; eski "earsiv" alias
  arsiv: { ad: 'Giden e-Arsiv', direction: 'OUT-EARCHIVE', contentType: 'XML', filter: null },
  earsiv: { ad: 'Giden e-Arsiv', direction: 'OUT-EARCHIVE', contentType: 'XML', filter: null },
  gelen_arsiv: { ad: 'Gelen e-Arsiv', direction: 'IN', contentType: 'XML', filter: 'earsiv' },
  gelen_earsiv: { ad: 'Gelen e-Arsiv', direction: 'IN', contentType: 'XML', filter: 'earsiv' },
  // e-Mustahsil ayri GetMM API; GetInvoice OUT ile karistirilmasin
  mustahsil: { ad: 'e-Mustahsil', direction: null, contentType: 'XML', unsupported: true },
  tumu: { ad: 'Tum Turler', direction: null, contentType: 'XML' },
};
const TUM_TURLER = ['gelen', 'giden', 'arsiv', 'gelen_arsiv'];
const LIST_LIMIT = 500;

const LOGIN_TIMEOUT_MS = 30000;
const LIST_TIMEOUT_MS = 60000;
const CONTENT_TIMEOUT_MS = 45000;
/** Ayni anda kac fatura XML'i cekilsin (EDM sunucusunu boğmamak icin sinirli) */
const DOWNLOAD_CONCURRENCY = 8;

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

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toYilAy(yil, ay) {
  const y = Number(yil);
  const a = Number(ay);
  if (!Number.isFinite(y) || !Number.isFinite(a) || a < 1 || a > 12) {
    throw new Error(`Gecersiz donem: ${yil}/${ay}`);
  }
  return { yil: y, ay: a };
}

function aySonGunu(yil, ay) {
  return new Date(yil, ay, 0).getDate();
}

/** EDM START_DATE/END_DATE sadece YYYY-MM-DD kabul ediyor (datetime deserialize hatasi veriyor) */
function formatDateOnly(yil, ay, gun) {
  return `${yil}-${String(ay).padStart(2, '0')}-${String(gun).padStart(2, '0')}`;
}

function donemTarihleri(yilRaw, ayRaw) {
  const { yil, ay } = toYilAy(yilRaw, ayRaw);
  const son = aySonGunu(yil, ay);
  return {
    yil,
    ay,
    startDate: formatDateOnly(yil, ay, 1),
    endDate: formatDateOnly(yil, ay, son),
    sonGun: son,
  };
}

function requestHeaderXml(sessionId = null) {
  const now = new Date();
  const actionDate = now.toISOString().replace('Z', '+00:00');
  const session = sessionId
    ? `<SESSION_ID>${escapeXml(sessionId)}</SESSION_ID>`
    : '<SESSION_ID/>';
  return `
    <REQUEST_HEADER xmlns="">
      ${session}
      <CLIENT_TXN_ID>${crypto.randomUUID()}</CLIENT_TXN_ID>
      <ACTION_DATE>${actionDate}</ACTION_DATE>
      <REASON>Musavirim Hizli XML Indirici</REASON>
      <APPLICATION_NAME>Musavirim</APPLICATION_NAME>
      <HOSTNAME>${escapeXml(os.hostname())}</HOSTNAME>
      <CHANNEL_NAME>Musavirim</CHANNEL_NAME>
      <COMPRESSED>N</COMPRESSED>
    </REQUEST_HEADER>`;
}

function soapEnvelope(bodyInner) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    ${bodyInner}
  </s:Body>
</s:Envelope>`;
}

function extractFault(text) {
  const fault = text.match(/<(?:\w+:)?Fault[\s\S]*?<\/(?:\w+:)?Fault>/i);
  if (!fault) return null;
  const code = (fault[0].match(/<(?:\w+:)?faultcode[^>]*>([\s\S]*?)<\//i) || [])[1] || '';
  const msg = (fault[0].match(/<(?:\w+:)?faultstring[^>]*>([\s\S]*?)<\//i) || [])[1] || '';
  return `${msg.trim() || code.trim() || 'SOAP Fault'}`.slice(0, 500);
}

function extractTag(text, tag) {
  const re = new RegExp(`<(?:[\\w]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w]+:)?${tag}>`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function extractAttr(tagOpen, attr) {
  // \\b sart: aksi halde ID, TRXID="0" icinden 0 yakalar
  const m = tagOpen.match(new RegExp(`(?:^|[\\s])${attr}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

function extractContentBase64(invoiceBlock) {
  const m = invoiceBlock.match(/<CONTENT\b[^>]*>([\s\S]*?)<\/CONTENT>/i);
  if (!m) return '';
  const inner = m[1].trim();
  const nested = inner.match(/<(?:[\w]+:)?Value\b[^>]*>([\s\S]*?)<\//i);
  return (nested ? nested[1] : inner).replace(/\s+/g, '');
}

function parseXmlElements(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const block = m[2] || '';
    const header = (block.match(/<HEADER[\s\S]*?<\/HEADER>/i) || [])[0] || '';
    results.push({
      uuid: extractAttr(attrs, 'UUID') || extractTag(block, 'UUID'),
      id: extractAttr(attrs, 'ID') || extractTag(block, 'ID'),
      issueDate: extractTag(header, 'ISSUE_DATE') || extractTag(block, 'ISSUE_DATE'),
      status: extractTag(header, 'STATUS') || extractTag(block, 'STATUS'),
      statusDescription: extractTag(header, 'STATUS_DESCRIPTION') || '',
      profileId: extractTag(header, 'PROFILEID') || '',
      sendType: extractTag(header, 'INVOICE_SEND_TYPE') || '',
      earchive: extractTag(header, 'EARCHIVE') || '',
      contentBase64: extractContentBase64(block),
    });
  }
  return results;
}

/** Gelen kutudaki e-Arsiv (GİB/portal) — PROFILEID/EARSIV veya send type */
function isEarsivInvoice(inv) {
  const p = String(inv.profileId || '').toUpperCase();
  const s = String(inv.sendType || '')
    .toUpperCase()
    .replace(/İ/g, 'I')
    .replace(/Ş/g, 'S');
  const e = String(inv.earchive || '').toLowerCase();
  if (e === 'true') return true;
  if (p.includes('EARSIV')) return true;
  if (s.includes('ARSIV') || s.includes('E-ARSIV') || s.includes('EARSIV')) return true;
  return false;
}

async function soapPost(endpoint, soapAction, bodyInner, timeoutMs = 30000) {
  const envelope = soapEnvelope(bodyInner);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"${soapAction}"`,
        Accept: 'text/xml',
      },
      body: envelope,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`EDM zaman asimi (${Math.round(timeoutMs / 1000)} sn) — ${soapAction}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    const fault = extractFault(text);
    throw new Error(fault || `HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const fault = extractFault(text);
  if (fault) throw new Error(fault);
  return text;
}

async function login(username, password, preferredUrl) {
  const body = `
    <LoginRequest xmlns="${NS}">
      ${requestHeaderXml(null)}
      <USER_NAME xmlns="">${escapeXml(username)}</USER_NAME>
      <PASSWORD xmlns="">${escapeXml(password)}</PASSWORD>
    </LoginRequest>`;

  const candidates = [];
  if (preferredUrl) candidates.push(preferredUrl);
  for (const ep of ENDPOINTS) {
    if (!candidates.includes(ep)) candidates.push(ep);
  }

  let lastErr = null;
  for (const endpoint of candidates) {
    try {
      const text = await soapPost(endpoint, 'LoginRequest', body, LOGIN_TIMEOUT_MS);
      const sessionId = extractTag(text, 'SESSION_ID');
      if (!sessionId) throw new Error('SESSION_ID alinamadi');
      return { sessionId, endpoint };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('EDM giris basarisiz');
}

async function getInvoiceHeaders({ sessionId, endpoint, direction, startDate, endDate }) {
  const body = `
    <GetInvoiceRequest xmlns="${NS}">
      ${requestHeaderXml(sessionId)}
      <INVOICE_SEARCH_KEY xmlns="">
        <LIMIT>${LIST_LIMIT}</LIMIT>
        <START_DATE>${escapeXml(startDate)}</START_DATE>
        <END_DATE>${escapeXml(endDate)}</END_DATE>
        <READ_INCLUDED>true</READ_INCLUDED>
        <DIRECTION>${escapeXml(direction)}</DIRECTION>
      </INVOICE_SEARCH_KEY>
      <HEADER_ONLY xmlns="">Y</HEADER_ONLY>
      <INVOICE_CONTENT_TYPE xmlns="">XML</INVOICE_CONTENT_TYPE>
    </GetInvoiceRequest>`;

  const text = await soapPost(endpoint, 'GetInvoiceRequest', body, LIST_TIMEOUT_MS);
  return parseXmlElements(text, 'INVOICE');
}

async function getInvoiceContent({
  sessionId, endpoint, direction, uuid, id, startDate, endDate,
}) {
  // UUID + fatura tarihi (YYYY-MM-DD); CR tarihi veya datetime formati bos/hata donebiliyor
  const uuidXml = uuid ? `<UUID>${escapeXml(uuid)}</UUID>` : '';
  const idXml = id && id !== '0' ? `<ID>${escapeXml(id)}</ID>` : '';
  const body = `
    <GetInvoiceRequest xmlns="${NS}">
      ${requestHeaderXml(sessionId)}
      <INVOICE_SEARCH_KEY xmlns="">
        ${uuidXml}
        ${idXml}
        <START_DATE>${escapeXml(startDate)}</START_DATE>
        <END_DATE>${escapeXml(endDate)}</END_DATE>
        <READ_INCLUDED>true</READ_INCLUDED>
        <DIRECTION>${escapeXml(direction)}</DIRECTION>
      </INVOICE_SEARCH_KEY>
      <HEADER_ONLY xmlns="">N</HEADER_ONLY>
      <INVOICE_CONTENT_TYPE xmlns="">XML</INVOICE_CONTENT_TYPE>
    </GetInvoiceRequest>`;

  const text = await soapPost(endpoint, 'GetInvoiceRequest', body, CONTENT_TIMEOUT_MS);
  const list = parseXmlElements(text, 'INVOICE');
  return list[0] || null;
}

function isIptalRed(status) {
  const s = String(status || '').toUpperCase();
  return s.includes('CANCEL') || s.includes('REJECT') || s.includes('IPTAL') || s.includes('RED');
}

function parseDateFromAny(val) {
  if (!val) return null;
  const s = String(val).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function xmlMakbulMu(xml) {
  if (!xml || xml.length < 40) return false;
  const t = xml.trim();
  return t.includes('Invoice') || t.includes('CreditNote') || t.includes('<?xml');
}

function firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, yil, ay) {
  const guvenli = String(firmaAdi || 'firma').replace(/[<>:"/\\|?*]/g, '_').trim();
  const ayStr = String(ay).padStart(2, '0');
  return path.join(indirmeKlasoru, `${guvenli}_${vkn || 'vkn'}`, String(yil), ayStr);
}

async function testBaglanti(params) {
  try {
    const { kullaniciAdi, sifre, apiUrl } = params;
    if (!kullaniciAdi || !sifre) return { ok: false, msg: 'API kullanici adi / sifre gerekli' };
    const { sessionId, endpoint } = await login(kullaniciAdi, sifre, apiUrl);
    const now = new Date();
    const { startDate, endDate } = donemTarihleri(now.getFullYear(), now.getMonth() + 1);
    const invoices = await getInvoiceHeaders({
      sessionId,
      endpoint,
      direction: 'IN',
      startDate,
      endDate,
    });
    return { ok: true, msg: `EDM baglanti basarili (${endpoint}). ${invoices.length} kayit listelendi.` };
  } catch (err) {
    return { ok: false, msg: err.message || String(err) };
  }
}

async function indirFaturaTekTur(params, callbacks = {}) {
  const { onLog } = callbacks;
  const log = (mesaj, tip = 'bilgi') => {
    if (typeof onLog === 'function') onLog({ mesaj, tip });
  };

  const {
    kullaniciAdi, sifre, vkn, firmaAdi, yil, ay, faturaKodu, indirmeKlasoru, iptalRedDahil, apiUrl,
  } = params;

  if (!kullaniciAdi || !sifre) throw new Error('API kullanici adi / sifre eksik');
  if (!indirmeKlasoru) throw new Error('indirmeKlasoru gerekli');
  const tur = FATURA_TURLERI[faturaKodu];
  if (!tur) throw new Error(`Gecersiz fatura turu: ${faturaKodu}`);

  const { yil: y, ay: a, startDate, endDate } = donemTarihleri(yil, ay);
  const firmaKlasor = firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, y, a);
  if (!fs.existsSync(firmaKlasor)) fs.mkdirSync(firmaKlasor, { recursive: true });

  log(`${firmaAdi} — ${tur.ad} — ${y}/${String(a).padStart(2, '0')}`);
  if (tur.unsupported || !tur.direction) {
    log('e-Mustahsil icin EDM GetMM henuz bagli degil; atlandi', 'uyari');
    return { basari: true, xmlSayisi: 0, yeni: 0, klasor: firmaKlasor };
  }

  log('EDM oturumu aciliyor...');
  const { sessionId, endpoint } = await login(kullaniciAdi, sifre, apiUrl);
  log(`Endpoint: ${endpoint}`, 'bilgi');
  log(`Fatura listesi aliniyor (${startDate} .. ${endDate})...`);
  let invoices = await getInvoiceHeaders({
    sessionId,
    endpoint,
    direction: tur.direction,
    startDate,
    endDate,
  });
  log(`Liste alindi: ${invoices.length} kayit`, 'bilgi');
  if (invoices.length >= LIST_LIMIT) {
    log(`Liste ${LIST_LIMIT} kayitta sinirlandi; kalanlar icin tekrar deneyin veya donemi daraltin`, 'uyari');
  }

  const tarihFiltreli = invoices.filter((inv) => {
    const d = parseDateFromAny(inv.issueDate);
    if (!d) return true;
    return d.getFullYear() === y && (d.getMonth() + 1) === a;
  });
  const donemDisi = invoices.length - tarihFiltreli.length;
  invoices = tarihFiltreli;

  if (tur.filter === 'earsiv') {
    const once = invoices.length;
    invoices = invoices.filter((inv) => isEarsivInvoice(inv));
    log(`Gelen e-Arsiv filtresi: ${once} kayittan ${invoices.length} e-Arsiv`, invoices.length ? 'bilgi' : 'uyari');
    if (!invoices.length) {
      log('EDM gelen kutusunda e-Arsiv (EARSIVFATURA) yok. Portalda "Gelen e-Arsiv" aciksa EDM aktivasyonu/onay gerekebilir.', 'uyari');
    }
  } else if (tur.filter === 'efatura') {
    const once = invoices.length;
    invoices = invoices.filter((inv) => !isEarsivInvoice(inv));
    const atilan = once - invoices.length;
    if (atilan > 0) log(`${atilan} gelen e-Arsiv kayit ayri ture birakildi`, 'bilgi');
  }

  if (iptalRedDahil !== true) {
    const once = invoices.length;
    invoices = invoices.filter((inv) => !isIptalRed(inv.status));
    const filtre = once - invoices.length;
    if (filtre > 0) log(`${filtre} iptal/red kayit filtrelenip atlandi`, 'uyari');
  }
  if (donemDisi > 0) log(`${donemDisi} kayit belge tarihi secili ayda olmadigi icin atlandi`, 'uyari');

  log(`${invoices.length} kayit indirilecek`, invoices.length ? 'basari' : 'uyari');
  if (!invoices.length) return { basari: true, xmlSayisi: 0, yeni: 0, klasor: firmaKlasor };

  const jobs = [];
  let atlanan = 0;
  for (const inv of invoices) {
    const uuid = inv.uuid || crypto.randomUUID();
    const docId = String(inv.id || uuid).replace(/[<>:"/\\|?*]/g, '_');
    const dosyaAdi = `${docId}_${uuid}.xml`;
    const hedef = path.join(firmaKlasor, dosyaAdi);
    if (fs.existsSync(hedef)) {
      atlanan += 1;
      continue;
    }
    jobs.push({ inv, uuid, docId, dosyaAdi, hedef });
  }

  if (atlanan > 0) log(`${atlanan} dosya zaten var, atlandi`, 'bilgi');
  if (!jobs.length) {
    const mevcut = fs.readdirSync(firmaKlasor).filter((f) => f.toLowerCase().endsWith('.xml')).length;
    log(`0 yeni indirildi, ${atlanan} zaten vardi, toplam ${mevcut} XML`, 'bilgi');
    log(`Klasor: ${firmaKlasor}`, 'basari');
    return { basari: true, xmlSayisi: mevcut, yeni: 0, klasor: firmaKlasor };
  }

  log(`${jobs.length} XML paralel indiriliyor (x${DOWNLOAD_CONCURRENCY})...`, 'bilgi');
  let yeni = 0;
  let apiAtlanan = 0;
  let tamamlanan = 0;

  await mapPool(jobs, DOWNLOAD_CONCURRENCY, async (job) => {
    const { inv, docId, dosyaAdi, hedef } = job;
    let contentBase64 = inv.contentBase64;
    if (!contentBase64) {
      try {
        const full = await getInvoiceContent({
          sessionId,
          endpoint,
          direction: tur.direction,
          uuid: inv.uuid,
          id: inv.id,
          startDate,
          endDate,
        });
        contentBase64 = full && full.contentBase64;
      } catch (err) {
        apiAtlanan += 1;
        tamamlanan += 1;
        log(`${docId}: ${err.message}`, 'uyari');
        return;
      }
    }

    if (!contentBase64) {
      apiAtlanan += 1;
      tamamlanan += 1;
      log(`${docId}: XML icerik bos dondu`, 'uyari');
      return;
    }

    let xml = '';
    try {
      xml = Buffer.from(contentBase64, 'base64').toString('utf8');
    } catch {
      apiAtlanan += 1;
      tamamlanan += 1;
      log(`${docId}: base64 cozulemedi`, 'uyari');
      return;
    }
    if (!xmlMakbulMu(xml)) {
      apiAtlanan += 1;
      tamamlanan += 1;
      log(`${docId}: gecersiz XML icerik`, 'uyari');
      return;
    }

    fs.writeFileSync(hedef, xml, 'utf8');
    yeni += 1;
    tamamlanan += 1;
    if (tamamlanan === jobs.length || tamamlanan % 5 === 0 || jobs.length <= 10) {
      log(`${tamamlanan}/${jobs.length} — ${dosyaAdi}`, 'basari');
    }
  });

  const mevcut = fs.readdirSync(firmaKlasor).filter((f) => f.toLowerCase().endsWith('.xml')).length;
  if (apiAtlanan > 0) log(`${apiAtlanan} kayit API tarafinda indirilemedigi icin atlandi`, 'uyari');
  log(`${yeni} yeni indirildi, ${atlanan} zaten vardi, toplam ${mevcut} XML`, yeni ? 'basari' : 'bilgi');
  log(`Klasor: ${firmaKlasor}`, 'basari');
  return { basari: true, xmlSayisi: mevcut, yeni, klasor: firmaKlasor };
}

async function indirFatura(params, callbacks = {}) {
  if (params.faturaKodu === 'tumu') {
    const { onLog } = callbacks;
    const log = (mesaj, tip = 'bilgi') => {
      if (typeof onLog === 'function') onLog({ mesaj, tip });
    };
    log('Tum turler indiriliyor (gelen + giden + giden e-arsiv + gelen e-arsiv)...');
    let yeni = 0;
    let xmlSayisi = 0;
    let klasor = '';
    for (const kod of TUM_TURLER) {
      try {
        const res = await indirFaturaTekTur({ ...params, faturaKodu: kod }, callbacks);
        yeni += res.yeni || 0;
        xmlSayisi = Math.max(xmlSayisi, res.xmlSayisi || 0);
        if (res.klasor) klasor = res.klasor;
      } catch (err) {
        log(`${FATURA_TURLERI[kod].ad}: ${err.message}`, 'uyari');
      }
    }
    log(`Toplam ${yeni} yeni XML indirildi`, yeni ? 'basari' : 'uyari');
    return { basari: true, xmlSayisi, yeni, klasor };
  }
  return indirFaturaTekTur(params, callbacks);
}

module.exports = {
  indirFatura,
  testBaglanti,
  FATURA_TURLERI,
  ENDPOINT,
};
