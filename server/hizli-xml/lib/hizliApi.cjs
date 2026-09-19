// Hizli Teknoloji eConnect REST API — Login + GetDocumentList + GetDocumentFile

const path = require('path');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');

const BASE_URL = 'https://econnect.hizliteknoloji.com.tr/HizliApi/RestApi/';

const FATURA_TURLERI = {
  gelen: { appType: 1, ad: 'Gelen e-Fatura' },
  giden: { appType: 2, ad: 'Giden e-Fatura' },
  arsiv: { appType: 3, ad: 'e-Arsiv' },
  mustahsil: { appType: 7, ad: 'e-Mustahsil' },
};

const TUM_TURLER = ['gelen', 'giden', 'arsiv', 'mustahsil'];
// Hizli API toplu XML vermiyor; hizi max paralel + keep-alive ile artiriyoruz.
const XML_INDIR_CONCURRENCY = 16;
const TUM_TUR_CONCURRENCY = 1;
const API_TIMEOUT_MS = 45000;
const encryptCache = new Map();
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 16,
  keepAliveMsecs: 30000,
  scheduling: 'fifo',
});

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => runner()));
  return results;
}
const RED_DURUM_ANAHTARLARI = [
  'red',
  'redded',
  'reddedildi',
  'ret',
  'reject',
  'rejected',
  'declined',
  'deny',
  'denied',
  'cancel',
  'cancelled',
  'canceled',
  'iptal',
];
const API_ATLANABILIR_MESAJLAR = [
  'ilgili mustahsil bulunamadi',
  'ilgili belge bulunamadi',
  'ilgili fatura bulunamadi',
  'islem sirasinda beklenmeyen hata',
];

function aySonGunu(yil, ay) {
  return new Date(yil, ay, 0).getDate();
}

function formatDate(yil, ay, gun) {
  return `${yil}-${String(ay).padStart(2, '0')}-${String(gun).padStart(2, '0')}`;
}

function tarihAraliginiGenislet(yil, ay) {
  const bas = new Date(yil, ay - 2, 1);
  const bit = new Date(yil, ay + 1, 0);
  return {
    baslangic: formatDate(bas.getFullYear(), bas.getMonth() + 1, bas.getDate()),
    bitis: formatDate(bit.getFullYear(), bit.getMonth() + 1, bit.getDate()),
  };
}

function normalizeVergiNo(val) {
  return String(val || '').replace(/\D/g, '');
}

function firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, yil, ay) {
  const ayStr = String(ay).padStart(2, '0');
  return path.join(
    indirmeKlasoru,
    `${firmaAdi}_${vkn}`.replace(/[<>:"/\\|?*]/g, '_'),
    `${ayStr}_${yil}_Aktarilacaklar`,
  );
}

function authHeaders(oturum) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'cache-control': 'no-cache',
  };
  // Canli API: Login sonrasi Authorization Bearer zorunlu.
  // username/password header gondermek basarisiz yanit donduruyor.
  if (oturum?.token) {
    headers.Authorization = `Bearer ${oturum.token}`;
  }
  return headers;
}

function normalizeRequestError(error) {
  const raw = error?.message || String(error || 'Bilinmeyen hata');
  if (raw.includes('ByteString') && raw.includes('greater than 255')) {
    return 'Kullanici adi/sifre alaninda Turkce karakter oldugu icin API istegi olusturulamadi. Lutfen portal WS kullanici adini (ASCII) girin.';
  }
  return raw;
}

