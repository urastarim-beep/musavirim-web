/**
 * Bulut köprüsü — Electron IPC yerine tarayıcıda çalışır.
 * Parent (React) window.__MUSAVIRIM_CLOUD__ set eder.
 */
(function () {
  const cloud = () => window.__MUSAVIRIM_CLOUD__ || {};
  const notify = (msg) => {
    console.warn('[musavirim-cloud]', msg);
    return { ok: false, msg: String(msg) };
  };

  // Electron require stub (HKS)
  if (typeof window.require !== 'function') {
    window.require = function (name) {
      if (name === 'electron') {
        return {
          ipcRenderer: {
            invoke: async (channel, payload) => {
              if (channel === 'select-folder' || channel === 'select-hks-file' || channel === 'select-save') {
                return { canceled: true, msg: 'Bulutta klasör seçimi yakında (dosya yükleme).' };
              }
              return notify('Bu işlem bulut worker ile çalışacak: ' + channel);
            },
            on: () => {},
          },
        };
      }
      throw new Error('Bulutta desteklenmeyen modül: ' + name);
    };
  }

  // Hızlı XML
  window.hizliApp = {
    async loadConfig() {
      const raw = cloud();
      // imported shape: { kullanicilar: { kullanicilar, aktifKullaniciId }, config }
      // or flat kullanicilar store
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
        ortakIndirmeKlasoru: store.ortakIndirmeKlasoru || config.indirmeKlasoru || '',
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
    async downloadXml() {
      return notify('XML indirme worker kuyruğuna alınacak (sonraki adım).');
    },
    onDownloadLog() {},
  };

  // Stok
  window.stokApp = {
    async loadSettings() {
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

  // Tahakkuk
  const tahakkukData = () => {
    const raw = cloud();
    // imported: { mukellefler: { ofis, mukellefler, aktifId }, son_cekim }
    if (raw.mukellefler && (raw.mukellefler.mukellefler || raw.mukellefler.ofis)) {
      return raw.mukellefler;
    }
    return raw;
  };

  const tahakkukApi = {
    async load() {
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
    async bellekKaydet(bellek) {
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
