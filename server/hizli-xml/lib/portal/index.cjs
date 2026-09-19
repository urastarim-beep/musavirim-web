const hizliApi = require('../hizliApi.cjs');
const edmApi = require('./edmApi.cjs');
const iceApi = require('./iceApi.cjs');
const uyumsoftApi = require('./uyumsoftApi.cjs');
const gibEarsivApi = require('./gibEarsivApi.cjs');

const PORTALLAR = {
  hizli: {
    id: 'hizli',
    ad: 'Hizli Portal',
    indirFatura: hizliApi.indirFatura,
    testBaglanti: hizliApi.testBaglanti,
    faturaTurleri: hizliApi.FATURA_TURLERI,
  },
  edm: {
    id: 'edm',
    ad: 'EDM Bilisim',
    indirFatura: edmApi.indirFatura,
    testBaglanti: edmApi.testBaglanti,
    faturaTurleri: edmApi.FATURA_TURLERI,
  },
  ice: {
    id: 'ice',
    ad: 'ICE Portal',
    indirFatura: iceApi.indirFatura,
    testBaglanti: iceApi.testBaglanti,
    faturaTurleri: iceApi.FATURA_TURLERI,
  },
  uyumsoft: {
    id: 'uyumsoft',
    ad: 'Uyumsoft',
    indirFatura: uyumsoftApi.indirFatura,
    testBaglanti: uyumsoftApi.testBaglanti,
    faturaTurleri: uyumsoftApi.FATURA_TURLERI,
  },
  gib: {
    id: 'gib',
    ad: 'GIB e-Arsiv Portal',
    indirFatura: gibEarsivApi.indirFatura,
    testBaglanti: gibEarsivApi.testBaglanti,
    faturaTurleri: gibEarsivApi.FATURA_TURLERI,
  },
};

const PORTAL_ALIAS = {
  hizli: 'hizli',
  'hizli portal': 'hizli',
  edm: 'edm',
  'edm bilisim': 'edm',
  'edm bilişim': 'edm',
  ice: 'ice',
  'ice portal': 'ice',
  uyumsoft: 'uyumsoft',
  uyum: 'uyumsoft',
  'uyumsoft portal': 'uyumsoft',
  gib: 'gib',
  'gib-earsiv': 'gib',
  'gib earsiv': 'gib',
  'gib e-arsiv': 'gib',
  'gib e-arsiv portal': 'gib',
  earsivportal: 'gib',
};

function normalizePortalId(portalId) {
  const raw = String(portalId || 'hizli').trim().toLowerCase();
  return PORTAL_ALIAS[raw] || raw;
}

function portalGetir(portalId) {
  const id = normalizePortalId(portalId);
  return PORTALLAR[id] || PORTALLAR.hizli;
}

function portalListesi() {
  return Object.values(PORTALLAR).map((p) => ({ id: p.id, ad: p.ad }));
}

function isGelenEarsivKodu(faturaKodu) {
  const kod = String(faturaKodu || '').trim().toLowerCase();
  return kod === 'gelen_arsiv' || kod === 'gelen_earsiv';
}

/**
 * Gelen e-Arsiv indirmede GIB portalina yonlendirir.
 * opts.forceGelenEarsiv=false iken sadece portal=gib ise GIB kimligi kullanilir (baglanti testi).
 */
function resolveIndirmeParams(params, opts = {}) {
  const forceGelenEarsiv = opts.forceGelenEarsiv !== false;
  const src = params || {};
  const portal = normalizePortalId(src.portal || 'hizli');
  const faturaKodu = String(src.faturaKodu || 'gelen').trim().toLowerCase();
  const gibKullaniciAdi = String(src.gibKullaniciAdi || '').trim();
  const gibSifre = String(src.gibSifre || '');
  const useGib = portal === 'gib' || (forceGelenEarsiv && isGelenEarsivKodu(faturaKodu));

  if (!useGib) return { ...src, portal, faturaKodu };

  return {
    ...src,
    portal: 'gib',
    faturaKodu: isGelenEarsivKodu(faturaKodu) ? 'gelen_arsiv' : faturaKodu,
    kullaniciAdi: gibKullaniciAdi || String(src.kullaniciAdi || '').trim(),
    sifre: gibSifre || String(src.sifre || ''),
    gibKullaniciAdi,
    gibSifre,
  };
}

module.exports = {
  portalGetir,
  portalListesi,
  normalizePortalId,
  isGelenEarsivKodu,
  resolveIndirmeParams,
};
