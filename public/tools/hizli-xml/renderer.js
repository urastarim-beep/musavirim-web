const fieldIds = [
  'portal',
  'kullaniciAdi',
  'sifre',
  'gibKullaniciAdi',
  'gibSifre',
  'apiKey',
  'secretKey',
  'apiUrl',
  'vkn',
  'firmaAdi',
  'hedefVkn',
  'yil',
  'ay',
  'faturaKodu',
  'iptalRedDahil',
  'indirmeKlasoru',
];

const fields = Object.fromEntries(fieldIds.map((id) => [id, document.getElementById(id)]));
const profileSelect = document.getElementById('profilSec');
const profileSelectIndir = document.getElementById('profilSecIndir');
const profileNameInput = document.getElementById('profilAdi');
const profilEkleBtn = document.getElementById('profilEkleBtn');
const profilSilBtn = document.getElementById('profilSilBtn');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const kaydetBtn = document.getElementById('kaydetBtn');
const testBtn = document.getElementById('testBtn');
const indirBtn = document.getElementById('indirBtn');
const topluIndirBtn = document.getElementById('topluIndirBtn');
const klasorSecBtn = document.getElementById('klasorSec');
const tabIndirBtn = document.getElementById('tabIndirBtn');
const tabAyarBtn = document.getElementById('tabAyarBtn');
const tabIndirEl = document.getElementById('tabIndir');
const tabAyarEl = document.getElementById('tabAyar');

