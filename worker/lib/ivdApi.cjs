'use strict';

/**
 * İnteraktif / Dijital Vergi Dairesi — borç / tahakkuk özeti
 * Host: ivd.gib.gov.tr
 */

const https = require('https');
const { URLSearchParams } = require('url');
const crypto = require('crypto');

const HOST = 'ivd.gib.gov.tr';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function postForm(pathSuffix, fields) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: HOST,
        path: pathSuffix,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': UA,
          Referer: `https://${HOST}/main.jsp`,
          Origin: `https://${HOST}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text || 'null');
          } catch {
            reject(new Error(`IVD yanit JSON degil: ${text.slice(0, 160)}`));
            return;
          }
          resolve(json);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('IVD zaman asimi')));
    req.write(body);
    req.end();
  });
}

function assertOk(json, ctx) {
  if (!json || typeof json !== 'object') {
    throw new Error(`${ctx}: bos yanit`);
  }
  if (json.error && String(json.error) !== '0') {
    const msg = Array.isArray(json.messages)
      ? json.messages.map((m) => m?.text || m).join('; ')
      : json.messages || json.error;
    throw new Error(`${ctx}: ${msg}`);
  }
  return json;
}

async function login(userid, sifre) {
  const json = assertOk(
    await postForm('/tvd_server/assos-login', {
      assoscmd: 'multilogin',
      rtype: 'json',
      userid: String(userid || '').trim(),
      sifre: String(sifre || ''),
      parola: 'maliye',
      controlCaptcha: 'false',
      dk: '',
      imageID: '',
    }),
    'IVD giris',
  );
  if (!json.token) throw new Error('IVD token alinamadi');
  return { token: json.token, chgpwd: json.chgpwd === 'true' || json.chgpwd === true };
}

async function logout(token) {
  if (!token) return;
  try {
    await postForm('/tvd_server/dispatch', {
      cmd: 'kullaniciBilgileriService_logout',
      callid: crypto.randomUUID(),
      pageName: 'PG_MAIN_DYNAMIC',
      token,
      jp: '{}',
    });
  } catch {
    /* ignore */
  }
}

async function dispatch(token, cmd, pageName, jp, callid) {
  return assertOk(
    await postForm('/tvd_server/dispatch', {
      cmd,
      callid: callid || crypto.randomUUID(),
      pageName,
      token,
      jp: JSON.stringify(jp ?? {}),
    }),
    cmd,
  );
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

function normalizeKalem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ad =
    raw.vergiAdi ||
    raw.vergiadi ||
    raw.aciklama ||
    raw.borcTuru ||
    raw.tur ||
    raw.adi ||
    raw.hazineAdi ||
    'Borc';
  const tutar =
    toNumber(raw.tutar) ||
    toNumber(raw.borcTutari) ||
    toNumber(raw.kalan) ||
    toNumber(raw.odenecek) ||
    toNumber(raw.bakiye) ||
    toNumber(raw.genelToplam) ||
    toNumber(raw.toplam);
  const donem = String(raw.donem || raw.vergiDonemi || raw.period || raw.vade || '').trim();
  return {
    kaynak: 'ivd',
    kod: String(raw.vergiKodu || raw.kod || '').trim(),
    ad: String(ad).trim(),
    donem,
    tutar,
    raw,
  };
}

function flattenData(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.borclar)) return data.borclar;
  if (Array.isArray(data.liste)) return data.liste;
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.borcListesi)) return data.borcListesi;
  if (Array.isArray(data.vdBorcListesi)) return data.vdBorcListesi;
  if (Array.isArray(data.borcDetayListesi)) return data.borcDetayListesi;
  if (data.borc && Array.isArray(data.borc)) return data.borc;
  // nested objects with arrays of objects
  const out = [];
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') out.push(...v);
    else if (v && typeof v === 'object') {
      for (const vv of Object.values(v)) {
        if (Array.isArray(vv) && vv.length && typeof vv[0] === 'object') out.push(...vv);
      }
    }
  }
  return out;
}

const CHGPWD_MSG =
  'IVD giris oldu ama GIB sifre degisikligi istiyor (chgpwd). '
  + 'Once https://ivd.gib.gov.tr adresinden sifreyi degistir; sonra burada yeni sifreyi kaydet.';

async function getBorcDurumu(userid, sifre) {
  let token = null;
  try {
    const oturum = await login(userid, sifre);
    token = oturum.token;
    if (oturum.chgpwd) {
      throw new Error(CHGPWD_MSG);
    }
    const json = await dispatch(
      token,
      'tvdBorcIslemleri_borcGetirYeni',
      'P_DASHBOARD',
      {},
      'e95931c2f24ce-145',
    );
    const rows = flattenData(json.data)
      .map(normalizeKalem)
      .filter((k) => k && (k.tutar > 0 || k.ad));
    return {
      ok: true,
      chgpwd: false,
      kalemler: rows,
      ham: json.data,
    };
  } finally {
    await logout(token);
  }
}

async function testBaglanti(userid, sifre) {
  let token = null;
  try {
    const oturum = await login(userid, sifre);
    token = oturum.token;
    if (oturum.chgpwd) {
      return {
        ok: false,
        chgpwd: true,
        msg: CHGPWD_MSG,
      };
    }
    // Giris OK ise borcu da dene; basarisiz olsa bile baglanti dogru demektir.
    try {
      const json = await dispatch(
        token,
        'tvdBorcIslemleri_borcGetirYeni',
        'P_DASHBOARD',
        {},
        'e95931c2f24ce-145',
      );
      const rows = flattenData(json.data)
        .map(normalizeKalem)
        .filter((k) => k && (k.tutar > 0 || k.ad));
      return {
        ok: true,
        chgpwd: false,
        msg: `IVD giris basarili. ${rows.length} borc/tahakkuk kalemi.`,
        kalemSayisi: rows.length,
      };
    } catch (err) {
      return {
        ok: true,
        chgpwd: false,
        msg:
          `IVD giris basarili; borc cekimi su an hata verdi: ${err.message}. `
          + 'Manuel vergi satirlarini kullanabilirsin.',
        kalemSayisi: 0,
      };
    }
  } catch (err) {
    return { ok: false, msg: err.message || String(err) };
  } finally {
    await logout(token);
  }
}

module.exports = {
  login,
  logout,
  getBorcDurumu,
  testBaglanti,
  portalUrl: `https://${HOST}`,
  CHGPWD_MSG,
};
