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

  window.__MUSAVIRIM_IS_CLOUD__ = true;

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
                const done = await waitJob(created.job.id, 600000);
                if (!done.ok) return { success: false, message: done.msg || 'Export hatasi' };

                const fileName =
                  done.filename ||
                  done.fileName ||
                  `HKS_Kunye_${String(payload?.kunyeTuru || 'export').replace(/\s+/g, '_')}.xlsx`;
                let filePath = fileName;

                if (done.excelBase64) {
                  try {
                    const bin = atob(String(done.excelBase64).replace(/^data:[^;]+;base64,/, ''));
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    const blob = new Blob([bytes], {
                      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = fileName;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 2000);
                    window.__HKS_LAST_EXCEL__ = {
                      fileName,
                      excelBase64: done.excelBase64,
                      count: done.count || done.rowCount || 0,
                    };
                    filePath = `Bulut/${fileName}`;
                  } catch (err) {
                    return { success: false, message: 'Excel indirilemedi: ' + (err.message || err) };
                  }
                } else if (done.downloadUrl) {
                  window.open(done.downloadUrl, '_blank', 'noopener');
                  filePath = done.downloadUrl;
                } else if (!done.storagePath) {
                  return {
                    success: false,
                    message:
                      done.message ||
                      'HKS Excel uretilemedi. Worker loglarina bakin veya tekrar deneyin.',
                    rowCount: done.rowCount,
                  };
                }

                return {
                  success: true,
                  message: done.message || 'HKS Excel buluta kaydedildi / indirildi.',
                  filePath,
                  count: done.count || done.rowCount || 0,
                  filename: fileName,
                  storagePath: done.storagePath || null,
                };
              }
              if (channel === 'select-folder') {
                return {
                  success: true,
                  path: 'Bulut (Excel otomatik iner)',
                  cloud: true,
                };
              }
              if (channel === 'select-hks-file' || channel === 'select-save') {
                return await new Promise((resolve) => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept =
                    channel === 'select-hks-file'
                      ? '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                      : '*/*';
                  input.onchange = async () => {
                    const file = input.files && input.files[0];
                    if (!file) {
                      resolve({ canceled: true, success: false });
                      return;
                    }
                    const buf = await file.arrayBuffer();
                    const bytes = new Uint8Array(buf);
                    let binary = '';
                    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                    const b64 = btoa(binary);
                    window.__HKS_LAST_EXCEL__ = { fileName: file.name, excelBase64: b64, count: 0 };
                    resolve({ success: true, path: file.name, fileName: file.name, cloud: true });
                  };
                  input.click();
                });
              }
              if (channel === 'open-file') {
                const last = window.__HKS_LAST_EXCEL__;
                if (last?.excelBase64) {
                  const bin = atob(String(last.excelBase64).replace(/^data:[^;]+;base64,/, ''));
                  const bytes = new Uint8Array(bin.length);
                  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                  const blob = new Blob([bytes], {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = last.fileName || 'hks.xlsx';
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  setTimeout(() => URL.revokeObjectURL(url), 2000);
                  return { success: true };
                }
                return { success: false, message: 'Dosya bulutta yok — tekrar Excel\'e Aktar.' };
              }
              if (channel === 'convert-to-mustahsil') {
                const src =
                  window.__HKS_LAST_EXCEL__ ||
                  (payload?.excelBase64
                    ? { excelBase64: payload.excelBase64, fileName: payload.hksFilePath || 'hks.xlsx' }
                    : null);
                if (!src?.excelBase64) {
                  return {
                    success: false,
                    message: 'HKS Excel yok. Once "Dosya Seç" ile HKS_Kunye_*.xlsx secin veya Excel\'e Aktar.',
                  };
                }
                try {
                  if (typeof window.XLSX === 'undefined') {
                    await new Promise((resolve, reject) => {
                      const s = document.createElement('script');
                      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
                      s.onload = resolve;
                      s.onerror = () => reject(new Error('SheetJS yuklenemedi'));
                      document.head.appendChild(s);
                    });
                  }
                  const XLSX = window.XLSX;
                  const raw = String(src.excelBase64).replace(/^data:[^;]+;base64,/, '');
                  const wb = XLSX.read(raw, { type: 'base64', cellDates: false, raw: false });
                  const sheet = wb.Sheets[wb.SheetNames[0]];
                  const hksData = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
                  const rows = [];
                  for (let i = 1; i < hksData.length; i++) {
                    const r = hksData[i];
                    if (!r || !r[0]) continue;
                    rows.push({
                      kunyeNo: r[0],
                      tarih: r[1],
                      malinAdi: r[2],
                      miktar: parseFloat(String(r[3] || '').replace(',', '.')) || r[3],
                      birim: r[4],
                      birimFiyat: parseFloat(String(r[5] || '').replace(',', '.')) || r[5],
                      il: r[6],
                      ilce: r[7],
                      uretici: r[8],
                      tckn: r[9],
                    });
                  }
                  if (!rows.length) return { success: false, message: 'HKS dosyasinda veri bulunamadi' };

                  let makbuzCounter = 0;
                  const makbuzMap = {};
                  const outAoA = [
                    [
                      'Makbuz_No',
                      'TARIH',
                      'KISI_ADI',
                      'KISI_SOYADI',
                      'ALICI_UNVAN',
                      'TCKN',
                      'IL',
                      'ILCE',
                      'ADRES',
                      'URUN',
                      'MIKTAR',
                      'BIRIM',
                      'BIRIM_FIYAT',
                      'GV_STOPAJI_ORANI',
                      'BORSA_TES_UC_ORANI',
                      'BORSA_TES_UC_TUTARI',
                      'MERA_FONU_TUTARI',
                      'SGK_PRIM_KESİNTİ_TUTARI',
                      'TUTAR',
                      'SATICI_MAL_KODU',
                      'KUNYE_NO',
                    ],
                  ];
                  for (const row of rows) {
                    let tarihStr = '';
                    if (typeof row.tarih === 'string' && row.tarih.includes('.')) {
                      const p = row.tarih.split('.');
                      tarihStr = `${p[2]}-${p[1]}-${p[0]}`;
                    } else {
                      tarihStr = String(row.tarih || '');
                    }
                    const key = `${row.tckn}_${tarihStr}`;
                    if (!makbuzMap[key]) {
                      makbuzCounter += 1;
                      makbuzMap[key] = `Makbuz_${makbuzCounter}`;
                    }
                    const ureticiStr = String(row.uretici || '').trim();
                    const nameParts = ureticiStr.split(/\s+/);
                    let birimStr = String(row.birim || '').trim();
                    if (birimStr.toLowerCase() === 'kg') birimStr = 'KGM';
                    const miktar =
                      typeof row.miktar === 'number'
                        ? row.miktar
                        : parseFloat(String(row.miktar || '').replace(',', '.')) || '';
                    const birimFiyat =
                      typeof row.birimFiyat === 'number'
                        ? row.birimFiyat
                        : parseFloat(String(row.birimFiyat || '').replace(',', '.')) || '';
                    outAoA.push([
                      makbuzMap[key],
                      row.tarih || '',
                      nameParts[0] || '',
                      nameParts.slice(1).join(' ') || '',
                      ureticiStr,
                      String(row.tckn || ''),
                      row.il || '',
                      row.ilce || '',
                      ' ',
                      row.malinAdi || '',
                      miktar,
                      birimStr,
                      birimFiyat,
                      2,
                      '',
                      '',
                      '',
                      '',
                      typeof miktar === 'number' && typeof birimFiyat === 'number' ? miktar * birimFiyat : '',
                      '',
                      String(row.kunyeNo || ''),
                    ]);
                  }
                  const outWb = XLSX.utils.book_new();
                  const outWs = XLSX.utils.aoa_to_sheet(outAoA);
                  XLSX.utils.book_append_sheet(outWb, outWs, 'Sheet');
                  const outB64 = XLSX.write(outWb, { type: 'base64', bookType: 'xlsx' });
                  const baseName = String(src.fileName || 'HKS_Kunye').replace(/\.xlsx$/i, '');
                  const outName = baseName.replace('HKS_Kunye_', 'Mustahsil_') + '_Mustahsil.xlsx';
                  const bin = atob(outB64);
                  const bytes = new Uint8Array(bin.length);
                  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                  const blob = new Blob([bytes], {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = outName;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  setTimeout(() => URL.revokeObjectURL(url), 2000);
                  window.__HKS_LAST_MUSTAHSIL__ = { fileName: outName, excelBase64: outB64, count: rows.length };
                  return {
                    success: true,
                    filePath: `Bulut/${outName}`,
                    count: rows.length,
                    message: 'Mustahsil Excel indirildi (bulut).',
                  };
                } catch (err) {
                  return { success: false, message: err.message || String(err) };
                }
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
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.xml,text/xml,application/xml';
        // Chromium: klasor secimi
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
        input.onchange = () => {
          const all = [...(input.files || [])];
          const files = all.filter((f) => /\.xml$/i.test(f.name));
          window.__STOK_XML_FILES__ = files;
          if (!files.length) {
            resolve({ ok: false, canceled: false, msg: 'Secilen klasorde XML yok.' });
            return;
          }
          const top = files[0].webkitRelativePath
            ? files[0].webkitRelativePath.split('/')[0]
            : `${files.length} XML`;
          resolve({
            ok: true,
            path: `Bulut: ${top} (${files.length} XML)`,
            cloud: true,
            count: files.length,
          });
        };
        input.oncancel = () => resolve({ canceled: true });
        input.click();
      });
    },
    async selectSave() {
      return { canceled: true, msg: 'Bulutta Excel otomatik iner.' };
    },
    async isle(opts) {
      const files = window.__STOK_XML_FILES__ || [];
      if (!files.length) {
        return { ok: false, msg: 'Once Klasor Seç ile XML klasorunu secin (bulutta dosya secilir).' };
      }
      const packed = [];
      for (const f of files.slice(0, 400)) {
        const buf = await f.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        packed.push({
          name: f.webkitRelativePath || f.name,
          base64: btoa(binary),
        });
      }
      const created = await createJob('stok_isle', {
        files: packed,
        markers: opts?.markers || opts?.markerText || '',
        firmaAdi: opts?.firmaAdi || '',
        excludeKeywords: opts?.excludeKeywords || '',
      });
      if (!created.ok) return { ok: false, msg: created.msg || 'Worker job olusturulamadi' };
      const done = await waitJob(created.job.id, 600000);
      if (!done.ok) return { ok: false, msg: done.msg || 'Stok islemi basarisiz' };
      if (done.excelBase64) {
        try {
          const bin = atob(String(done.excelBase64).replace(/^data:[^;]+;base64,/, ''));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = done.filename || done.cikti || 'stok.xlsx';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          window.__STOK_LAST_EXCEL__ = { fileName: a.download, excelBase64: done.excelBase64 };
        } catch (err) {
          return { ok: false, msg: 'Excel indirilemedi: ' + err.message };
        }
      }
      return {
        ok: true,
        xmlSayisi: done.xmlSayisi || packed.length,
        satir: done.satir || 0,
        urun: done.urun || 0,
        cikti: done.filename || done.cikti || 'stok.xlsx',
        ornekStok: done.ornekStok || [],
        msg: 'Stok Excel indirildi (bulut).',
      };
    },
    async openPath() {
      const last = window.__STOK_LAST_EXCEL__;
      if (!last?.excelBase64) return { ok: false, msg: 'Once stok Excel olusturun.' };
      const bin = atob(String(last.excelBase64).replace(/^data:[^;]+;base64,/, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = last.fileName || 'stok.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return { ok: true };
    },
    async showInFolder() {
      return { ok: true, msg: 'Bulutta klasor yok — Excel Indirilenler\'e indi.' };
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
      let imageBase64 = opts?.imageBase64 || null;
      if (!imageBase64) {
        try {
          const card = document.getElementById('makbuzCard');
          if (card) {
            if (typeof window.html2canvas !== 'function') {
              await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
                s.onload = resolve;
                s.onerror = () => reject(new Error('html2canvas yuklenemedi'));
                document.head.appendChild(s);
              });
            }
            const canvas = await window.html2canvas(card, { backgroundColor: '#ffffff', scale: 2 });
            imageBase64 = canvas.toDataURL('image/png');
          }
        } catch (err) {
          console.warn('makbuz capture', err);
        }
      }
      if (!imageBase64 && opts?.makbuz) {
        const m = opts.makbuz;
        const lines = (m.satirlar || [])
          .map((k) => `${k.donem || ''} ${k.aciklama || ''}: ${k.tutar ?? ''}`)
          .join('\n');
        const metin = `MUHASEBE ODEME BILDIRIM MAKBUZU\n${m.musteri || ''}\nTarih: ${m.tarih || ''}\n${lines}\nTOPLAM: ${m.toplamFormat || m.toplam || ''}`;
        const created = await createJob('wa_gonder', { telefon: tel, metin });
        if (!created.ok) return { ok: false, msg: created.msg || 'Worker job olusturulamadi' };
        return waitJob(created.job.id, 120000);
      }
      if (!imageBase64) {
        return { ok: false, msg: 'Makbuz gorseli olusturulamadi. Once Onizleme ac.' };
      }
      const created = await createJob('wa_gonder', { telefon: tel, imageBase64 });
      if (!created.ok) return { ok: false, msg: created.msg || 'Worker job olusturulamadi' };
      const done = await waitJob(created.job.id, 120000);
      if (!done.ok) return { ok: false, msg: done.msg || 'Gonderim basarisiz' };
      return { ok: true, msg: `Makbuz WhatsApp ile gonderildi: ${tel}`, gonderildi: true };
    },
    async cek(opts) {
      const d = tahakkukData();
      const mukellef =
        (d.mukellefler || []).find((m) => m.id === (opts?.mukellefId || opts?.mukellef?.id || d.aktifId)) ||
        opts?.mukellef ||
        (d.mukellefler || [])[0];
      const created = await createJob('tahakkuk_cek', {
        ofis: opts?.ofis || d.ofis || {},
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
      const loglar = (done.loglar || []).map((l) =>
        typeof l === 'string' ? { tip: 'bilgi', mesaj: l } : l,
      );
      const mevcut = d.bellek || { donem: null, zaman: null, sonuclar: {} };
      const bellek = {
        ...mevcut,
        sonuclar: { ...(mevcut.sonuclar || {}) },
        zaman: new Date().toISOString(),
      };
      if (done.bellekKayit && mukellef?.id) {
        const eski = bellek.sonuclar[mukellef.id] || {};
        bellek.sonuclar[mukellef.id] = {
          ...eski,
          ...done.bellekKayit,
          donemler: { ...(eski.donemler || {}), ...(done.bellekKayit.donemler || {}) },
        };
      }
      return {
        ok: true,
        kalemler: done.kalemler || [],
        kaydedilenFisler: done.kaydedilenFisler || [],
        loglar,
        bellek,
        metin: done.metin,
        msg: `Sorgu tamam (${(done.kalemler || []).length} kalem)`,
      };
    },
    async cekHepsi(opts) {
      const d = tahakkukData();
      const list =
        Array.isArray(opts?.mukellefler) && opts.mukellefler.length
          ? opts.mukellefler
          : d.mukellefler || [];
      const mevcut = d.bellek || { donem: null, zaman: null, sonuclar: {} };
      const bellek = {
        ...mevcut,
        sonuclar: { ...(mevcut.sonuclar || {}) },
        zaman: new Date().toISOString(),
        donem: opts?.donemEtiket
          ? { donemEtiket: opts.donemEtiket, yil: opts.yil, ay: opts.ay }
          : mevcut.donem,
      };
      const sonuclar = [];
      const ozet = [];
      for (const m of list) {
        const created = await createJob('tahakkuk_cek', {
          ofis: opts?.ofis || d.ofis || {},
          mukellef: m,
          aylar: opts?.aylar,
          yil: opts?.yil,
          ay: opts?.ay,
          donemEtiket: opts?.donemEtiket,
          ivdCek: !!opts?.ivdCek,
        });
        if (!created.ok) {
          sonuclar.push({ id: m.id, ok: false, msg: created.msg });
          ozet.push({ ad: m.ad, kalemSayisi: 0, tutar: 0, ok: false });
          continue;
        }
        const done = await waitJob(created.job.id, 300000);
        if (done.ok) {
          if (done.bellekKayit && m.id) {
            const eski = bellek.sonuclar[m.id] || {};
            bellek.sonuclar[m.id] = {
              ...eski,
              ...done.bellekKayit,
              donemler: { ...(eski.donemler || {}), ...(done.bellekKayit.donemler || {}) },
            };
          }
          const kalemler = done.kalemler || [];
          const tutar = kalemler.reduce((s, k) => s + (Number(k.tutar) || 0), 0);
          ozet.push({ ad: m.ad, kalemSayisi: kalemler.length, tutar, ok: true });
          sonuclar.push({ id: m.id, ok: true, kalemler, kaydedilenFisler: done.kaydedilenFisler || [] });
        } else {
          ozet.push({ ad: m.ad, kalemSayisi: 0, tutar: 0, ok: false });
          sonuclar.push({ id: m.id, ok: false, msg: done.msg });
        }
      }
      return {
        ok: true,
        sonuclar,
        ozet,
        bellek,
        msg: `${sonuclar.filter((s) => s.ok).length}/${list.length} tamam`,
      };
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
    async waMetinGonder(opts) {
      const tel = String(opts?.telefon || '').trim();
      const metin = String(opts?.metin || '').trim();
      if (!tel) return { ok: false, msg: 'Telefon yok.' };
      if (!metin) return { ok: false, msg: 'Metin yok.' };
      const created = await createJob('wa_gonder', { telefon: tel, metin });
      if (!created.ok) return { ok: false, msg: created.msg };
      return waitJob(created.job.id, 120000);
    },
    async waPdfGonder(opts) {
      const tel = String(opts?.telefon || '').trim();
      if (!tel) return { ok: false, msg: 'Telefon yok.' };
      const files = opts?.pdfDosyalari || [];
      if (!files.length) return { ok: false, msg: 'PDF yok.' };
      let sent = 0;
      const errors = [];
      for (const f of files) {
        const item = typeof f === 'string' ? { path: f } : f || {};
        const pdfBase64 = item.pdfBase64 || opts?.pdfBase64;
        if (!pdfBase64) {
          errors.push(`${item.filename || item.path || 'pdf'}: bulutta base64 yok (once Getir)`);
          continue;
        }
        const created = await createJob('wa_gonder', {
          telefon: tel,
          pdfBase64,
          fileName: item.filename || 'tahakkuk.pdf',
        });
        if (!created.ok) {
          errors.push(created.msg || 'job olusturulamadi');
          continue;
        }
        const done = await waitJob(created.job.id, 180000);
        if (done.ok) sent += 1;
        else errors.push(done.msg || 'gonderim hatasi');
      }
      if (!sent) return { ok: false, msg: errors.join('; ') || 'PDF gonderilemedi' };
      return {
        ok: true,
        msg: `${sent} PDF gonderildi` + (errors.length ? ` (${errors.length} hata)` : ''),
      };
    },
  };

  window.tahakkukApp = tahakkukApi;
})();
