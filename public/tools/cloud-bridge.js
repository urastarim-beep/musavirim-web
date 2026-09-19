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
    window.require = function (name) {
      if (name === 'electron') {
        return {
          ipcRenderer: {
            invoke: async (channel) => {
              if (channel === 'select-folder' || channel === 'select-hks-file' || channel === 'select-save') {
                return { canceled: true, msg: 'Bulutta klasör seçimi yakında (dosya yükleme).' };
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
        if (window.parent && window.parent !== window) {
          return await new Promise((resolve) => {
            const reqId = 'xml-' + Date.now() + '-' + Math.random().toString(36).slice(2);
            function onMsg(ev) {
              if (!ev.data || ev.data.type !== 'musavirim-download-result') return;
              if (ev.data.reqId !== reqId) return;
              window.removeEventListener('message', onMsg);
              resolve(ev.data.result || { ok: false, message: 'Indirme hatasi.' });
            }
            window.addEventListener('message', onMsg);
            window.parent.postMessage(
              { type: 'musavirim-download-xml', reqId, form: form || {} },
              '*',
            );
            setTimeout(() => {
              window.removeEventListener('message', onMsg);
              resolve({ ok: false, message: 'Indirme zaman asimina ugradi (60 sn).' });
            }, 60_000);
          });
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
        if (!ctype.includes('zip') && !ctype.includes('octet-stream')) {
          const j = await res.json().catch(() => null);
          return { ok: false, message: (j && j.message) || 'Beklenmeyen yanit' };
        }
        const blob = await res.blob();
        const disp = res.headers.get('Content-Disposition') || '';
        const m = disp.match(/filename=\"?([^\";]+)\"?/i);
        const filename = (m && m[1]) || 'xml-indir.zip';
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
          xmlSayisi: Number(res.headers.get('X-Xml-Count') || 0),
          yeni: Number(res.headers.get('X-Xml-Yeni') || 0),
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