function dokumanIptalRedMi(doc) {
  if (!doc || typeof doc !== 'object') return false;

  const boolAlanlar = [
    'IsCancelled',
    'IsCanceled',
    'Cancelled',
    'Canceled',
    'IsRejected',
    'Rejected',
    'IsRed',
  ];
  for (const key of boolAlanlar) {
    if (doc[key] === true) return true;
  }

  const metinAlanlar = [
    'Status',
    'DocumentStatus',
    'InvoiceStatus',
    'ResponseStatus',
    'ResponseDescription',
    'ResponseText',
    'RejectReason',
    'ApplicationResponseStatus',
    'CurrentStatus',
    'CurrentStatusName',
    'StatusDescription',
    'StatusText',
    'EnvelopeStatus',
    'CancelStatus',
    'State',
    'Durum',
  ];
  for (const key of metinAlanlar) {
    const val = doc[key];
    if (val == null) continue;
    const metin = normalizeTextForCompare(val);
    if (RED_DURUM_ANAHTARLARI.some((k) => metin.includes(k))) return true;
  }

  // Bazi API varyantlarinda red/ret durumlari farkli alan adlariyla gelebiliyor.
  // Status/durum/yanit benzeri anahtarlarin degerlerini dinamik tarayarak kacirmayalim.
  for (const [rawKey, rawVal] of Object.entries(doc)) {
    if (rawVal == null) continue;
    const key = normalizeTextForCompare(rawKey);
    const durumAlaniMi = key.includes('status')
      || key.includes('durum')
      || key.includes('yanit')
      || key.includes('response')
      || key.includes('state')
      || key.includes('reject')
      || key.includes('ret')
      || key.includes('red');
    if (!durumAlaniMi) continue;

    const val = normalizeTextForCompare(rawVal);
    if (RED_DURUM_ANAHTARLARI.some((k) => val.includes(k))) return true;
  }

  return false;
}

function parseTarih(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function dokumanBelgeTarihi(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const oncelikliAlanlar = [
    'IssueDate',
    'DocumentDate',
    'InvoiceIssueDate',
    'InvoiceDate',
    'BelgeTarihi',
    'DocDate',
  ];
  for (const key of oncelikliAlanlar) {
    const tarih = parseTarih(doc[key]);
    if (tarih) return tarih;
  }
  return null;
}

function dokumanBelgeAyindaMi(doc, yil, ay) {
  const tarih = dokumanBelgeTarihi(doc);
  if (!tarih) return true;
  return tarih.getFullYear() === yil && (tarih.getMonth() + 1) === ay;
}

function normalizeTextForCompare(value) {
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

function apiTarafindaAtlanabilirMesajMi(value) {
  const text = normalizeTextForCompare(value);
  return API_ATLANABILIR_MESAJLAR.some((m) => text.includes(m));
}

function xmlIcerigiMakulMu(xml) {
  if (!xml) return false;
  const temiz = String(xml).replace(/^\uFEFF/, '').trim();
  if (!temiz.startsWith('<')) return false;
  if (!temiz.includes('>')) return false;
  if (/^<\?xml/i.test(temiz)) return true;
  if (/<[A-Za-z_:][\w:.-]*/.test(temiz)) return true;
  return false;
}

function httpJsonIstek(targetUrl, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
    const payload = body == null ? null : Buffer.from(body, 'utf8');
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'content-length': payload.length } : {}),
      },
      agent: httpsAgent,
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, text });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`API zaman asimi (${API_TIMEOUT_MS / 1000}sn)`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function apiIstek(endpoint, query, oturum, { method = 'GET', body = null } = {}) {
  const url = new URL(BASE_URL + endpoint);
  if (method === 'GET' || query) {
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }
  }

  let res;
  try {
    res = await httpJsonIstek(url, {
      method,
      headers: authHeaders(oturum),
      body: body ? JSON.stringify(body) : null,
    });
  } catch (error) {
    throw new Error(normalizeRequestError(error));
  }

  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error(`API yaniti okunamadi (HTTP ${res.status})`);
  }
  return data;
}

async function utilEncrypt(secretKey, kullaniciAdi, sifre) {
  const secret = String(secretKey || '').trim();
  const cacheKey = `${secret}\0${kullaniciAdi}\0${sifre}`;
  if (encryptCache.has(cacheKey)) return encryptCache.get(cacheKey);

  const data = await apiIstek('UtilEncrypt', null, { kullaniciAdi: '', sifre: '' }, {
    method: 'POST',
    body: {
      secretKey: secret,
      username: kullaniciAdi,
      password: sifre,
    },
  });
  const satir = Array.isArray(data) ? data[0] : data;
  const username = satir?.username || satir?.Username;
  const password = satir?.password || satir?.Password;
  if (!username || !password) {
    const hata = satir?.Message || satir?.message || satir?.ErrorMessage || satir?.errorMessage;
    throw new Error(hata || 'UtilEncrypt yaniti gecersiz');
  }
  const encrypted = { username, password };
  encryptCache.set(cacheKey, encrypted);
  return encrypted;
}

