/**
 * Bulut köprüsü — Electron IPC yerine tarayıcıda çalışır.
 * Parent ToolEmbed iframe'e musavirim-cloud-data gönderir.
 */
(function () {
  function applyCloud(payload) {
    window.__MUSAVIRIM_CLOUD__ = payload && typeof payload === 'object' ? payload : {};
    try {
      sessionStorage.setItem('__MUSAVIRIM_CLOUD__', JSON.stringify(window.__MUSAVIRIM_CLOUD__));
    } catch {
      /* ignore */
    }
  }

  try {
    applyCloud(JSON.parse(sessionStorage.getItem('__MUSAVIRIM_CLOUD__') || '{}'));
  } catch {
    applyCloud({});
  }

  let cloudReadyResolve;
  const cloudReady = new Promise((resolve) => {
    cloudReadyResolve = resolve;
  });
  setTimeout(() => cloudReadyResolve(window.__MUSAVIRIM_CLOUD__ || {}), 2500);

  window.addEventListener('message', (ev) => {
    if (!ev.data) return;
    if (ev.data.type === 'musavirim-cloud-data') {
      applyCloud(ev.data.payload);
      cloudReadyResolve(window.__MUSAVIRIM_CLOUD__);
      window.dispatchEvent(new Event('musavirim-cloud-ready'));
    }
  });

  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'musavirim-cloud-request' }, '*');
  }

  const cloud = () => window.__MUSAVIRIM_CLOUD__ || {};
  const waitCloud = () => cloudReady;
  const notify = (msg) => {
    console.warn('[musavirim-cloud]', msg);
    return { ok: false, msg: String(msg) };
  };

  if (typeof window.require !== 'function') {
    let hksCookie = '';
    try {
      hksCookie = sessionStorage.getItem('__HKS_COOKIE__') || '';
    } catch {
      /* ignore */
    }

    async function hksCaptcha() {
      const res = await fetch('/api/hks-captcha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: hksCookie }),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.cookie) {
        hksCookie = data.cookie;
        try {
          sessionStorage.setItem('__HKS_COOKIE__', hksCookie);
        } catch {
          /* ignore */
        }
      }
      if (!res.ok || !data.success) {
        return {
          success: false,
          message: (data && data.message) || 'Captcha yüklenemedi',
        };
      }
      return { success: true, captcha: data.captcha };
    }

    window.require = function (name) {
      if (name === 'electron') {
        return {
          ipcRenderer: {
            invoke: async (channel, payload) => {
              if (channel === 'init-login' || channel === 'refresh-captcha') {
                // Yenilemede yeni oturum için cookie temizle
                if (channel === 'refresh-captcha') {
                  hksCookie = '';
                  try {
                    sessionStorage.removeItem('__HKS_COOKIE__');
                  } catch {
                    /* ignore */
                  }
                }
                return hksCaptcha();
              }
              if (channel === 'select-folder' || channel === 'select-hks-file' || channel === 'select-save') {
                return { canceled: true, msg: 'Bulutta klasör seçimi yakında (dosya yükleme).' };
              }
              if (channel === 'do-login') {
                return {
                  success: false,
                  message:
                    'HKS girişi bulutta henüz tamamlanmadı (captcha geldi). Tam giriş için kısa süre sonra worker eklenecek.',
                };
              }
              return notify('Bu işlem bulut worker ile çalışacak: ' + channel);
            },
            on: () => {},
            send: () => {},
          },
        };
      }
      throw new Error('Bulutta desteklenmeyen modül: ' + name);
    };
  }

  window.hizliApp = {
    async loadConfig() {
      await waitCloud();
      const raw = cloud();
      const store = raw.kullanicilar || raw;
      const users = Array.isArray(store.kullanicilar)
        ? store.kullanicilar
        : Array.isArray(store.users)
          ? store.users
          : [];
      const activeUserId = store.aktifKullaniciId || store.activeUserId || users[0]?.id || null;
      const config = raw.config || {};
      return {
        ok: true,
        users,
        activeUserId,
        config,
        ortakIndirmeKlasoru:
          store.ortakIndirmeKlasoru || config.indirmeKlasoru || 'Indirilenler (otomatik)',
      };
    },
    async saveConfig(payload) {
      window.parent.postMessage(
        {
          type: 'musavirim-save',
          arac: 'hizli_xml',
          payload: {
            kullanicilar: {
              kullanicilar: payload.users || [],
              aktifKullaniciId: payload.activeUserId || null,
              ortakIndirmeKlasoru: payload.ortakIndirmeKlasoru || '',
            },
            config: payload.config || {},
          },
        },
        '*',
      );
      return { ok: true };
    },
    async selectFolder() {
      return { canceled: true };
    },
    async testConnection() {
      return notify('Bağlantı testi worker ile eklenecek.');
    },
    async downloadXml(form) {
      try {
        const suggestBase = String(form?.firmaAdi || form?.vkn || 'xml')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[ğüşıöçĞÜŞİÖÇ]/g, (c) =>
            ({ ğ: 'g', ü: 'u', ş: 's', ı: 'i', ö: 'o', ç: 'c', Ğ: 'G', Ü: 'U', Ş: 'S', İ: 'I', Ö: 'O', Ç: 'C' })[c],
          )
          .replace(/[^\w.\-]+/g, '_')
          .slice(0, 40) || 'xml';
        const suggestedName = `${suggestBase}_${form?.yil || ''}-${String(form?.ay || '').padStart(2, '0')}.zip`;

        // Tıklama anında dosya gezgini (Chrome / Edge)
        let fileHandle = null;
        if (typeof window.showSaveFilePicker === 'function') {
          try {
            fileHandle = await window.showSaveFilePicker({
              suggestedName,
              types: [
                {
                  description: 'ZIP arşivi',
                  accept: { 'application/zip': ['.zip'] },
                },
              ],
            });
          } catch (pickErr) {
            if (pickErr && pickErr.name === 'AbortError') {
              return { ok: false, message: 'Kaydetme iptal edildi.' };
            }
          }
        }

        const res = await fetch('/api/hizli-xml-indir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form || {}),
        });
        const ctype = res.headers.get('content-type') || '';
        if (!res.ok) {
          let message = 'Indirme hatasi.';
          if (ctype.includes('application/json')) {
            const j = await res.json();
            message = j.message || message;
          } else {
            message = (await res.text()) || message;
          }
          return { ok: false, message };
        }

        const blob = await res.blob();
        const filename = res.headers.get('X-Filename') || suggestedName;
        const xmlSayisi = Number(res.headers.get('X-Xml-Count') || 0);
        const yeni = Number(res.headers.get('X-Xml-Yeni') || 0);

        if (fileHandle) {
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          return {
            ok: true,
            xmlSayisi,
            yeni,
            message: 'ZIP secilen konuma kaydedildi.',
          };
        }

        // Fallback: klasik Indirilenler
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return {
          ok: true,
          xmlSayisi,
          yeni,
          message: 'ZIP Indirilenler klasorune kaydedildi.',
        };
      } catch (err) {
        return { ok: false, message: err.message || String(err) };
      }
    },
    onDownloadLog() {},
  };

  window.stokApp = {
    async loadSettings() {
      await waitCloud();
      return { ok: true, settings: (cloud().stok_kontrol || cloud()).settings || cloud().settings || {} };
    },
    async saveSettings(s) {
      window.parent.postMessage({ type: 'musavirim-save', arac: 'stok_kontrol', payload: { settings: s } }, '*');
      return { ok: true };
    },
    async defaultExclude() {
      return { ok: true, text: '' };
    },
    async selectFolder() {
      return { canceled: true };
    },
    async selectSave() {
      return { canceled: true };
    },
    async isle() {
      return notify('Stok işleme bulutta dosya yükleme ile eklenecek.');
    },
    async openPath() {
      return { ok: true };
    },
    async showInFolder() {
      return { ok: true };
    },
  };

  const tahakkukData = () => {
    const raw = cloud();
    if (raw.mukellefler && (raw.mukellefler.mukellefler || raw.mukellefler.ofis)) {
      return raw.mukellefler;
    }
    return raw;
  };

  const tahakkukApi = {
    async load() {
      await waitCloud();
      const d = tahakkukData();
      return {
        ok: true,
        ofis: d.ofis || {},
        mukellefler: d.mukellefler || [],
        aktifId: d.aktifId || null,
        fisKlasor: d.ofis?.fisKlasor || '',
        bellek: d.bellek || null,
        sgkUrl: d.sgkUrl || {},
        ivdUrl: d.ivdUrl || 'https://ivd.gib.gov.tr',
        ebynUrl: d.ebynUrl || 'https://ebeyanname.gib.gov.tr',
      };
    },
    async save(payload) {
      window.parent.postMessage(
        {
          type: 'musavirim-save',
          arac: 'tahakkuk',
          payload: {
            mukellefler: payload,
            son_cekim: cloud().son_cekim || null,
          },
        },
        '*',
      );
      return { ok: true };
    },
    async bellekKaydet() {
      return { ok: true };
    },
    onWaState() {},
  };

  window.tahakkukApp = new Proxy(tahakkukApi, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => notify('Tahakkuk işlemi worker ile eklenecek: ' + String(prop));
    },
  });
})();
