const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ENDPOINT = 'http://edonusumapi.uyum.com.tr/Services/BasicIntegration';
const TEST_ENDPOINT = 'http://efatura-test.uyumsoft.com.tr/Services/BasicIntegration';
const FALLBACK_ENDPOINTS = [
  'http://efatura.uyumsoft.com.tr/Services/BasicIntegration',
];

const FATURA_TURLERI = {
  gelen: { ad: 'Gelen e-Fatura' },
  giden: { ad: 'Giden e-Fatura' },
  arsiv: { ad: 'e-Arsiv' },
  mustahsil: { ad: 'e-Mustahsil' },
};

const TUM_TURLER = ['gelen', 'giden', 'arsiv', 'mustahsil'];

function escapeXml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function aySonGunu(yil, ay) {
  return new Date(yil, ay, 0).getDate();
}

function formatDateIso(yil, ay, gun, endOfDay = false) {
  const saat = endOfDay ? '23:59:59' : '00:00:00';
  return `${yil}-${String(ay).padStart(2, '0')}-${String(gun).padStart(2, '0')}T${saat}+03:00`;
}

function addMonths(yil, ay, delta) {
  let monthIndex = (ay - 1) + delta;
  let year = yil + Math.floor(monthIndex / 12);
  monthIndex = ((monthIndex % 12) + 12) % 12;
  return { yil: year, ay: monthIndex + 1 };
}

function executionQueryRange(yil, ay, bufferMonths = 1) {
  const start = addMonths(yil, ay, -bufferMonths);
  const end = addMonths(yil, ay, bufferMonths);
  return {
    startDate: formatDateIso(start.yil, start.ay, 1),
    endDate: formatDateIso(end.yil, end.ay, aySonGunu(end.yil, end.ay), true),
  };
}