async function hizliOturumAc(opts) {
  const { kullaniciAdi, sifre, apiKey, secretKey, hedefVkn, hedefTckn, vkn } = opts;

  let loginUsername = kullaniciAdi;
  let loginPassword = sifre;
  const secret = String(secretKey || '').trim();
  if (secret) {
    const encrypted = await utilEncrypt(secret, kullaniciAdi, sifre);
    loginUsername = encrypted.username;
    loginPassword = encrypted.password;
  }

  const loginBody = { username: loginUsername, password: loginPassword };
  if (apiKey) loginBody.apiKey = apiKey;

  const loginData = await apiIstek('Login', null, { kullaniciAdi: loginUsername, sifre: loginPassword }, {
    method: 'POST',
    body: loginBody,
  });

  const loginSatirlari = Array.isArray(loginData) ? loginData : [loginData];
  const satirlar = loginSatirlari
    .filter((x) => x && (x.IsSucceeded ?? x.isSucceeded ?? true) !== false);

  if (!satirlar.length) {
    const ilkSatir = loginSatirlari[0] || {};
    const hata = ilkSatir.Message || ilkSatir.message || ilkSatir.ErrorMessage || ilkSatir.errorMessage;
    throw new Error(hata || 'Hizli API giris basarisiz');
  }

  const firmaHedefler = new Set([hedefVkn, hedefTckn].map(normalizeVergiNo).filter(Boolean));
  const secimHedefler = new Set([hedefVkn, hedefTckn, vkn].map(normalizeVergiNo).filter(Boolean));

  let musteri = satirlar.find((s) => secimHedefler.has(normalizeVergiNo(s.VknTckn)));
  if (!musteri && satirlar.length === 1) musteri = satirlar[0];
  if (!musteri) musteri = satirlar.find((s) => s.IsSucceeded !== false) || satirlar[0];

  const oturum = {
    kullaniciAdi: musteri.ServiceUsername || kullaniciAdi,
    sifre: musteri.ServicePassword || sifre,
    token: musteri.Token || null,
    subeKodu: musteri.SubeKodu,
    unvan: musteri.Unvan || musteri.MusteriAdi || '',
    vknTckn: musteri.VknTckn || '',
    firmaId: musteri.FirmaId,
    musteriSayisi: satirlar.length,
  };

  oturum.hedefEslesti = firmaHedefler.size === 0
    || firmaHedefler.has(normalizeVergiNo(oturum.vknTckn));

  return oturum;
}

async function oturumAcApiKeyFallback(opts, { onWarn } = {}) {
  try {
    return await hizliOturumAc(opts);
  } catch (ilkHata) {
    const apiKeyVardi = String(opts.apiKey || '').trim() !== '';
    if (!apiKeyVardi) throw ilkHata;

    if (typeof onWarn === 'function') {
      onWarn(`API key ile giris basarisiz: ${ilkHata.message}. API keysiz tekrar deneniyor...`);
    }

    return hizliOturumAc({ ...opts, apiKey: '' });
  }
}

function listeSorgusu(oturum, appType, dateType, baslangic, bitis, endpoint) {
  if (endpoint === 'GetDocumentReceiverAllList') {
    return {
      DateType: dateType,
      StartDate: baslangic,
      EndDate: bitis,
      TakenFromEntegrator: 'ALL',
    };
  }
  const query = {
    AppType: appType,
    StartDate: baslangic,
    EndDate: bitis,
    IsNew: 'false',
    IsExport: 'false',
    TakenFromEntegrator: 'ALL',
    IsDraft: 'false',
    DateType: dateType,
  };
  if (oturum.subeKodu != null && oturum.subeKodu !== '') {
    query.BranchCodes = oturum.subeKodu;
  }
  return query;
}

async function listeIstekleriCalistir(oturum, istekler, dokumanlar) {
  const sonuclar = await Promise.all(istekler.map(({ endpoint, query }) => (
    apiIstek(endpoint, query, oturum)
      .then((data) => (data && data.IsSucceeded !== false ? (data.documents || []) : []))
      .catch(() => [])
  )));
  for (const docs of sonuclar) {
    for (const doc of docs) {
      if (doc?.UUID) dokumanlar.set(doc.UUID, doc);
    }
  }
}