const state = {
  users: [],
  activeUserId: null,
  ortakIndirmeKlasoru: '',
  portals: [{ id: 'hizli', ad: 'Hizli Portal' }],
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

function isGelenEarsivKodu(faturaKodu) {
  const kod = String(faturaKodu || '').trim().toLowerCase();
  return kod === 'gelen_arsiv' || kod === 'gelen_earsiv';
}

function makeId() {
  return `user-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function createDefaultConfig() {
  const now = new Date();
  return {
    portal: 'hizli',
    kullaniciAdi: '',
    sifre: '',
    gibKullaniciAdi: '',
    gibSifre: '',
    apiKey: '',
    secretKey: '',
    apiUrl: '',
    vkn: '',
    firmaAdi: 'Firma',
    hedefVkn: '',
    hedefTckn: '',
    yil: now.getFullYear(),
    ay: now.getMonth() + 1,
    faturaKodu: 'gelen',
    iptalRedDahil: false,
    indirmeKlasoru: '',
  };
}

function normalizePortalId(portalValue) {
  const raw = String(portalValue || '').trim().toLowerCase();
  if (!raw) return 'hizli';
  return PORTAL_ALIAS[raw] || raw;
}

function getActiveUser() {
  return state.users.find((u) => u.id === state.activeUserId) || null;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function appendLog(message, type = 'bilgi') {
  const prefix = {
    bilgi: '[BILGI]',
    basari: '[OK]',
    uyari: '[UYARI]',
    hata: '[HATA]',
  }[type] || '[BILGI]';

  logEl.textContent += `${prefix} ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(isBusy) {
  const controls = [
    kaydetBtn,
    testBtn,
    indirBtn,
    topluIndirBtn,
    klasorSecBtn,
    profilEkleBtn,
    profilSilBtn,
    profileSelect,
    profileSelectIndir,
  ];
  for (const control of controls) control.disabled = isBusy;
}

function switchTab(tabName) {
  const indirActive = tabName === 'indir';
  tabIndirBtn.classList.toggle('active', indirActive);
  tabAyarBtn.classList.toggle('active', !indirActive);
  tabIndirEl.classList.toggle('active', indirActive);
  tabAyarEl.classList.toggle('active', !indirActive);
}

function readForm() {
  const selectedPortalRaw = fields.portal?.value
    || fields.portal?.selectedOptions?.[0]?.textContent
    || 'hizli';
  return {
    portal: normalizePortalId(selectedPortalRaw),
    kullaniciAdi: fields.kullaniciAdi.value.trim(),
    sifre: fields.sifre.value,
    gibKullaniciAdi: fields.gibKullaniciAdi.value.trim(),
    gibSifre: fields.gibSifre.value,
    apiKey: fields.apiKey.value.trim(),
    secretKey: fields.secretKey.value.trim(),
    apiUrl: fields.apiUrl.value.trim(),
    vkn: fields.vkn.value.trim(),
    firmaAdi: fields.firmaAdi.value.trim() || 'Firma',
    hedefVkn: fields.hedefVkn.value.trim(),
    hedefTckn: '',
    yil: Number(fields.yil.value),
    ay: Number(fields.ay.value),
    faturaKodu: fields.faturaKodu.value,
    iptalRedDahil: Boolean(fields.iptalRedDahil.checked),
    indirmeKlasoru: state.ortakIndirmeKlasoru || fields.indirmeKlasoru.value.trim(),
  };
}

function hasUnicodeInput(value) {
  return /[^\x00-\x7F]/.test(String(value || ''));
}

function activePortalId() {
  const selectedPortalRaw = fields.portal?.value
    || fields.portal?.selectedOptions?.[0]?.textContent
    || 'hizli';
  return normalizePortalId(selectedPortalRaw);
}

function fillForm(config) {
  const src = { ...createDefaultConfig(), ...(config || {}) };
  if (state.ortakIndirmeKlasoru) src.indirmeKlasoru = state.ortakIndirmeKlasoru;
  for (const id of fieldIds) {
    if (id === 'iptalRedDahil') {
      fields[id].checked = Boolean(src[id]);
    } else {
      fields[id].value = String(src[id] ?? '');
    }
  }
}

function setOrtakKlasor(path) {
  const p = String(path || '').trim();
  state.ortakIndirmeKlasoru = p;
  fields.indirmeKlasoru.value = p;
  state.users = state.users.map((u) => ({
    ...u,
    config: { ...(u.config || {}), indirmeKlasoru: p },
  }));
}

function normalizeUser(raw) {
  const cfg = { ...createDefaultConfig(), ...(raw?.config || {}) };
  const id = String(raw?.id || makeId());
  const ad = String(raw?.ad || cfg.firmaAdi || 'Kullanici').trim();
  return { id, ad: ad || 'Kullanici', config: cfg };
}

function renderPortalOptions() {
  const portalField = fields.portal;
  if (!portalField) return;
  const onceki = portalField.value || 'hizli';
  portalField.innerHTML = '';
  for (const p of state.portals) {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.ad;
    portalField.appendChild(option);
  }
  portalField.value = onceki;
  if (!portalField.value && state.portals.length) {
    portalField.value = state.portals[0].id;
  }
}

function persistActiveFormToState() {
  const user = getActiveUser();
  if (!user) return;
  const oncekiSecret = String(user.config?.secretKey || '').trim();
  const form = readForm();
  // Gelismis alandaki secretKey bos kaydedilirse Hizli girisi kirilmasin
  if (!form.secretKey && oncekiSecret) {
    form.secretKey = oncekiSecret;
  }
  user.config = form;
  user.ad = profileNameInput.value.trim() || user.config.firmaAdi || 'Kullanici';
}

function refreshProfileSelect() {
  profileSelect.innerHTML = '';
  profileSelectIndir.innerHTML = '';
  for (const user of state.users) {
    const optionAyar = document.createElement('option');
    optionAyar.value = user.id;
    optionAyar.textContent = user.ad;
    profileSelect.appendChild(optionAyar);

    const optionIndir = document.createElement('option');
    optionIndir.value = user.id;
    optionIndir.textContent = user.ad;
    profileSelectIndir.appendChild(optionIndir);
  }
  if (state.activeUserId) {
    profileSelect.value = state.activeUserId;
    profileSelectIndir.value = state.activeUserId;
  }
  profilSilBtn.disabled = state.users.length <= 1;
}

function loadActiveUserToForm() {
  const user = getActiveUser();
  if (!user) return;
  renderPortalOptions();
  fillForm(user.config);
  profileNameInput.value = user.ad;
  refreshProfileSelect();
}

function switchProfile(nextId) {
  persistActiveFormToState();
  state.activeUserId = nextId;
  loadActiveUserToForm();
}

async function saveCurrentConfig(logSuccess = true) {
  persistActiveFormToState();
  const activeUser = getActiveUser();
  if (!activeUser) {
    appendLog('Kayitli profil bulunamadi.', 'hata');
    return false;
  }

  const payload = {
    activeUserId: state.activeUserId,
    config: activeUser.config,
    users: state.users,
    ortakIndirmeKlasoru: state.ortakIndirmeKlasoru || fields.indirmeKlasoru.value.trim(),
  };
  const response = await window.hizliApp.saveConfig(payload);
  if (!response.ok) {
    appendLog(response.message || 'Ayar kaydetme basarisiz.', 'hata');
    return false;
  }
  if (response.ortakIndirmeKlasoru) setOrtakKlasor(response.ortakIndirmeKlasoru);
  if (logSuccess) appendLog(response.message, 'basari');
  refreshProfileSelect();
  return true;
}

window.hizliApp.onDownloadLog((entry) => {
  const mesaj = entry?.mesaj || '';
  appendLog(mesaj, entry?.tip || 'bilgi');
  if (/indiriliyor:\s*\d+\/\d+/i.test(mesaj) || /\d+ XML indirilecek/i.test(mesaj)) {
    setStatus(mesaj);
  }
});

tabIndirBtn.addEventListener('click', () => switchTab('indir'));
tabAyarBtn.addEventListener('click', () => switchTab('ayar'));

profileSelect.addEventListener('change', () => {
  switchProfile(profileSelect.value);
});

profileSelectIndir.addEventListener('change', () => {
  switchProfile(profileSelectIndir.value);
});

profileNameInput.addEventListener('input', () => {
  const user = getActiveUser();
  if (!user) return;
  user.ad = profileNameInput.value.trim() || user.config.firmaAdi || 'Kullanici';
  refreshProfileSelect();
});

profilEkleBtn.addEventListener('click', () => {
  persistActiveFormToState();
  const yeni = normalizeUser({
    id: makeId(),
    ad: `Kullanici ${state.users.length + 1}`,
    config: createDefaultConfig(),
  });
  state.users.push(yeni);
  state.activeUserId = yeni.id;
  loadActiveUserToForm();
  appendLog('Yeni profil eklendi.', 'bilgi');
});

profilSilBtn.addEventListener('click', () => {
  if (state.users.length <= 1) {
    appendLog('Son profil silinemez.', 'uyari');
    return;
  }
  const user = getActiveUser();
  if (!user) return;
  const ok = window.confirm(`"${user.ad}" profilini silmek istiyor musunuz?`);
  if (!ok) return;

  state.users = state.users.filter((u) => u.id !== user.id);
  state.activeUserId = state.users[0].id;
  loadActiveUserToForm();
  appendLog('Profil silindi.', 'uyari');
});

kaydetBtn.addEventListener('click', async () => {
  setBusy(true);
  setStatus('Ayarlar kaydediliyor...');
  try {
    const ok = await saveCurrentConfig(true);
    setStatus(ok ? 'Ayarlar kaydedildi.' : 'Ayar kaydetme hatasi.');
  } finally {
    setBusy(false);
  }
});

klasorSecBtn.addEventListener('click', async () => {
  const result = await window.hizliApp.selectFolder();
  const selected = typeof result === 'string' ? result : (result?.ok ? result.path : '');
  if (selected) {
    setOrtakKlasor(selected);
    appendLog(`Ortak indirme klasoru ayarlandi: ${selected}`, 'basari');
  }
});

testBtn.addEventListener('click', async () => {
  setBusy(true);
  logEl.textContent = '';
  setStatus('Baglanti test ediliyor...');

  try {
    persistActiveFormToState();
    const form = readForm();
    if (activePortalId() === 'hizli' && (hasUnicodeInput(form.kullaniciAdi) || hasUnicodeInput(form.sifre))) {
      appendLog('UYARI: Kullanici adi/sifre alaninda Turkce karakter varsa API reddedebilir.', 'uyari');
    }
    if (activePortalId() === 'uyumsoft') {
      appendLog('UYARI: Uyumsoft icin portal kullanicisi degil, Web Servis kullanicisi kullanin (ornek: ..._WebServis1).', 'uyari');
    }

    if (activePortalId() === 'gib') {
      if (!form.gibKullaniciAdi && !form.kullaniciAdi) {
        appendLog('GIB kullanici kodu gerekli (asagidaki GIB alanlari).', 'hata');
        setStatus('Eksik bilgi');
        return;
      }
      if (!form.gibSifre && !form.sifre) {
        appendLog('GIB sifre gerekli (asagidaki GIB alanlari).', 'hata');
        setStatus('Eksik bilgi');
        return;
      }
    }

    await saveCurrentConfig(false);
    const response = await window.hizliApp.testConnection(form);
    if (response.ok) {
      appendLog(response.message, 'basari');
      setStatus('Baglanti basarili.');
    } else {
      appendLog(response.message, 'hata');
      setStatus('Baglanti basarisiz.');
    }
  } finally {
    setBusy(false);
  }
});

indirBtn.addEventListener('click', async () => {
  setBusy(true);
  logEl.textContent = '';
  setStatus('Indirme baslatiliyor...');

  try {
    persistActiveFormToState();
    const form = readForm();
    const gelenEarsiv = isGelenEarsivKodu(form.faturaKodu);
    const gibUser = form.gibKullaniciAdi || (form.portal === 'gib' ? form.kullaniciAdi : '');
    const gibPass = form.gibSifre || (form.portal === 'gib' ? form.sifre : '');

    if (gelenEarsiv || form.portal === 'gib') {
      if (!gibUser || !gibPass) {
        appendLog('Gelen e-Arsiv icin Ayarlar > GIB Kullanici Kodu ve GIB Sifre girin.', 'hata');
        setStatus('Eksik bilgi');
        switchTab('ayar');
        return;
      }
    } else if (!form.kullaniciAdi || !form.sifre) {
      appendLog('WS kullanici adi ve sifre zorunludur.', 'hata');
      setStatus('Eksik bilgi');
      return;
    }
    if (!form.indirmeKlasoru) {
      appendLog('Ortak indirme klasoru secmelisiniz (Ayarlar).', 'hata');
      setStatus('Eksik bilgi');
      return;
    }
    if (activePortalId() === 'hizli' && (hasUnicodeInput(form.kullaniciAdi) || hasUnicodeInput(form.sifre))) {
      appendLog('UYARI: Kullanici adi/sifre alaninda Turkce karakter varsa API reddedebilir.', 'uyari');
    }

    await saveCurrentConfig(false);
    const response = await window.hizliApp.downloadXml(form);
    if (!response.ok) {
      appendLog(response.message || 'Indirme hatasi.', 'hata');
      setStatus('Indirme basarisiz.');
      return;
    }

    appendLog(`Tamamlandi. Toplam ${response.xmlSayisi} XML (${response.yeni} yeni).`, 'basari');
    if (response.klasor) appendLog(`Klasor: ${response.klasor}`, 'bilgi');
    setStatus('Indirme tamamlandi.');
  } finally {
    setBusy(false);
  }
});

topluIndirBtn.addEventListener('click', async () => {
  setBusy(true);
  logEl.textContent = '';
  setStatus('Toplu indirme baslatiliyor...');

  try {
    persistActiveFormToState();
    const ortak = state.ortakIndirmeKlasoru || fields.indirmeKlasoru.value.trim();
    if (!ortak) {
      appendLog('Ortak indirme klasoru secmelisiniz (Ayarlar).', 'hata');
      setStatus('Eksik bilgi');
      return;
    }
    const kayitOk = await saveCurrentConfig(false);
    if (!kayitOk) {
      setStatus('Kaydetme hatasi');
      return;
    }

    const toplam = state.users.length;
    let basarili = 0;
    let basarisiz = 0;
    let toplamYeni = 0;
    const basarisizList = [];
    const TOPLU_PARALEL = 2;

    appendLog(`Toplu indirme basladi. Profil sayisi: ${toplam} (${TOPLU_PARALEL} paralel)`, 'bilgi');

    async function profilIndir(user, sira) {
      const form = { ...createDefaultConfig(), ...(user.config || {}) };
      form.indirmeKlasoru = state.ortakIndirmeKlasoru || form.indirmeKlasoru;
      setStatus(`${sira}/${toplam} indiriliyor: ${user.ad}`);
      appendLog(`--- ${user.ad} ---`, 'bilgi');

      const gelenEarsiv = isGelenEarsivKodu(form.faturaKodu);
      const portal = String(form.portal || '').toLowerCase();
      const gibUser = form.gibKullaniciAdi || (portal === 'gib' ? form.kullaniciAdi : '');
      const gibPass = form.gibSifre || (portal === 'gib' ? form.sifre : '');
      if (gelenEarsiv || portal === 'gib') {
        if (!gibUser || !gibPass) {
          const neden = 'GIB kullanici kodu / sifre eksik';
          appendLog(`BASARISIZ: ${user.ad} — ${neden}, profil atlandi.`, 'hata');
          return { ok: false, yeni: 0, ad: user.ad, neden };
        }
      } else if (!form.kullaniciAdi || !form.sifre) {
        const neden = 'WS kullanici adi veya sifre eksik';
        appendLog(`BASARISIZ: ${user.ad} — ${neden}, profil atlandi.`, 'hata');
        return { ok: false, yeni: 0, ad: user.ad, neden };
      }
      if (!form.indirmeKlasoru) {
        const neden = 'Ortak indirme klasoru secilmemis';
        appendLog(`BASARISIZ: ${user.ad} — ${neden}, profil atlandi.`, 'hata');
        return { ok: false, yeni: 0, ad: user.ad, neden };
      }
      if (portal === 'hizli' && (hasUnicodeInput(form.kullaniciAdi) || hasUnicodeInput(form.sifre))) {
        appendLog('UYARI: Kullanici adi/sifrede Turkce karakter API hatasina yol acabilir.', 'uyari');
      }

      const response = await window.hizliApp.downloadXml(form);
      if (!response.ok) {
        const neden = response.message || 'Indirme hatasi';
        appendLog(`BASARISIZ: ${user.ad} — ${neden}`, 'hata');
        return { ok: false, yeni: 0, ad: user.ad, neden };
      }

      appendLog(`Tamamlandi. Toplam ${response.xmlSayisi} XML (${response.yeni} yeni).`, 'basari');
      if (response.klasor) appendLog(`Klasor: ${response.klasor}`, 'bilgi');
      return { ok: true, yeni: Number(response.yeni || 0), ad: user.ad };
    }

    for (let i = 0; i < toplam; i += TOPLU_PARALEL) {
      const grup = state.users.slice(i, i + TOPLU_PARALEL);
      const sonuclar = await Promise.all(grup.map((user, offset) => profilIndir(user, i + offset + 1)));
      for (const s of sonuclar) {
        if (s.ok) {
          basarili += 1;
          toplamYeni += s.yeni;
        } else {
          basarisiz += 1;
          basarisizList.push(`${s.ad}${s.neden ? ` (${s.neden})` : ''}`);
        }
      }
    }

    setStatus(`Toplu indirme bitti. Basarili: ${basarili}, Basarisiz: ${basarisiz}`);
    appendLog(`Toplu indirme tamamlandi. ${toplamYeni} yeni XML indirildi.`, 'basari');
    if (basarisizList.length) {
      appendLog(`Basarisiz profiller (${basarisizList.length}): ${basarisizList.join(' · ')}`, 'hata');
    }
  } finally {
    setBusy(false);
  }
});

async function init() {
  switchTab('indir');
  const response = await window.hizliApp.loadConfig();
  if (response.ok) {
    if (Array.isArray(response.portals) && response.portals.length) {
      state.portals = response.portals;
    }
    state.ortakIndirmeKlasoru = String(response.ortakIndirmeKlasoru || '').trim();
    const loadedUsers = Array.isArray(response.users) ? response.users.map(normalizeUser) : [];
    state.users = loadedUsers.length ? loadedUsers : [normalizeUser({ config: response.config || {} })];
    if (state.ortakIndirmeKlasoru) {
      state.users = state.users.map((u) => ({
        ...u,
        config: { ...(u.config || {}), indirmeKlasoru: state.ortakIndirmeKlasoru },
      }));
    }
    state.activeUserId = response.activeUserId || state.users[0].id;
    if (!state.users.find((u) => u.id === state.activeUserId)) {
      state.activeUserId = state.users[0].id;
    }
    loadActiveUserToForm();
    appendLog('Profil ve ayarlar yuklendi.', 'bilgi');
  } else {
    if (Array.isArray(response.portals) && response.portals.length) {
      state.portals = response.portals;
    }
    state.users = [normalizeUser({ config: createDefaultConfig() })];
    state.activeUserId = state.users[0].id;
    loadActiveUserToForm();
    appendLog(response.message || 'Ayarlar okunamadi.', 'uyari');
  }
}

init().catch((error) => {
  appendLog(error.message || String(error), 'hata');
  setStatus('Baslatma hatasi');
});