function parseDateFromAny(value) {
  const s = String(value || '');
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseTag(xml, tagName) {
  const re = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

function parseBlocks(xml, tagName) {
  const re = new RegExp(`<(?:\\w+:)?${tagName}\\b[\\s\\S]*?<\\/(?:\\w+:)?${tagName}>`, 'gi');
  return xml.match(re) || [];
}

function parseAttr(block, attrName) {
  const re = new RegExp(`${attrName}="([^"]*)"`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function xmlMakulMu(xml) {
  const data = String(xml || '').replace(/^\uFEFF/, '').trim();
  return data.startsWith('<') && data.includes('>');
}

function endpointLabel(endpoint) {
  return endpoint.includes('efatura-test') ? 'TEST' : 'CANLI';
}

function normalizeEndpoint(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return ENDPOINT;

  let url = raw;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  if (!/\/Services\/BasicIntegration$/i.test(url)) {
    url = `${url}/Services/BasicIntegration`;
  }
  return url;
}

function candidateEndpoints(apiUrl, testMode = false) {
  const dedupe = (arr) => [...new Set(arr.filter(Boolean))];
  if (testMode) return dedupe([TEST_ENDPOINT]);
  if (apiUrl && String(apiUrl).trim()) {
    const primary = normalizeEndpoint(apiUrl);
    if (/efatura-test\.uyumsoft\.com\.tr/i.test(primary)) return dedupe([primary]);
    if (primary.startsWith('https://')) return dedupe([primary.replace(/^https:\/\//i, 'http://'), primary]);
    return dedupe([primary, ...FALLBACK_ENDPOINTS.filter((url) => url !== primary)]);
  }
  return dedupe([ENDPOINT, ...FALLBACK_ENDPOINTS]);
}

function translateSoapError(message) {
  const msg = String(message || '').trim();
  if (/object reference not set/i.test(msg)) {
    return 'Uyumsoft kimlik dogrulama hatasi. Portal kullanicisi degil, Uyumsoft tarafindan verilen Web Servis kullanicisi ve sifresini girin.';
  }
  if (/userinformation can not be null/i.test(msg)) {
    return 'Uyumsoft kullanici bilgisi gonderilemedi. Web Servis kullanici adi ve sifresini kontrol edin.';
  }
  if (/contractfilter mismatch/i.test(msg)) {
    return 'Uyumsoft SOAP istegi reddedildi. API endpoint adresinin BasicIntegration oldugundan emin olun.';
  }
  return msg;
}

async function soapCall(operation, payloadXml, endpoint) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header/>
  <s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <${operation} xmlns="http://tempuri.org/">
      ${payloadXml}
    </${operation}>
  </s:Body>
</s:Envelope>`;

  const url = new URL(endpoint || ENDPOINT);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset=utf-8',
        SOAPAction: `"http://tempuri.org/IBasicIntegration/${operation}"`,
        'content-length': Buffer.byteLength(envelope, 'utf8'),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const fault = translateSoapError(parseTag(body, 'faultstring') || `HTTP ${res.statusCode}`);
          reject(new Error(`Uyumsoft SOAP hatasi: ${fault}`));
          return;
        }
        const fault = parseTag(body, 'faultstring');
        if (fault) {
          reject(new Error(`Uyumsoft SOAP hatasi: ${translateSoapError(fault)}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.write(envelope, 'utf8');
    req.end();
  });
}

function buildUserInfoXml(kullaniciAdi, sifre) {
  return `<userInfo Username="${escapeXml(kullaniciAdi)}" Password="${escapeXml(sifre)}"></userInfo>`;
}

function buildQueryXml({ startDate, endDate, pageIndex, pageSize, inbox }) {
  if (inbox) {
    return `<query PageIndex="${pageIndex}" PageSize="${pageSize}" SetTaken="false" OnlyNewestInvoices="false">
  <ExecutionStartDate>${startDate}</ExecutionStartDate>
  <ExecutionEndDate>${endDate}</ExecutionEndDate>
</query>`;
  }
  return `<query PageIndex="${pageIndex}" PageSize="${pageSize}">
  <ExecutionStartDate>${startDate}</ExecutionStartDate>
  <ExecutionEndDate>${endDate}</ExecutionEndDate>
</query>`;
}

function parseValueElement(block) {
  const re = /<(?:\w+:)?Value\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Value>/i;
  const m = String(block || '').match(re);
  if (!m) return { attrs: '', content: block || '' };
  return { attrs: m[1], content: m[2] };
}

function parseResultEnvelope(xml, resultTag) {
  const resultBlock = parseTag(xml, resultTag) || xml;
  const isSucceededAttr = parseAttr(resultBlock, 'IsSucceded');
  if (isSucceededAttr && String(isSucceededAttr).toLowerCase() !== 'true') {
    const message = translateSoapError(parseAttr(resultBlock, 'Message') || 'Uyumsoft sorgu basarisiz');
    throw new Error(message);
  }
  const valueEl = parseValueElement(resultBlock);
  return { resultBlock, valueBlock: valueEl.content, valueAttrs: valueEl.attrs };
}

async function getInvoicesDataPage({
  endpoint, kullaniciAdi, sifre, startDate, endDate, inbox, pageIndex = 0, pageSize = 20,
}) {
  const operation = inbox ? 'GetInboxInvoicesData' : 'GetOutboxInvoicesData';
  const resultTag = inbox ? 'GetInboxInvoicesDataResult' : 'GetOutboxInvoicesDataResult';
  const payload = `
${buildUserInfoXml(kullaniciAdi, sifre)}
${buildQueryXml({
    startDate,
    endDate,
    pageIndex,
    pageSize,
    inbox,
  })}`;

  const xml = await soapCall(operation, payload, endpoint);
  const { valueBlock, valueAttrs } = parseResultEnvelope(xml, resultTag);
  const items = parseBlocks(valueBlock, 'Items').map((item) => ({
    invoiceId: parseAttr(item, 'InvoiceId') || '',
    localDocumentId: parseAttr(item, 'LocalDocumentId') || '',
    data: parseTag(item, 'Data') || '',
  }));

  return {
    items,
    pageIndex: Number(parseAttr(valueAttrs, 'PageIndex') || pageIndex),
    pageSize: Number(parseAttr(valueAttrs, 'PageSize') || pageSize),
    totalCount: Number(parseAttr(valueAttrs, 'TotalCount') || items.length),
    totalPages: Number(parseAttr(valueAttrs, 'TotalPages') || 1),
  };
}

async function getInvoicesData(params) {
  const pageSize = params.pageSize || 20;
  let pageIndex = 0;
  let totalPages = 1;
  const allItems = [];

  while (pageIndex < totalPages) {
    const page = await getInvoicesDataPage({ ...params, pageIndex, pageSize });
    totalPages = Math.max(page.totalPages || 1, 1);
    allItems.push(...page.items);
    pageIndex += 1;
  }

  return allItems;
}

async function getInvoicesList({
  endpoint, kullaniciAdi, sifre, startDate, endDate, inbox, pageSize = 200,
}) {
  const operation = inbox ? 'GetInboxInvoices' : 'GetOutboxInvoices';
  const resultTag = inbox ? 'GetInboxInvoicesResult' : 'GetOutboxInvoicesResult';
  const payload = `
${buildUserInfoXml(kullaniciAdi, sifre)}
${buildQueryXml({
    startDate,
    endDate,
    pageIndex: 0,
    pageSize,
    inbox,
  })}`;

  const xml = await soapCall(operation, payload, endpoint);
  const { valueBlock } = parseResultEnvelope(xml, resultTag);

  return parseBlocks(valueBlock, 'Items').map((item) => {
    const invoiceBlock = parseBlocks(item, 'Invoice')[0] || '';
    const invoiceId = parseAttr(item, 'InvoiceId')
      || parseTag(invoiceBlock, 'cbc:UUID')
      || parseTag(invoiceBlock, 'UUID')
      || '';
    return {
      id: invoiceId,
      invoiceXml: invoiceBlock || '',
    };
  });
}

async function getInvoiceDataById({
  endpoint, kullaniciAdi, sifre, invoiceId, inbox,
}) {
  if (!invoiceId) return '';
  const operation = inbox ? 'GetInboxInvoiceData' : 'GetOutboxInvoiceData';
  const resultTag = inbox ? 'GetInboxInvoiceDataResult' : 'GetOutboxInvoiceDataResult';
  const payload = `
${buildUserInfoXml(kullaniciAdi, sifre)}
<invoiceId>${escapeXml(invoiceId)}</invoiceId>`;
  const xml = await soapCall(operation, payload, endpoint);
  const { resultBlock } = parseResultEnvelope(xml, resultTag);
  const valueBlock = parseTag(resultBlock, 'Value') || resultBlock;
  return parseTag(valueBlock, 'Data') || parseTag(resultBlock, 'Data') || '';
}

function parseInvoiceMeta(xml) {
  const id = parseTag(xml, 'cbc:ID') || parseTag(xml, 'ID');
  const uuid = parseTag(xml, 'cbc:UUID') || parseTag(xml, 'UUID');
  const issueDate = parseTag(xml, 'cbc:IssueDate') || parseTag(xml, 'IssueDate');
  const profile = parseTag(xml, 'cbc:ProfileID') || parseTag(xml, 'ProfileID');
  const invoiceType = parseTag(xml, 'cbc:InvoiceTypeCode') || parseTag(xml, 'InvoiceTypeCode');
  return {
    id: id || uuid,
    uuid: uuid || id,
    issueDate,
    profile: String(profile || '').toUpperCase(),
    invoiceType: String(invoiceType || '').toUpperCase(),
  };
}

function matchesFaturaKodu(faturaKodu, xml) {
  if (faturaKodu === 'gelen' || faturaKodu === 'giden') return true;
  const meta = parseInvoiceMeta(xml);
  if (faturaKodu === 'arsiv') {
    return meta.profile.includes('EARSIV') || meta.invoiceType.includes('EARSIV');
  }
  if (faturaKodu === 'mustahsil') {
    return meta.profile.includes('MUSTAHSIL') || meta.invoiceType.includes('MUSTAHSIL') || meta.invoiceType.includes('ESMM');
  }
  return true;
}

function issueDateInSelectedMonth(xml, yil, ay) {
  const meta = parseInvoiceMeta(xml);
  const d = parseDateFromAny(meta.issueDate);
  if (!d) return true;
  return d.getFullYear() === yil && (d.getMonth() + 1) === ay;
}

function decodeInvoiceXml(row) {
  if (!row.data) return '';
  try {
    return row.isPlainXml ? String(row.data) : Buffer.from(row.data, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, yil, ay) {
  const ayStr = String(ay).padStart(2, '0');
  return path.join(
    indirmeKlasoru,
    `${firmaAdi}_${vkn}`.replace(/[<>:"/\\|?*]/g, '_'),
    `${ayStr}_${yil}_Aktarilacaklar`,
  );
}

async function withEndpoint(params, fn) {
  const testMode = /efatura-test\.uyumsoft\.com\.tr/i.test(String(params.apiUrl || ''));
  const endpoints = candidateEndpoints(params.apiUrl, testMode);
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const value = await fn(endpoint);
      return { endpoint, value };
    } catch (err) {
      errors.push(`${endpointLabel(endpoint)} (${endpoint}): ${err.message || String(err)}`);
    }
  }
  const primary = errors[0] || 'Uyumsoft baglantisi kurulamadi';
  const extra = errors.slice(1);
  throw new Error(extra.length ? `${primary} | Diger denemeler: ${extra.join(' | ')}` : primary);
}

async function testBaglanti(params) {
  const {
    kullaniciAdi, sifre, yil, ay,
  } = params;
  if (!kullaniciAdi || !sifre) return { ok: false, msg: 'Kullanici adi/sifre eksik' };
  try {
    const y = yil || new Date().getFullYear();
    const a = ay || (new Date().getMonth() + 1);
    const queryRange = executionQueryRange(y, a);

    const res = await withEndpoint(params, async (endpoint) => {
      const pingXml = await soapCall('TestConnection', buildUserInfoXml(kullaniciAdi, sifre), endpoint);
      const pingResult = parseTag(pingXml, 'TestConnectionResult') || pingXml;
      const pingOk = String(parseAttr(pingResult, 'IsSucceded')).toLowerCase();
      if (pingOk === 'false') {
        const msg = translateSoapError(parseAttr(pingResult, 'Message') || 'Uyumsoft baglanti testi basarisiz');
        throw new Error(msg);
      }

      const page = await getInvoicesDataPage({
        endpoint,
        kullaniciAdi,
        sifre,
        startDate: queryRange.startDate,
        endDate: queryRange.endDate,
        inbox: true,
        pageSize: 50,
      });
      let matched = 0;
      for (const row of page.items) {
        const xml = decodeInvoiceXml({ ...row, isPlainXml: false });
        if (xml && issueDateInSelectedMonth(xml, y, a)) matched += 1;
      }
      return { ...page, matchedInMonth: matched };
    });

    return {
      ok: true,
      msg: `Uyumsoft baglanti basarili (${endpointLabel(res.endpoint)} | ${res.endpoint}). Secilen ayda fatura tarihine gore ${res.value.matchedInMonth}+ gelen fatura bulundu.`,
    };
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
    kullaniciAdi, sifre, vkn, firmaAdi, yil, ay, faturaKodu, indirmeKlasoru,
  } = params;
  if (!kullaniciAdi || !sifre) throw new Error('API kullanici adi / sifre eksik');
  if (!indirmeKlasoru) throw new Error('indirmeKlasoru gerekli');
  const tur = FATURA_TURLERI[faturaKodu];
  if (!tur) throw new Error(`Gecersiz fatura turu: ${faturaKodu}`);

  const son = aySonGunu(yil, ay);
  const klasor = firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, yil, ay);
  if (!fs.existsSync(klasor)) fs.mkdirSync(klasor, { recursive: true });

  log(`${firmaAdi} — ${tur.ad} — ${yil}/${String(ay).padStart(2, '0')}`);

  const queryRange = executionQueryRange(yil, ay);
  log(`API sorgusu olusturulma tarihine gore ±1 ay genisletildi; indirme fatura tarihine (IssueDate) gore filtrelenecek`, 'bilgi');

  const isInbox = faturaKodu === 'gelen';
  const endpointResult = await withEndpoint(params, async (endpoint) => {
    const dataRows = await getInvoicesData({
      endpoint,
      kullaniciAdi,
      sifre,
      startDate: queryRange.startDate,
      endDate: queryRange.endDate,
      inbox: isInbox,
      pageSize: 20,
    });
    return dataRows.map((row) => ({
      invoiceId: row.invoiceId,
      localDocumentId: row.localDocumentId,
      data: row.data,
      isPlainXml: false,
    }));
  });

  log(`Endpoint: ${endpointResult.endpoint}`, 'bilgi');
  log(`API'den toplam ${endpointResult.value.length} kayit cekildi`, 'bilgi');

  let donemDisi = 0;
  let rows = endpointResult.value.filter((r) => {
    if (!r.data) return true;
    const xml = decodeInvoiceXml(r);
    if (!xml || !xmlMakulMu(xml)) return true;
    if (issueDateInSelectedMonth(xml, yil, ay)) return true;
    donemDisi += 1;
    return false;
  });

  if (faturaKodu === 'arsiv' || faturaKodu === 'mustahsil') {
    rows = rows.filter((r) => {
      if (!r.data) return false;
      const xml = decodeInvoiceXml(r);
      if (!xml) return false;
      return matchesFaturaKodu(faturaKodu, xml);
    });
  }

  if (donemDisi > 0) {
    log(`${donemDisi} kayit fatura tarihi (IssueDate) secili ayda olmadigi icin atildi`, 'uyari');
  }

  log(`${rows.length} kayit indirilecek`, rows.length ? 'basari' : 'uyari');

  let yeni = 0;
  let atlanan = 0;
  let apiAtlanan = 0;
  for (const [i, r] of rows.entries()) {
    if (!r.data) {
      apiAtlanan += 1;
      continue;
    }

    let xml = decodeInvoiceXml(r);
    if (!xml) {
      apiAtlanan += 1;
      continue;
    }
    if (!xmlMakulMu(xml)) {
      apiAtlanan += 1;
      continue;
    }

    const meta = parseInvoiceMeta(xml);
    const uuid = (meta.uuid || r.invoiceId || `uuid-${i + 1}`).replace(/[<>:"/\\|?*]/g, '_');
    const docId = (meta.id || r.localDocumentId || r.invoiceId || `doc-${i + 1}`).replace(/[<>:"/\\|?*]/g, '_');
    const dosyaAdi = `${docId}_${uuid}.xml`;
    const hedef = path.join(klasor, dosyaAdi);
    if (fs.existsSync(hedef)) {
      atlanan += 1;
      continue;
    }
    fs.writeFileSync(hedef, xml, 'utf8');
    yeni += 1;
    log(`${i + 1}/${rows.length} — ${dosyaAdi}`, 'bilgi');
  }

  const mevcut = fs.readdirSync(klasor).filter((f) => f.toLowerCase().endsWith('.xml')).length;
  if (apiAtlanan > 0) log(`${apiAtlanan} kayit API tarafinda indirilemedigi icin atlandi`, 'uyari');
  log(`${yeni} yeni indirildi, ${atlanan} zaten vardi, toplam ${mevcut} XML`, yeni ? 'basari' : 'bilgi');
  if (yeni === 0 && atlanan > 0) {
    log('Tum kayitlar daha once indirilmis; yeni fatura yok.', 'uyari');
  }
  log(`Klasor: ${klasor}`, 'basari');
  return { basari: true, xmlSayisi: mevcut, yeni, klasor };
}

async function indirFatura(params, callbacks = {}) {
  if (params.faturaKodu === 'tumu') {
    const { onLog } = callbacks;
    const log = (mesaj, tip = 'bilgi') => {
      if (typeof onLog === 'function') onLog({ mesaj, tip });
    };
    log('Tum turler indiriliyor (gelen + giden + e-arsiv + e-mustahsil)...');
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