async function faturaListesiAl(opts) {
  const {
    oturum: verilenOturum,
    appType,
    baslangic,
    bitis,
    kesinBaslangic,
    kesinBitis,
  } = opts;
  const oturum = verilenOturum || await hizliOturumAc(opts);
  const dokumanlar = new Map();
  const ayBas = kesinBaslangic || baslangic;
  const ayBit = kesinBitis || bitis;

  // 2 paralel liste: ayin IssueDate + genis CreateDate.
  await listeIstekleriCalistir(oturum, [
    {
      endpoint: 'GetDocumentList',
      query: listeSorgusu(oturum, appType, 'IssueDate', ayBas, ayBit, 'GetDocumentList'),
    },
    {
      endpoint: 'GetDocumentList',
      query: listeSorgusu(oturum, appType, 'CreateDate', baslangic, bitis, 'GetDocumentList'),
    },
  ], dokumanlar);

  if (dokumanlar.size === 0) {
    await listeIstekleriCalistir(oturum, [{
      endpoint: 'GetDocumentReceiverAllList',
      query: listeSorgusu(oturum, appType, 'IssueDate', ayBas, ayBit, 'GetDocumentReceiverAllList'),
    }], dokumanlar);
  }

  return { oturum, dokumanlar: [...dokumanlar.values()] };
}

async function faturaXmlAl(opts) {
  const { oturum, appType, uuid } = opts;
  const data = await apiIstek('GetDocumentFile', {
    AppType: appType,
    Uuid: uuid,
    Tur: 'XML',
    IsDraft: 'false',
  }, oturum);

  if (!data.IsSucceeded) {
    const msg = data.Message || `XML alinamadi (${uuid})`;
    const err = new Error(msg);
    if (apiTarafindaAtlanabilirMesajMi(msg)) {
      err.code = 'API_KAYIT_ATLANDI';
    }
    throw err;
  }
  if (!data.DocumentFile) {
    throw new Error(`Bos XML icerigi (${uuid})`);
  }
  return Buffer.from(data.DocumentFile, 'base64').toString('utf8');
}

async function testBaglanti({ kullaniciAdi, sifre, apiKey, secretKey, hedefVkn, hedefTckn, vkn }) {
  if (!kullaniciAdi || !sifre) {
    return { ok: false, msg: 'Kullanici adi / sifre eksik' };
  }

  const bugun = new Date();
  const yil = bugun.getFullYear();
  const ay = bugun.getMonth() + 1;
  const ayStr = String(ay).padStart(2, '0');
  const son = aySonGunu(yil, ay);

  try {
    const oturum = await oturumAcApiKeyFallback({
      kullaniciAdi,
      sifre,
      apiKey,
      secretKey,
      hedefVkn,
      hedefTckn,
      vkn,
    });

    const { dokumanlar } = await faturaListesiAl({
      oturum,
      appType: 1,
      baslangic: `${yil}-${ayStr}-01`,
      bitis: `${yil}-${ayStr}-${String(son).padStart(2, '0')}`,
    });

    let msg = `Baglanti basarili. API firmasi: ${oturum.unvan || oturum.vknTckn}. Bu ay ${dokumanlar.length} gelen fatura.`;
    if (!oturum.hedefEslesti && (hedefVkn || hedefTckn)) {
      msg += ' UYARI: WS hesabi aktif firma VKN/TCKN ile eslesmiyor.';
    }
    if (oturum.musteriSayisi > 1) {
      msg += ` (${oturum.musteriSayisi} musteri, secilen: ${oturum.unvan})`;
    }

    return {
      ok: true,
      msg,
      faturaSayisi: dokumanlar.length,
      apiUnvan: oturum.unvan,
      apiVknTckn: oturum.vknTckn,
      hedefEslesti: oturum.hedefEslesti,
    };
  } catch (err) {
    return { ok: false, msg: err.message || String(err) };
  }
}

