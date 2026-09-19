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

  function parentRpc(type, extra = {}, timeoutMs = 120000) {
    return new Promise((resolve) => {
      if (!window.parent || window.parent === window) {
        resolve({ ok: false, msg: 'Parent yok' });
        return;
      }
      const reqId = 'rpc-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      function onMsg(ev) {
        if (!ev.data || ev.data.type !== 'musavirim-job-result') return;
        if (ev.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        resolve(ev.data.result || { ok: false });
      }
      window.addEventListener('message', onMsg);
      window.parent.postMessage({ type, reqId, ...extra }, '*');
      setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, msg: 'Zaman asimina ugradi' });
      }, timeoutMs);
    });
  }

  async function createJob(tip, payload) {
    return parentRpc('musavirim-create-job', { tip, payload });
  }

  async function waitJob(jobId, timeoutMs = 180000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await parentRpc('musavirim-get-job', { jobId }, 15000);
      if (!r.ok) return r;
      const d = r.job?.durum;
      if (d === 'tamam') return { ok: true, job: r.job, ...(r.job.sonuc || {}) };
      if (d === 'hata' || d === 'iptal') {
        return { ok: false, msg: r.job?.hata_mesaji || 'Is hata ile bitti', job: r.job };
      }
      await new Promise((x) => setTimeout(x, 2000));
    }
    return { ok: false, msg: 'Is hala calisiyor / worker ayakta mi?' };
  }

  if (typeof window.require !== 'function') {
    let hksCookie = '';
    let hksForm = null;
    try {
      hksCookie = sessionStorage.getItem('__HKS_COOKIE__') || '';
      hksForm = JSON.parse(sessionStorage.getItem('__HKS_FORM__') || 'null');
    } catch {
      /* ignore */
    }

    function persistHksSession(cookie, form) {
      if (cookie) {
        hksCookie = cookie;
        try {
          sessionStorage.setItem('__HKS_COOKIE__', cookie);
        } catch {
          /* ignore */
        }
      }
      if (form) {
        hksForm = form;
        try {
          sessionStorage.setItem('__HKS_FORM__', JSON.stringify(form));
        } catch {
          /* ignore */
        }
      }
    }

    async function hksCaptcha() {
      const res = await fetch('/api/hks-captcha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.cookie) persistHksSession(data.cookie, data.form || null);
      if (!res.ok || !data.success) {
        return {
          success: false,
          message: (data && data.message) || 'Captcha yüklenemedi',
        };
      }
      return { success: true, captcha: data.captcha };
    }

    async function hksLogin(payload) {
      const res = await fetch('/api/hks-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: payload?.username,
          password: payload?.password,
          captcha: payload?.captcha,
          cookie: hksCookie,
          form: hksForm,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.cookie) persistHksSession(data.cookie, hksForm);
      if (data && data.success) {
        try {
          sessionStorage.setItem('__HKS_LOGGED_IN__', '1');
        } catch {
          /* ignore */
        }
      }
      return {
        success: !!data.success,
        loggedIn: !!data.success,
        message: data.message || (data.success ? 'Giris basarili.' : 'Giris basarisiz.'),
        displayName: data.displayName || '',
      };
    }

    window.require = function (name) {
      if (name === 'electron') {
        return {
          ipcRenderer: {
            invoke: async (channel, payload) => {
              if (channel === 'init-login' || channel === 'refresh-captcha') {
                hksCookie = '';
                hksForm = null;
                try {
                  sessionStorage.removeItem('__HKS_COOKIE__');
                  sessionStorage.removeItem('__HKS_FORM__');
                  sessionStorage.removeItem('__HKS_LOGGED_IN__');
                } catch {
                  /* ignore */
                }
                return hksCaptcha();
              }
              if (channel === 'do-login') {
                return hksLogin(payload || {});
              }
              if (channel === 'export-excel') {
                let cookie = '';
                try {
                  cookie = sessionStorage.getItem('__HKS_COOKIE__') || '';
                } catch {
                  /* ignore */
                }
                if (!cookie) {
                  return { success: false, message: 'Once HKS girisi yapin (cookie yok).' };
                }
                const created = await createJob('hks_export', {
                  cookie,
                  kunyeTuru: payload?.kunyeTuru,
                  baslangicTarihi: payload?.baslangicTarihi,
                  bitisTarihi: payload?.bitisTarihi,
                  filterName: payload?.filterName,
                });
                if (!created.ok) return { success: false, message: created.msg || 'Job olusturulamadi' };
                const done = await waitJob(created.job.id, 300000);
                if (!done.ok) return { success: false, message: done.msg || 'Export hatasi' };
                return {
                  success: true,
                  message: done.message || 'HKS export worker tamamlandi (detay gelistirme sureci).',
                  ...done,
                };
              }
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

  const M = () => window.TahakkukMetin || {};

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
        bellek: d.bellek || cloud().son_cekim || { donem: null, zaman: null, sonuclar: {} },
        sgkUrl: d.sgkUrl || {},
        ivdUrl: d.ivdUrl || 'https://ivd.gib.gov.tr',
        ebynUrl: d.ebynUrl || 'https://ebeyanname.gib.gov.tr',
      };
    },
    async save(payload) {
      const next = {
        mukellefler: payload,
        son_cekim: cloud().son_cekim || null,
      };
      window.__MUSAVIRIM_CLOUD__ = { ...cloud(), ...next };
      window.parent.postMessage({ type: 'musavirim-save', arac: 'tahakkuk', payload: next }, '*');
      return { ok: true };
    },
    async bellekKaydet(bellek) {
      const d = tahakkukData();
      const next = {
        mukellefler: { ...d, bellek: bellek || d.bellek },
        son_cekim: bellek || cloud().son_cekim || null,
      };
      window.__MUSAVIRIM_CLOUD__ = { ...cloud(), ...next };
      window.parent.postMessage({ type: 'musavirim-save', arac: 'tahakkuk', payload: next }, '*');
      return { ok: true };
    },
    onWaState() {
      return () => {};
    },
    onCekIlerleme() {
      return () => {};
    },
    onSgkStatus() {
      return () => {};
    },
    onSgkCaptcha() {
      return () => {};
    },
    async waStatus() {
      const r = await parentRpc('musavirim-wa-status', {}, 15000);
      if (!r.ok) return { ok: true, status: 'kapali', msg: r.msg };
      return r;
    },
    async waStart() {
      const created = await createJob('wa_start', {});
      if (!created.ok) {
        return {
          ok: false,
          status: 'hata',
          msg: created.msg || 'Job olusturulamadi. Giris/oturum veya Supabase jobs tablosunu kontrol et.',
        };
      }
      const start = Date.now();
      let sawCalisiyor = false;
      while (Date.now() - start < 90000) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await parentRpc('musavirim-wa-status', {}, 10000);
        if (st.hazir || st.status === 'hazir') {
          return { ok: true, status: 'hazir', hazir: true, qrDataUrl: null };
        }
        if (st.qrDataUrl || st.status === 'qr') {
          return { ok: true, status: 'qr', qrDataUrl: st.qrDataUrl, hazir: false, msg: st.msg };
        }
        const job = await parentRpc('musavirim-get-job', { jobId: created.job.id }, 10000);
        const durum = job.job?.durum;
        if (durum === 'calisiyor') sawCalisiyor = true;
        if (durum === 'hata') {
          return { ok: false, status: 'hata', msg: job.job.hata_mesaji || 'wa_start hatasi' };
        }
        if (durum === 'tamam' && job.job.sonuc) {
          return { ok: true, ...job.job.sonuc };
        }
        // 20 sn boyunca job hâlâ bekliyor = worker ayakta değil
        if (!sawCalisiyor && Date.now() - start > 20000 && durum === 'bekliyor') {
          return {
            ok: false,
            status: 'hata',
            msg:
              'Worker calismiyor — karekod uretilemez. Bilgisayarda musavirim-web/worker icinde npm start yap veya Railway worker deploy et.',
          };
        }
      }
      return {
        ok: false,
        status: 'hata',
        msg: sawCalisiyor
          ? 'Karekod zaman asimina ugradi. Worker loglarina bak, tekrar Baglan.'
          : 'Worker job almadi. Worker (Railway veya yerel npm start) calisiyor mu?',
      };
    },
    async waLogout() {
      const created = await createJob('wa_logout', {});
      if (!created.ok) return { ok: false, msg: created.msg };
      return waitJob(created.job.id, 60000);
    },
    async metin(opts) {
      try {
        const tip = opts?.tip || 'makbuz';
        const metin =
          tip === 'makbuz'
            ? ''
            : M().olusturMetin({
                tip,
                firmaAdi: opts?.firmaAdi,
                vkn: opts?.vkn,
                donemEtiket: opts?.donemEtiket,
                kalemler: opts?.kalemler || [],
                tarih: opts?.tarih,
              });
        const makbuz =
          tip === 'tahakkuk'
            ? null
            : M().makbuzVeri({
                firmaAdi: opts?.firmaAdi,
                kalemler: opts?.kalemler || [],
                tarih: opts?.tarih,
              });
        return { ok: true, metin, tip, makbuz };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
    async makbuzHesapla(opts) {
      try {
        const satirlar = (opts?.satirlar || [])
          .map((k) => ({
            donem: String(k.donem || '').trim(),
            aciklama: String(k.aciklama || k.ad || '').trim() || 'Kalem',
            ad: String(k.aciklama || k.ad || '').trim() || 'Kalem',
            tutar: Number(String(k.tutar ?? '').replace(/\./g, '').replace(',', '.')) || 0,
          }))
          .filter((k) => k.tutar > 0);
        const toplam = (M().toplamKalem || ((l) => l.reduce((s, x) => s + (Number(x.tutar) || 0), 0)))(satirlar);
        const makbuz = {
          baslik: 'MUHASEBE ÖDEME BİLDİRİM MAKBUZU',
          tarih: String(opts?.tarih || '').trim() || undefined,
          musteri: String(opts?.musteri || opts?.firmaAdi || 'Müşteri').trim().toLocaleUpperCase('tr-TR'),
          satirlar,
          toplam,
          toplamYazi: M().sayiyiYaziya ? M().sayiyiYaziya(toplam) : String(toplam),
          toplamFormat: M().formatTlSembol ? M().formatTlSembol(toplam) : String(toplam),
        };
        if (!makbuz.tarih) {
          const d = new Date();
          makbuz.tarih = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
        }
        return { ok: true, makbuz };
      } catch (err) {
        return { ok: false, msg: err.message || String(err) };
      }
    },
    async makbuzGonder(opts) {
      const tel = String(opts?.telefon || '').trim();
      if (!tel) return { ok: false, msg: 'Telefon yok.' };
      const url = M().whatsappUrl
        ? M().whatsappUrl(tel, '')
        : `https://wa.me/${tel.replace(/\D/g, '')}`;
      window.open(url, '_blank', 'noopener');
      return {
        ok: true,
        msg: 'WhatsApp Web acildi. Makbuz gorselini ekrandan kaydedip yapistirabilirsiniz. Otomatik gonderim icin worker gerekir.',
      };
    },
    async cek(opts) {
      const d = tahakkukData();
      const mukellef =
        (d.mukellefler || []).find((m) => m.id === (opts?.mukellefId || d.aktifId)) ||
        (d.mukellefler || [])[0];
      const created = await createJob('tahakkuk_cek', {
        ofis: d.ofis || {},
        mukellef,
        aylar: opts?.aylar,
        yil: opts?.yil,
        ay: opts?.ay,
        donemEtiket: opts?.donemEtiket,
        ivdCek: !!opts?.ivdCek,
        whatsappTip: mukellef?.whatsappTip,
      });
      if (!created.ok) return { ok: false, msg: created.msg || 'Job olusturulamadi — worker ayakta mi?' };
      const done = await waitJob(created.job.id, 300000);
      if (!done.ok) return { ok: false, msg: done.msg };
      return { ok: true, ...done, msg: `Sorgu tamam (${(done.kalemler || []).length} kalem)` };
    },
    async cekHepsi(opts) {
      const d = tahakkukData();
      const list = d.mukellefler || [];
      const sonuclar = [];
      for (const m of list) {
        const created = await createJob('tahakkuk_cek', {
          ofis: d.ofis || {},
          mukellef: m,
          aylar: opts?.aylar,
          yil: opts?.yil,
          ay: opts?.ay,
          donemEtiket: opts?.donemEtiket,
          ivdCek: !!opts?.ivdCek,
        });
        if (!created.ok) {
          sonuclar.push({ id: m.id, ok: false, msg: created.msg });
          continue;
        }
        const done = await waitJob(created.job.id, 300000);
        sonuclar.push({ id: m.id, ok: done.ok, ...(done.ok ? done : { msg: done.msg }) });
      }
      return { ok: true, sonuclar, msg: `${sonuclar.filter((s) => s.ok).length}/${list.length} tamam` };
    },
    async sgkCek() {
      return { ok: false, msg: 'SGK cekim bulutta henuz yok (worker gerekir).' };
    },
    async sgkCaptchaSubmit() {
      return { ok: false, msg: 'SGK captcha bulutta yok.' };
    },
    async sgkCaptchaCancel() {
      return { ok: true };
    },
    async sgkCaptchaRefresh() {
      return { ok: false, msg: 'SGK captcha bulutta yok.' };
    },
    async excelSablon() {
      return { ok: false, msg: 'Excel sablon bulutta yakinda.' };
    },
    async excelDisari() {
      return { ok: false, msg: 'Excel disa aktarma bulutta yakinda.' };
    },
    async excelAktar() {
      return { ok: false, canceled: true, msg: 'Excel aktarimi bulutta yakinda.' };
    },
    async openUrl(url) {
      if (url) window.open(url, '_blank', 'noopener');
      return { ok: true };
    },
    async openFisFolder() {
      return { ok: false, msg: 'Bulutta klasor yok.' };
    },
    async selectFisFolder() {
      return { canceled: true };
    },
    async testIvd() {
      return { ok: false, msg: 'IVD testi worker ile eklenecek.' };
    },
    async testEbyn() {
      return { ok: false, msg: 'EBYN testi worker ile eklenecek.' };
    },
    async waMetinGonder() {
      return { ok: false, msg: 'WhatsApp metin gonderimi worker ister.' };
    },
    async waPdfGonder() {
      return { ok: false, msg: 'WhatsApp PDF gonderimi worker ister.' };
    },
  };

  window.tahakkukApp = tahakkukApi;
})();
