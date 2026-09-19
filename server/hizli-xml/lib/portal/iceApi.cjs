const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const ENDPOINT = 'https://integration.iceteknoloji.com.tr/integration.asmx';
const TEST_ENDPOINT = 'https://integrationtest.iceteknoloji.com.tr/integration.asmx';
const ENDPOINT_HTTP = 'http://integration.iceteknoloji.com.tr/integration.asmx';
const TEST_ENDPOINT_HTTP = 'http://integrationtest.iceteknoloji.com.tr/integration.asmx';
const ICE_APP_NAME = 'entegrasyon';
const ICE_APP_VERSION = '2017.10.11.3';

const FATURA_TURLERI = {
  gelen: { type: 'EFatura_Gelen', ad: 'Gelen e-Fatura' },
  giden: { type: 'EFatura_Giden', ad: 'Giden e-Fatura' },
  arsiv: { type: 'EArsiv', ad: 'e-Arsiv' },
  mustahsil: { type: 'EMM', ad: 'e-Mustahsil' },
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

function formatDate(yil, ay, gun, endOfDay = false) {
  const time = endOfDay ? '23:59:59' : '00:00:00';
  return `${yil}-${String(ay).padStart(2, '0')}-${String(gun).padStart(2, '0')}T${time}`;
}

function firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, yil, ay) {
  const ayStr = String(ay).padStart(2, '0');
  return path.join(
    indirmeKlasoru,
    `${firmaAdi}_${vkn}`.replace(/[<>:"/\\|?*]/g, '_'),
    `${ayStr}_${yil}_Aktarilacaklar`,
  );
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

function parseDate(value) {
  const s = String(value || '');
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function xmlMakulMu(xml) {
  const data = String(xml || '').replace(/^\uFEFF/, '').trim();
  return data.startsWith('<') && data.includes('>');
}

function decodeXmlPayload(raw) {
  let value = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!value) return '';

  // GetInvoice_XML_List bazen HTML-entity encode edilmis XML donduruyor.
  if (!value.startsWith('<') && value.includes('&lt;')) {
    value = value
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replace(/^\uFEFF/, '')
      .trim();
  }

  if (!value.startsWith('<')) {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
      if (decoded.startsWith('<') || decoded.includes('&lt;')) {
        return decodeXmlPayload(decoded);
      }
    } catch {
      // base64 degilse oldugu gibi birak.
    }
  }

  return value;
}

function normalizeText(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function isIptalRedStatus(text) {
  const t = normalizeText(text);
  return ['red', 'redded', 'ret', 'reject', 'iptal', 'cancel', 'canceled', 'cancelled'].some((k) => t.includes(k));
}

function endpointLabel(endpoint) {
  return endpoint.includes('integrationtest') ? 'TEST' : 'CANLI';
}

function normalizeEndpoint(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return ENDPOINT;

  let url = raw;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  url = url.replace('portaltest.iceteknoloji.com.tr', 'integrationtest.iceteknoloji.com.tr');
  url = url.replace('portal.iceteknoloji.com.tr', 'integration.iceteknoloji.com.tr');

  if (!/\/integration\.asmx$/i.test(url)) {
    url = `${url}/integration.asmx`;
  }
  return url;
}

function candidateEndpoints(apiUrl) {
  const out = [];
  const add = (value) => {
    if (!value) return;
    if (!out.includes(value)) out.push(value);
  };

  if (apiUrl && String(apiUrl).trim()) {
    const normalized = normalizeEndpoint(apiUrl);
    add(normalized);
    if (normalized.startsWith('https://')) add(normalized.replace(/^https:\/\//i, 'http://'));
    if (normalized.startsWith('http://')) add(normalized.replace(/^http:\/\//i, 'https://'));
    return out;
  }

  add(ENDPOINT);
  add(TEST_ENDPOINT);
  add(ENDPOINT_HTTP);
  add(TEST_ENDPOINT_HTTP);
  return out;
}

function basicAuthHeader(kullaniciAdi, sifre) {
  const token = Buffer.from(`${String(kullaniciAdi || '')}:${String(sifre || '')}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

async function soapCall(operation, payloadXml, options = {}) {
  const { basicAuth, endpoint } = options;
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operation} xmlns="http://tempuri.org/">
      ${payloadXml}
    </${operation}>
  </soap:Body>
</soap:Envelope>`;

  const url = new URL(endpoint || ENDPOINT);
  const transport = url.protocol === 'http:' ? http : https;
  const text = await new Promise((resolve, reject) => {
    const headers = {
      'content-type': 'text/xml; charset=utf-8',
      SOAPAction: `"http://tempuri.org/${operation}"`,
      'content-length': Buffer.byteLength(envelope, 'utf8'),
    };
    if (basicAuth) headers.authorization = basicAuth;

    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      method: 'POST',
      ...(url.protocol === 'https:' ? { secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT } : {}),
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const fault = parseTag(body, 'faultstring') || `HTTP ${res.statusCode}`;
          reject(new Error(`ICE SOAP hatasi: ${fault}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.write(envelope, 'utf8');
    req.end();
  });

  const fault = parseTag(text, 'faultstring');
  if (fault) throw new Error(`ICE SOAP fault: ${fault}`);
  return text;
}

async function login(kullaniciAdi, sifre, options = {}) {
  const endpoint = options.endpoint || ENDPOINT;
  const authHeader = basicAuthHeader(kullaniciAdi, sifre);
  const payloads = [
    {
      name: 'doc-basic-auth',
      basicAuth: authHeader,
      appName: ICE_APP_NAME,
      appVersion: ICE_APP_VERSION,
    },
    {
      name: 'doc-no-basic-auth',
      basicAuth: null,
      appName: ICE_APP_NAME,
      appVersion: ICE_APP_VERSION,
    },
    {
      name: 'legacy-basic-auth',
      basicAuth: authHeader,
      appName: 'Hizli XML Indirici',
      appVersion: '1.0',
    },
  ];

  let lastErr = null;
  for (const p of payloads) {
    const payload = `
<_Login_Request>
  <UserName>${escapeXml(kullaniciAdi)}</UserName>
  <Password>${escapeXml(sifre)}</Password>
  <Application_Name>${escapeXml(p.appName)}</Application_Name>
  <Application_Version>${escapeXml(p.appVersion)}</Application_Version>
</_Login_Request>`;
    try {
      const xml = await soapCall('Login', payload, { basicAuth: p.basicAuth, endpoint });
      const success = String(parseTag(xml, 'isSuccecss')).toLowerCase() === 'true';
      const message = parseTag(xml, 'Message');
      if (!success) throw new Error(message || 'ICE login basarisiz');

      const sessionId = parseTag(xml, 'Session_ID');
      const ip = parseTag(xml, 'IP_Number');
      const securityKey = parseTag(xml, 'Security_Key');
      if (!sessionId || !securityKey) {
        throw new Error('ICE login basarisiz: Session_ID/Security_Key alinamadi');
      }
      return {
        sessionId,
        ip,
        securityKey,
        basicAuth: p.basicAuth || authHeader,
        endpoint,
        loginMode: p.name,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('ICE login basarisiz');
}

function loginHeaderXml(loginInfo) {
  return `
<Login_Request_Header>
  <Session_ID>${escapeXml(loginInfo.sessionId)}</Session_ID>
  <IP_Number>${escapeXml(loginInfo.ip || '')}</IP_Number>
  <Security_Key>${escapeXml(loginInfo.securityKey)}</Security_Key>
</Login_Request_Header>`;
}

async function getArchive({ loginInfo, type, startDate, endDate, limit = 10000 }) {
  const payload = `
<Request>
  ${loginHeaderXml(loginInfo)}
  <LIMIT>${limit}</LIMIT>
  <ID></ID>
  <UUID></UUID>
  <START_DATE>${startDate}</START_DATE>
  <END_DATE>${endDate}</END_DATE>
  <Type>${type}</Type>
  <GET_XML>true</GET_XML>
</Request>`;
  const xml = await soapCall('Get_EDocument_Archive', payload, {
    basicAuth: loginInfo.basicAuth,
    endpoint: loginInfo.endpoint,
  });
  const ok = String(parseTag(xml, 'Success')).toLowerCase() === 'true';
  if (!ok) {
    const message = parseTag(xml, 'ResponseMessage');
    throw new Error(message || 'ICE arsiv listesi alinamadi');
  }
  const docs = parseBlocks(xml, 'EDocumentArchive').map((b) => ({
    id: parseTag(b, 'ID'),
    uuid: parseTag(b, 'UUID'),
    issueDate: parseTag(b, 'IssueDate'),
    senderTitle: parseTag(b, 'SenderTitle'),
    receiverTitle: parseTag(b, 'ReceiverTitle'),
    status: [
      parseTag(b, 'STATUS'),
      parseTag(b, 'Status'),
      parseTag(b, 'STATUS_DESCRIPTION'),
      parseTag(b, 'StatusDescription'),
      parseTag(b, 'RESPONSE_DESCRIPTION'),
      parseTag(b, 'ResponseDescription'),
      parseTag(b, 'RESPONSE_CODE'),
      parseTag(b, 'ResponseCode'),
      parseTag(b, 'GIB_STATUS_DESCRIPTION'),
      parseTag(b, 'GIBStatusDescription'),
    ].filter(Boolean).join(' | '),
    data: parseTag(b, 'EDocumentData'),
  }));
  return docs;
}

async function getDetailList({
  loginInfo, type, startDate, endDate, limit = 10000, dateType = 'DocumentDate',
}) {
  const payload = `
<Request>
  ${loginHeaderXml(loginInfo)}
  <Type>${escapeXml(type)}</Type>
  <DocumentID xsi:nil="true" />
  <StartDate>${startDate}</StartDate>
  <EndDate>${endDate}</EndDate>
  <DateType>${escapeXml(dateType)}</DateType>
  <ID></ID>
  <UUID></UUID>
  <OFFSET>0</OFFSET>
  <LIMIT>${limit}</LIMIT>
  <GIBStatusCode xsi:nil="true" />
</Request>`;
  const xml = await soapCall('Get_EDocument_Detail_List', payload, {
    basicAuth: loginInfo.basicAuth,
    endpoint: loginInfo.endpoint,
  });
  const ok = String(parseTag(xml, 'Success')).toLowerCase() === 'true';
  if (!ok) {
    const message = parseTag(xml, 'ResponseMessage');
    throw new Error(message || 'ICE detail list alinamadi');
  }
  return parseBlocks(xml, 'EDocumentDetail').map((b) => ({
    id: parseTag(b, 'ID'),
    uuid: parseTag(b, 'UUID'),
    issueDate: parseTag(b, 'IssueDate'),
    status: [
      parseTag(b, 'ResponseCode'),
      parseTag(b, 'ResponseDescription'),
      parseTag(b, 'GIBStatusDescription'),
    ].filter(Boolean).join(' | '),
    data: '',
  }));
}

async function getInvoiceXmlListByUuids({ loginInfo, uuids }) {
  const list = (uuids || []).filter(Boolean);
  if (!list.length) return new Map();

  const byUuid = new Map();
  const chunkSize = 40;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const payload = `
<getInvoice_ETTN_List>
  ${loginHeaderXml(loginInfo)}
  <ETTNs>
    ${chunk.map((u) => `<string>${escapeXml(u)}</string>`).join('')}
  </ETTNs>
</getInvoice_ETTN_List>`;
    const xml = await soapCall('GetInvoice_XML_List', payload, {
      basicAuth: loginInfo.basicAuth,
      endpoint: loginInfo.endpoint,
    });
    const payloads = parseBlocks(xml, 'string').map((s) => decodeXmlPayload(parseTag(s, 'string')));
    chunk.forEach((uuid, idx) => {
      const data = payloads[idx] || '';
      if (data) byUuid.set(uuid, data);
    });
  }
  return byUuid;
}

function documentListTypesForType(type) {
  if (type === FATURA_TURLERI.gelen.type) return ['EFatura_Gelen'];
  if (type === FATURA_TURLERI.giden.type) return ['EFatura_Giden'];
  if (type === FATURA_TURLERI.arsiv.type) return ['EArsiv'];
  if (type === FATURA_TURLERI.mustahsil.type) return ['EMM', 'ESMM'];
  return [type];
}

function archiveTypesForType(type) {
  return documentListTypesForType(type);
}

function rowKey(row) {
  return `${row.uuid || ''}::${row.id || ''}`;
}

function hasXmlData(row) {
  return String(row?.data || '').trim() !== '';
}

async function getDocumentList({
  loginInfo, type, startDate, endDate, dateType = 'DocumentDate',
}) {
  const payload = `
<Document_List_Request>
  ${loginHeaderXml(loginInfo)}
  <Type>${escapeXml(type)}</Type>
  <START_DATE>${startDate}</START_DATE>
  <END_DATE>${endDate}</END_DATE>
  <UUID_List></UUID_List>
  <DateType>${escapeXml(dateType)}</DateType>
</Document_List_Request>`;
  const xml = await soapCall('Get_Document_List', payload, {
    basicAuth: loginInfo.basicAuth,
    endpoint: loginInfo.endpoint,
  });
  const ok = String(parseTag(xml, 'Success')).toLowerCase() === 'true';
  if (!ok) {
    const message = parseTag(xml, 'Response_Message') || parseTag(xml, 'ResponseMessage');
    throw new Error(message || 'ICE document list alinamadi');
  }
  return parseBlocks(xml, 'Document_Detail').map((b) => ({
    id: parseTag(b, 'ID'),
    uuid: parseTag(b, 'UUID'),
    issueDate: parseTag(b, 'IssueDate') || parseTag(b, 'CreationDate'),
    status: [
      parseTag(b, 'Status_Code'),
      parseTag(b, 'Status_Description'),
    ].filter(Boolean).join(' | '),
    data: '',
  }));
}

async function getInvoiceList({
  loginInfo, startDate, endDate, direction = 'IN', limit = 10000, fromVkn = '', toVkn = '',
}) {
  const payload = `
<GetInvoiceRequest>
  ${loginHeaderXml(loginInfo)}
  <INVOICE_SEARCH_KEY>
    <LIMIT>${limit}</LIMIT>
    <LIMITSpecified>true</LIMITSpecified>
    <ID></ID>
    <UUID></UUID>
    <FROM>${escapeXml(fromVkn)}</FROM>
    <TO>${escapeXml(toVkn)}</TO>
    <START_DATE>${startDate}</START_DATE>
    <START_DATESpecified>true</START_DATESpecified>
    <END_DATE>${endDate}</END_DATE>
    <END_DATESpecified>true</END_DATESpecified>
    <READ_INCLUDED>true</READ_INCLUDED>
    <READ_INCLUDEDSpecified>true</READ_INCLUDEDSpecified>
    <PROCESSED_INCLUDED>true</PROCESSED_INCLUDED>
    <PROCESSED_INCLUDEDSpecified>true</PROCESSED_INCLUDEDSpecified>
    <DIRECTION>${escapeXml(direction)}</DIRECTION>
    <SENDER></SENDER>
    <RECEIVER></RECEIVER>
  </INVOICE_SEARCH_KEY>
  <HEADER_ONLY>N</HEADER_ONLY>
</GetInvoiceRequest>`;

  const xml = await soapCall('GetInvoice', payload, {
    basicAuth: loginInfo.basicAuth,
    endpoint: loginInfo.endpoint,
  });
  const blocks = parseBlocks(xml, 'INVOICE').map((b) => ({
    id: parseTag(b, 'ID'),
    uuid: parseTag(b, 'UUID'),
    issueDate: parseTag(b, 'ISSUE_DATE'),
    senderTitle: parseTag(b, 'SUPPLIER') || parseTag(b, 'SENDER'),
    receiverTitle: parseTag(b, 'CUSTOMER') || parseTag(b, 'RECEIVER'),
    status: [
      parseTag(b, 'STATUS'),
      parseTag(b, 'STATUS_DESCRIPTION'),
      parseTag(b, 'RESPONSE_DESCRIPTION'),
      parseTag(b, 'RESPONSE_CODE'),
      parseTag(b, 'GIB_STATUS_DESCRIPTION'),
      parseTag(b, 'GIB_STATUS_CODE'),
    ].filter(Boolean).join(' | '),
    data: decodeXmlPayload(parseTag(b, 'CONTENT')),
  }));
  return blocks;
}

function parseProducerReceiptBlocks(xml) {
  return parseBlocks(xml, 'ProducerReceipt').map((b) => {
    const header = (b.match(/<(?:[\w-]+:)?HEADER\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?HEADER>/i) || [])[0] || '';
    return {
      id: parseTag(b, 'ID'),
      uuid: parseTag(b, 'UUID'),
      issueDate: parseTag(header, 'ISSUE_DATE') || parseTag(b, 'ISSUE_DATE') || parseTag(header, 'CDATE'),
      senderTitle: parseTag(header, 'SUPPLIER_TITLE') || parseTag(header, 'SUPPLIER'),
      receiverTitle: parseTag(header, 'CUSTOMER_TITLE') || parseTag(header, 'CUSTOMER'),
      status: [
        parseTag(b, 'STATUS_CODE'),
        parseTag(b, 'STATUS_DESCRIPTION'),
      ].filter(Boolean).join(' | '),
      data: decodeXmlPayload(parseTag(b, 'CONTENT')),
    };
  });
}

/**
 * e-Müstahsil listesi.
 * ÖNEMLİ: Boş <ID></ID> / <UUID_List></UUID_List> ICE'de sonucu sıfırlıyor.
 * Seçilen ay için sadece tarih aralığı gönderilir.
 */
async function getProducerReceiptList({
  loginInfo, startDate, endDate, limit = 10000, headerOnly = 'N', id = '', uuids = null,
}) {
  const idXml = id ? `<ID>${escapeXml(id)}</ID>` : '';
  const uuidListXml = Array.isArray(uuids) && uuids.length
    ? `<UUID_List>${uuids.map((u) => `<string>${escapeXml(u)}</string>`).join('')}</UUID_List>`
    : '';
  const payload = `
<GetProducerReceiptRequest>
  ${loginHeaderXml(loginInfo)}
  <ProducerReceipt_SEARCH_KEY>
    <LIMIT>${limit}</LIMIT>
    <LIMITSpecified>true</LIMITSpecified>
    ${idXml}
    ${uuidListXml}
    <START_DATE>${startDate}</START_DATE>
    <START_DATESpecified>true</START_DATESpecified>
    <END_DATE>${endDate}</END_DATE>
    <END_DATESpecified>true</END_DATESpecified>
  </ProducerReceipt_SEARCH_KEY>
  <HEADER_ONLY>${escapeXml(headerOnly)}</HEADER_ONLY>
</GetProducerReceiptRequest>`;

  const xml = await soapCall('GetProducerReceipt', payload, {
    basicAuth: loginInfo.basicAuth,
    endpoint: loginInfo.endpoint,
  });
  return parseProducerReceiptBlocks(xml);
}

async function getDocumentDataXml({
  loginInfo, type, uuid, vkn = '',
}) {
  if (!uuid) return '';
  const payload = `
<DocumentDataRequest>
  <type>${escapeXml(type)}</type>
  <vkn_tckn>${escapeXml(vkn)}</vkn_tckn>
  <uuid>${escapeXml(uuid)}</uuid>
  <get_xml>true</get_xml>
  <get_html>false</get_html>
  <get_pdf>false</get_pdf>
  ${loginHeaderXml(loginInfo)}
</DocumentDataRequest>`;
  const xml = await soapCall('GetDocumnetData', payload, {
    basicAuth: loginInfo.basicAuth,
    endpoint: loginInfo.endpoint,
  });
  const ok = String(parseTag(xml, 'success')).toLowerCase() === 'true';
  if (!ok) {
    const message = parseTag(xml, 'response_message') || 'GetDocumnetData basarisiz';
    throw new Error(message);
  }
  return decodeXmlPayload(parseTag(xml, 'xml_data'));
}

async function fillMissingXmlData(loginInfo, merged, opts = {}) {
  const missing = Array.from(merged.values()).filter((row) => row.uuid && !hasXmlData(row));
  if (!missing.length) return;

  const docType = opts.documentType || '';
  const vkn = opts.vkn || '';

  // Müstahsil / e-belge: GetInvoice_XML_List genelde işe yaramaz → GetDocumnetData
  if (docType === 'EMM' || docType === 'ESMM' || docType === 'EArsiv') {
    for (const row of missing) {
      try {
        const data = await getDocumentDataXml({
          loginInfo,
          type: docType === 'ESMM' ? 'ESMM' : (docType === 'EArsiv' ? 'EArsiv' : 'EMM'),
          uuid: row.uuid,
          vkn,
        });
        if (!data) continue;
        merged.set(rowKey(row), { ...row, data });
      } catch {
        // Tek kayit basarisizsa digerlerine devam.
      }
    }
  }

  const stillMissing = Array.from(merged.values()).filter((row) => row.uuid && !hasXmlData(row));
  if (!stillMissing.length) return;

  const xmlByUuid = await getInvoiceXmlListByUuids({
    loginInfo,
    uuids: stillMissing.map((row) => row.uuid),
  });
  for (const row of stillMissing) {
    const data = xmlByUuid.get(row.uuid);
    if (!data) continue;
    const key = rowKey(row);
    merged.set(key, { ...row, data });
  }
}

async function listViaDocumentList({
  loginInfo, type, startDate, endDate, merged,
}) {
  const types = documentListTypesForType(type);
  for (const listType of types) {
    for (const dateType of ['DocumentDate', 'CreateDate']) {
      try {
        const rows = await getDocumentList({
          loginInfo,
          type: listType,
          startDate,
          endDate,
          dateType,
        });
        for (const row of rows) {
          const key = rowKey(row);
          if (!merged.has(key)) merged.set(key, row);
        }
        if (rows.length) break;
      } catch {
        // Bu tarih tipi / belge turu basarisizsa digerine gec.
      }
    }
  }
}

async function listViaDetailAndXml({
  loginInfo, type, startDate, endDate, limit = 10000, merged,
}) {
  for (const dateType of ['DocumentDate', 'CreateDate']) {
    try {
      const details = await getDetailList({
        loginInfo,
        type,
        startDate,
        endDate,
        limit,
        dateType,
      });
      if (!details.length) continue;

      for (const detail of details) {
        const key = rowKey(detail);
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, { ...detail, data: '' });
        } else if (!hasXmlData(existing)) {
          merged.set(key, {
            ...existing,
            issueDate: existing.issueDate || detail.issueDate || '',
            status: existing.status || detail.status || '',
          });
        }
      }

      await fillMissingXmlData(loginInfo, merged, { documentType: type, vkn: '' });
      if (Array.from(merged.values()).some(hasXmlData)) return;
    } catch {
      // Bu fallback denemesi basarisiz olursa digerine gec.
    }
  }
}

async function listDocumentsByType({
  loginInfo, type, startDate, endDate, limit = 10000, vkn = '', log = null,
}) {
  const merged = new Map();
  const addRows = (rows) => {
    for (const row of rows) {
      const key = rowKey(row);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, row);
        continue;
      }
      if (!hasXmlData(existing) && hasXmlData(row)) {
        merged.set(key, { ...existing, ...row, data: row.data });
      }
    }
  };

  // e-Müstahsil: seçilen ay tarih aralığıyla GetProducerReceipt
  if (type === FATURA_TURLERI.mustahsil.type) {
    try {
      if (typeof log === 'function') {
        log('e-Mustahsil: secilen ay icin liste aliniyor...', 'bilgi');
      }
      addRows(await getProducerReceiptList({
        loginInfo,
        startDate,
        endDate,
        limit,
        headerOnly: 'N',
      }));
    } catch (err) {
      if (typeof log === 'function') {
        log(`e-Mustahsil tarih listesi: ${err.message || err}`, 'uyari');
      }
    }
  }

  // Gelen: GetInvoice CONTENT ile gelir.
  if (type === FATURA_TURLERI.gelen.type) {
    try {
      const rows = await getInvoiceList({
        loginInfo,
        startDate,
        endDate,
        direction: 'IN',
        limit,
        fromVkn: '',
        toVkn: String(vkn || ''),
      });
      addRows(rows);
      if (rows.length === 0 && vkn) {
        addRows(await getInvoiceList({
          loginInfo,
          startDate,
          endDate,
          direction: 'IN',
          limit,
          fromVkn: '',
          toVkn: '',
        }));
      }
    } catch {
      // Document list fallback.
    }
  }

  // Giden / e-arsiv / mustahsil (ve gelen bos kaldıysa): Get_Document_List asil kaynak.
  if (type !== FATURA_TURLERI.gelen.type || merged.size === 0) {
    await listViaDocumentList({
      loginInfo,
      type,
      startDate,
      endDate,
      merged,
    });
  }

  const archiveTypes = archiveTypesForType(type);
  for (const archiveType of archiveTypes) {
    try {
      addRows(await getArchive({
        loginInfo,
        type: archiveType,
        startDate,
        endDate,
        limit,
      }));
    } catch {
      // Bu deneme başarısızsa diğer kombinasyonlara geç.
    }
  }

  const missingXml = Array.from(merged.values()).some((row) => !hasXmlData(row));
  if (merged.size === 0 || missingXml) {
    if (merged.size === 0) {
      await listViaDetailAndXml({
        loginInfo,
        type,
        startDate,
        endDate,
        limit,
        merged,
      });
    }
    await fillMissingXmlData(loginInfo, merged, { documentType: type, vkn });
  }

  return Array.from(merged.values());
}

async function testBaglanti(params) {
  const {
    kullaniciAdi, sifre, yil, ay, faturaKodu, apiUrl,
  } = params;
  if (!kullaniciAdi || !sifre) return { ok: false, msg: 'Kullanici adi/sifre eksik' };
  const endpoints = candidateEndpoints(apiUrl);
  try {
    const tur = FATURA_TURLERI[faturaKodu] || FATURA_TURLERI.gelen;
    const y = yil || new Date().getFullYear();
    const a = ay || (new Date().getMonth() + 1);
    const son = aySonGunu(y, a);
    const errors = [];
    for (const endpoint of endpoints) {
      try {
        const loginInfo = await login(kullaniciAdi, sifre, { endpoint });
        const docs = await listDocumentsByType({
          loginInfo,
          type: tur.type,
          startDate: formatDate(y, a, 1),
          endDate: formatDate(y, a, son, true),
          limit: 25,
        vkn: params.vkn || '',
        });
        return {
          ok: true,
          msg: `ICE baglanti basarili (${endpointLabel(endpoint)} | ${endpoint}). ${docs.length} kayit listelendi.`,
        };
      } catch (err) {
        errors.push(`${endpointLabel(endpoint)}: ${err.message || String(err)}`);
      }
    }
    return { ok: false, msg: errors.join(' | ') };
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
    kullaniciAdi, sifre, vkn, firmaAdi, yil, ay, faturaKodu, indirmeKlasoru, apiUrl, iptalRedDahil,
  } = params;
  if (!kullaniciAdi || !sifre) throw new Error('API kullanici adi / sifre eksik');
  if (!indirmeKlasoru) throw new Error('indirmeKlasoru gerekli');

  const tur = FATURA_TURLERI[faturaKodu];
  if (!tur) throw new Error(`Gecersiz fatura turu: ${faturaKodu}`);
  const son = aySonGunu(yil, ay);
  const klasor = firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, yil, ay);
  if (!fs.existsSync(klasor)) fs.mkdirSync(klasor, { recursive: true });

  log(`${firmaAdi} — ${tur.ad} — ${yil}/${String(ay).padStart(2, '0')}`);
  const endpoints = candidateEndpoints(apiUrl);
  let docs = [];
  let loginInfo = null;
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      log(`ICE API oturumu aciliyor (${endpointLabel(endpoint)})...`);
      loginInfo = await login(kullaniciAdi, sifre, { endpoint });
      log(`Endpoint: ${endpoint}`, 'bilgi');
      log(`Belge listesi aliniyor (${endpointLabel(endpoint)})...`);
      docs = await listDocumentsByType({
        loginInfo,
        type: tur.type,
        startDate: formatDate(yil, ay, 1),
        endDate: formatDate(yil, ay, son, true),
        vkn,
        log,
      });
      log(`Baglanti modu: ${loginInfo.loginMode}`, 'bilgi');
      break;
    } catch (err) {
      errors.push(`${endpointLabel(endpoint)}: ${err.message || String(err)}`);
    }
  }
  if (!loginInfo) {
    throw new Error(errors.join(' | ') || 'ICE baglantisi kurulamadi');
  }

  const ayFiltreli = docs.filter((d) => {
    const parsed = parseDate(d.issueDate);
    if (!parsed) return true;
    return parsed.getFullYear() === yil && (parsed.getMonth() + 1) === ay;
  });
  const donemDisi = docs.length - ayFiltreli.length;
  docs = ayFiltreli;
  if (iptalRedDahil !== true) {
    const once = docs.length;
    docs = docs.filter((d) => !isIptalRedStatus(d.status));
    const filtrelenen = once - docs.length;
    if (filtrelenen > 0) log(`${filtrelenen} iptal/red kayit filtrelenip atlandi`, 'uyari');
  }
  if (donemDisi > 0) log(`${donemDisi} kayit belge tarihi secili ayda olmadigi icin atlandi`, 'uyari');
  log(`${docs.length} kayit indirilecek`, docs.length ? 'basari' : 'uyari');
  if (docs.length === 0 && faturaKodu === 'mustahsil') {
    log('Secilen ayda e-Mustahsil kaydi bulunamadi.', 'uyari');
  }

  let yeni = 0;
  let atlanan = 0;
  let apiAtlanan = 0;
  for (const [i, d] of docs.entries()) {
    const uuid = d.uuid || '';
    const docId = (d.id || uuid || `doc-${i + 1}`).replace(/[<>:"/\\|?*]/g, '_');
    const dosyaAdi = `${docId}_${uuid || 'UUIDYOK'}.xml`;
    const hedef = path.join(klasor, dosyaAdi);
    if (fs.existsSync(hedef)) {
      atlanan += 1;
      continue;
    }
    if (!d.data) {
      apiAtlanan += 1;
      continue;
    }
    const xml = decodeXmlPayload(d.data);
    if (!xmlMakulMu(xml)) {
      apiAtlanan += 1;
      continue;
    }
    fs.writeFileSync(hedef, xml, 'utf8');
    yeni += 1;
    log(`${i + 1}/${docs.length} — ${dosyaAdi}`, 'bilgi');
  }

  const mevcut = fs.readdirSync(klasor).filter((f) => f.toLowerCase().endsWith('.xml')).length;
  if (apiAtlanan > 0) {
    log(`${apiAtlanan} kayit API tarafinda indirilemedigi icin atlandi`, 'uyari');
  }
  log(`${yeni} yeni indirildi, ${atlanan} zaten vardi, toplam ${mevcut} XML`, yeni ? 'basari' : 'bilgi');
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

/** Teşhis: EMM/ESMM için hangi ICE metodu ne dönüyor (şifre loglanmaz) */
async function __diagList(params) {
  const {
    kullaniciAdi, sifre, apiUrl, yil, ay,
  } = params;
  const son = aySonGunu(yil, ay);
  const startDate = formatDate(yil, ay, 1);
  const endDate = formatDate(yil, ay, son, true);
  const endpoints = candidateEndpoints(apiUrl);
  const endpoint = endpoints[0];
  const loginInfo = await login(kullaniciAdi, sifre, { endpoint });
  const types = ['EMM', 'ESMM', 'EArsiv'];
  const out = {
    endpoint,
    loginMode: loginInfo.loginMode,
    startDate,
    endDate,
    probes: [],
  };

  try {
    const rows = await getProducerReceiptList({
      loginInfo, startDate, endDate, limit: 10000, headerOnly: 'N',
    });
    out.probes.push({
      method: 'GetProducerReceipt',
      ok: true,
      count: rows.length,
      withXml: rows.filter((r) => hasXmlData(r)).length,
      sampleIds: rows.slice(0, 5).map((r) => r.id),
    });
  } catch (err) {
    out.probes.push({
      method: 'GetProducerReceipt', ok: false, error: err.message,
    });
  }

  // Ham yanıt / sayım — EMM gerçekten var mı?
  for (const draft of [false, true]) {
    for (const type of ['EMM', 'ESMM']) {
      try {
        const payload = `
<GetEDocumentCountRequest>
  ${loginHeaderXml(loginInfo)}
  <Type>${escapeXml(type)}</Type>
  <Draft>${draft}</Draft>
  <START_DATE>${startDate}</START_DATE>
  <END_DATE>${endDate}</END_DATE>
  <DateType>DocumentDate</DateType>
</GetEDocumentCountRequest>`;
        const xml = await soapCall('Get_EDocument_Count', payload, {
          basicAuth: loginInfo.basicAuth,
          endpoint: loginInfo.endpoint,
        });
        const count = parseTag(xml, 'Get_EDocument_CountResult');
        out.probes.push({
          method: 'Get_EDocument_Count', type, draft, ok: true, count: Number(count || 0),
        });
      } catch (err) {
        out.probes.push({
          method: 'Get_EDocument_Count', type, draft, ok: false, error: err.message,
        });
      }
    }
  }

  for (const type of types) {
    for (const dateType of ['DocumentDate', 'CreateDate']) {
      try {
        const rows = await getDocumentList({
          loginInfo, type, startDate, endDate, dateType,
        });
        out.probes.push({
          method: 'Get_Document_List', type, dateType, ok: true, count: rows.length,
          sampleIds: rows.slice(0, 3).map((r) => r.id),
        });
      } catch (err) {
        out.probes.push({
          method: 'Get_Document_List', type, dateType, ok: false, error: err.message,
        });
      }
    }
    try {
      const rows = await getArchive({
        loginInfo, type, startDate, endDate, limit: 10000,
      });
      const withXml = rows.filter((r) => hasXmlData(r)).length;
      out.probes.push({
        method: 'Get_EDocument_Archive',
        type,
        ok: true,
        count: rows.length,
        withXml,
        sampleIds: rows.slice(0, 5).map((r) => r.id),
      });
    } catch (err) {
      out.probes.push({
        method: 'Get_EDocument_Archive', type, ok: false, error: err.message,
      });
    }
    for (const dateType of ['DocumentDate', 'CreateDate']) {
      try {
        const rows = await getDetailList({
          loginInfo, type, startDate, endDate, limit: 10000, dateType,
        });
        out.probes.push({
          method: 'Get_EDocument_Detail_List', type, dateType, ok: true, count: rows.length,
          sampleIds: rows.slice(0, 3).map((r) => r.id),
        });
      } catch (err) {
        out.probes.push({
          method: 'Get_EDocument_Detail_List', type, dateType, ok: false, error: err.message,
        });
      }
    }
  }
  return out;
}

module.exports = {
  indirFatura,
  testBaglanti,
  FATURA_TURLERI,
  ENDPOINT,
  __diagList,
};