async function xmlParalelIndir(dokumanlar, opts, log) {
  const { oturum, appType, firmaKlasor } = opts;
  let yeni = 0;
  let atlanan = 0;
  let servisAtlanan = 0;
  let islenen = 0;
  let sonIlerlemeLog = 0;
  const kuyruk = [];

  for (const doc of dokumanlar) {
    const uuid = doc.UUID;
    if (!uuid) continue;
    const docId = (doc.DocumentId || uuid).replace(/[<>:"/\\|?*]/g, '_');
    const dosyaAdi = `${docId}_${uuid}.xml`;
    const hedef = path.join(firmaKlasor, dosyaAdi);
    if (fs.existsSync(hedef)) {
      atlanan += 1;
      continue;
    }
    kuyruk.push({ uuid, dosyaAdi, hedef });
  }

  if (kuyruk.length === 0) {
    const mevcut = fs.readdirSync(firmaKlasor).filter((f) => f.toLowerCase().endsWith('.xml')).length;
    return { mevcut, yeni: 0, atlanan, servisAtlanan: 0 };
  }

  const toplamHedef = kuyruk.length;
  log(`${toplamHedef} XML indirilecek (${XML_INDIR_CONCURRENCY} paralel)`, 'bilgi');

  const sonuclar = await mapPool(kuyruk, XML_INDIR_CONCURRENCY, async (item) => {
    try {
      const xml = await faturaXmlAl({ oturum, appType, uuid: item.uuid });
      if (!xmlIcerigiMakulMu(xml)) {
        throw new Error(`Gecersiz XML: ${item.dosyaAdi}`);
      }
      await fs.promises.writeFile(item.hedef, xml, 'utf8');
      yeni += 1;
      return { ok: true, dosyaAdi: item.dosyaAdi };
    } catch (error) {
      const msg = String(error?.message || error || '');
      if (error?.code === 'API_KAYIT_ATLANDI' || apiTarafindaAtlanabilirMesajMi(msg)) {
        servisAtlanan += 1;
        atlanan += 1;
        return { ok: false, atlandi: true };
      }
      throw error;
    } finally {
      islenen += 1;
      if (islenen - sonIlerlemeLog >= 5 || islenen === toplamHedef) {
        log(`Indiriliyor: ${islenen}/${toplamHedef}`, 'bilgi');
        sonIlerlemeLog = islenen;
      }
    }
  });

  for (const s of sonuclar) {
    if (s.status === 'rejected') {
      log(`XML hatasi: ${s.reason?.message || s.reason}`, 'uyari');
    }
  }

  const mevcut = fs.readdirSync(firmaKlasor).filter((f) => f.toLowerCase().endsWith('.xml')).length;
  if (servisAtlanan > 0) {
    log(`${servisAtlanan} kayit API tarafinda indirilemedigi icin atlandi`, 'uyari');
  }
  return { mevcut, yeni, atlanan, servisAtlanan };
}

async function indirFaturaTekTur(params, { onLog } = {}) {
  const {
    kullaniciAdi, sifre, apiKey, secretKey, vkn, firmaAdi, faturaKodu, yil, ay, indirmeKlasoru,
    hedefVkn, hedefTckn, iptalRedDahil, _oturum,
  } = params;

  if (!kullaniciAdi || !sifre) throw new Error('API kullanici adi / sifre eksik');
  if (!indirmeKlasoru) throw new Error('indirmeKlasoru gerekli');

  const turBilgi = FATURA_TURLERI[faturaKodu];
  if (!turBilgi) throw new Error(`Gecersiz fatura turu: ${faturaKodu}`);

  const ayStr = String(ay).padStart(2, '0');
  const sonGun = aySonGunu(yil, ay);
  const baslangic = `${yil}-${ayStr}-01`;
  const bitis = `${yil}-${ayStr}-${String(sonGun).padStart(2, '0')}`;
  const genisAralik = tarihAraliginiGenislet(yil, ay);

  const firmaKlasor = firmaKlasorYolu(indirmeKlasoru, firmaAdi, vkn, yil, ay);
  if (!fs.existsSync(firmaKlasor)) fs.mkdirSync(firmaKlasor, { recursive: true });

  const log = (mesaj, tip = 'bilgi') => {
    if (typeof onLog === 'function') onLog({ mesaj, tip });
  };

  log(`${firmaAdi} — ${turBilgi.ad} — ${yil}/${ayStr}`);

  let oturum = _oturum || null;
  if (!oturum) {
    log('API oturumu aciliyor...');
    oturum = await oturumAcApiKeyFallback({
      kullaniciAdi, sifre, apiKey, secretKey, hedefVkn, hedefTckn, vkn,
    }, {
      onWarn: (mesaj) => log(mesaj, 'uyari'),
    });
    log(`API firmasi: ${oturum.unvan || oturum.vknTckn}`);
    if (!oturum.hedefEslesti && (hedefVkn || hedefTckn)) {
      log(`UYARI: WS hesabi (${oturum.vknTckn}) hedef VKN/TCKN ile eslesmiyor.`, 'uyari');
    }
  }

  log('Fatura listesi aliniyor...');
  const { dokumanlar } = await faturaListesiAl({
    oturum,
    appType: turBilgi.appType,
    baslangic: genisAralik.baslangic,
    bitis: genisAralik.bitis,
    kesinBaslangic: baslangic,
    kesinBitis: bitis,
  });
  const belgeDonemiDokumanlari = dokumanlar.filter((doc) => dokumanBelgeAyindaMi(doc, yil, ay));
  const donemDisi = dokumanlar.length - belgeDonemiDokumanlari.length;

  const filtreUygula = iptalRedDahil !== true;
  const indirilecekDokumanlar = filtreUygula
    ? belgeDonemiDokumanlari.filter((doc) => !dokumanIptalRedMi(doc))
    : belgeDonemiDokumanlari;
  const filtrelenen = belgeDonemiDokumanlari.length - indirilecekDokumanlar.length;

  log(`Toplam ${dokumanlar.length} kayit bulundu, belge tarihine gore ${belgeDonemiDokumanlari.length} kayit secildi (${baslangic} - ${bitis})`, belgeDonemiDokumanlari.length ? 'basari' : 'uyari');
  if (donemDisi > 0) {
    log(`${donemDisi} belge, belge tarihi secili ayda olmadigi icin atlandi`, 'uyari');
  }
  if (filtreUygula && filtrelenen > 0) {
    log(`${filtrelenen} iptal/red belge filtrelenip atlandi`, 'uyari');
  }

  if (indirilecekDokumanlar.length === 0) {
    return { basari: true, xmlSayisi: 0, yeni: 0, klasor: firmaKlasor };
  }

  log('XML dosyalari indiriliyor...');
  const { mevcut, yeni, atlanan } = await xmlParalelIndir(indirilecekDokumanlar, {
    oturum,
    appType: turBilgi.appType,
    firmaKlasor,
  }, log);

  log(`${yeni} yeni indirildi, ${atlanan} zaten vardi, toplam ${mevcut} XML`, yeni ? 'basari' : 'bilgi');
  log(`Klasor: ${firmaKlasor}`, 'basari');

  return { basari: true, xmlSayisi: mevcut, yeni, klasor: firmaKlasor, oturum };
}

async function indirFatura(params, callbacks = {}) {
  if (params.faturaKodu === 'tumu') {
    const { onLog } = callbacks;
    const log = (mesaj, tip = 'bilgi') => {
      if (typeof onLog === 'function') onLog({ mesaj, tip });
    };
    log('Tum turler indiriliyor (gelen + giden + e-arsiv + e-mustahsil)...');

    const {
      kullaniciAdi, sifre, apiKey, secretKey, hedefVkn, hedefTckn, vkn,
    } = params;
    log('API oturumu aciliyor...');
    const oturum = await oturumAcApiKeyFallback({
      kullaniciAdi, sifre, apiKey, secretKey, hedefVkn, hedefTckn, vkn,
    }, {
      onWarn: (mesaj) => log(mesaj, 'uyari'),
    });
    log(`API firmasi: ${oturum.unvan || oturum.vknTckn}`);

    let yeni = 0;
    let xmlSayisi = 0;
    let firmaKlasor = '';
    const turSonuclari = await mapPool(TUM_TURLER, TUM_TUR_CONCURRENCY, async (kod) => {
      try {
        return await indirFaturaTekTur({ ...params, faturaKodu: kod, _oturum: oturum }, callbacks);
      } catch (err) {
        log(`${FATURA_TURLERI[kod].ad}: ${err.message}`, 'uyari');
        return { yeni: 0, xmlSayisi: 0, klasor: '' };
      }
    });
    for (const s of turSonuclari) {
      const res = s.status === 'fulfilled' ? s.value : null;
      if (!res) continue;
      yeni += res.yeni || 0;
      xmlSayisi = Math.max(xmlSayisi, res.xmlSayisi || 0);
      if (res.klasor) firmaKlasor = res.klasor;
    }
    log(`Toplam ${yeni} yeni XML indirildi`, yeni ? 'basari' : 'uyari');
    return { basari: true, xmlSayisi, yeni, klasor: firmaKlasor };
  }
  return indirFaturaTekTur(params, callbacks);
}

module.exports = {
  indirFatura,
  testBaglanti,
  FATURA_TURLERI,
  BASE_URL,
};
