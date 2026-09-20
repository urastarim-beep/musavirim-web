import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdir } from 'fs/promises';
import http from 'http';
import { createClient } from '@supabase/supabase-js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POLL_MS = Number(process.env.POLL_MS || 3000);
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!url || !key) {
  console.error('SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY gerekli.');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { WhatsappClient } = require('./lib/whatsappClient.cjs');
const ebynApi = require('./lib/ebynApi.cjs');
const ivdApi = require('./lib/ivdApi.cjs');
const { olusturMetin } = require('./lib/metin.cjs');

let waClient = null;

async function syncWaState(state) {
  await supabase.from('whatsapp_durum').upsert({
    id: 1,
    bagli: state?.status === 'hazir',
    qr_data: state?.qrDataUrl || null,
    mesaj: state?.hata || state?.status || null,
    son_guncelleme: new Date().toISOString(),
  });
}

function getWa() {
  if (!waClient) {
    const authDir = path.join(DATA_DIR, 'whatsapp-auth');
    waClient = new WhatsappClient(authDir);
    waClient.on('state', (s) => {
      syncWaState(s).catch((e) => console.error('wa sync', e.message));
    });
  }
  return waClient;
}

async function claimJob() {
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('durum', 'bekliyor')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  const job = jobs?.[0];
  if (!job) return null;

  const { data: claimed, error: updErr } = await supabase
    .from('jobs')
    .update({ durum: 'calisiyor', started_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('durum', 'bekliyor')
    .select()
    .maybeSingle();
  if (updErr) throw updErr;
  return claimed;
}

async function finishJob(id, ok, sonuc, hata) {
  await supabase
    .from('jobs')
    .update({
      durum: ok ? 'tamam' : 'hata',
      sonuc: sonuc || null,
      hata_mesaji: hata || null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', id);
}

async function handleWaStart() {
  const client = getWa();
  // Telefon "cihaz baglanamadi" → yarim oturum + eski QR; her Baglan'da temiz pairing
  if (client.status !== 'hazir') {
    try {
      if (typeof client.stop === 'function') client.stop();
    } catch (_) { /* ignore */ }
    const state = await client.start({ fresh: true });
    await syncWaState(state);
    return { ok: true, ...state };
  }
  const state = await client.start();
  await syncWaState(state);
  return { ok: true, ...state };
}

async function handleWaLogout() {
  const client = getWa();
  if (typeof client.stop === 'function') client.stop();
  await syncWaState({ status: 'kapali', qrDataUrl: null });
  return { ok: true, status: 'kapali' };
}

async function handleWaGonder(job) {
  const { telefon, metin, imageBase64, pdfBase64, fileName } = job.payload || {};
  if (!telefon) throw new Error('telefon gerekli');
  const client = getWa();
  if (client.status !== 'hazir') {
    throw new Error('WhatsApp bagli degil. Once wa_start ile QR okutun.');
  }
  if (pdfBase64 && typeof client.sendDocument === 'function') {
    const buf = Buffer.from(String(pdfBase64).replace(/^data:application\/pdf;base64,/, ''), 'base64');
    await client.sendDocument(telefon, buf, fileName || 'tahakkuk.pdf', 'application/pdf');
    if (metin) await client.sendText(telefon, metin);
    return { ok: true, tip: 'pdf', telefon };
  }
  if (imageBase64 && typeof client.sendImage === 'function') {
    const buf = Buffer.from(String(imageBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    await client.sendImage(telefon, buf);
    if (metin) await client.sendText(telefon, metin);
    return { ok: true, tip: 'image', telefon };
  }
  if (!metin) throw new Error('metin, imageBase64 veya pdfBase64 gerekli');
  await client.sendText(telefon, metin);
  return { ok: true, tip: 'text', telefon };
}

async function handleTahakkukCek(job) {
  const p = job.payload || {};
  const ofis = p.ofis || {};
  const mukellef = p.mukellef || {};
  const aylarRaw = Array.isArray(p.aylar) && p.aylar.length ? p.aylar : [p.ay || new Date().getMonth() + 1];
  const yil = Number(p.yil) || new Date().getFullYear();
  const aylar = aylarRaw.map((a) =>
    typeof a === 'object' && a != null ? { ay: Number(a.ay), yil: Number(a.yil || yil) } : { ay: Number(a), yil },
  );
  const vkn = String(mukellef.vkn || '').replace(/\D/g, '');
  if (!vkn) throw new Error('mukellef.vkn gerekli');

  const kalemler = [];
  const loglar = [];
  const kaydedilenFisler = [];
  let pdfMap = null;

  if (ofis.ebynKullanici && ofis.ebynParola && ofis.ebynSifre) {
    loglar.push({ tip: 'bilgi', mesaj: 'EBYN basliyor…' });
    const ebyn = await ebynApi.getTahakkuklar({
      kullanici: ofis.ebynKullanici,
      parola: ofis.ebynParola,
      sifre: ofis.ebynSifre,
      vknTckn: vkn,
      aylar,
    });
    const list = ebyn?.kalemler || ebyn?.items || [];
    for (const k of list) kalemler.push({ ...k, kaynak: 'ebyn' });
    pdfMap = ebyn?.pdfMap || null;
    loglar.push({ tip: 'ok', mesaj: `EBYN: ${list.length} kalem` });
  } else {
    loglar.push({ tip: 'uyari', mesaj: 'EBYN ofis bilgisi yok — atlandi' });
  }

  if (p.ivdCek && mukellef.ivdKullanici && mukellef.ivdSifre) {
    loglar.push({ tip: 'bilgi', mesaj: 'IVD basliyor…' });
    const ivd = await ivdApi.getBorcDurumu(mukellef.ivdKullanici, mukellef.ivdSifre);
    const list = ivd?.kalemler || ivd?.borclar || [];
    for (const k of list) kalemler.push({ ...k, kaynak: 'ivd' });
    loglar.push({ tip: 'ok', mesaj: `IVD: ${list.length} kalem` });
  }

  if (pdfMap) {
    for (const [oid, pack] of Object.entries(pdfMap)) {
      try {
        const raw = pack.pdf;
        const buf = Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw?.data || raw || []);
        if (!buf.length) continue;
        const filename = pack.filename || `tahakkuk-${oid}.pdf`;
        const storagePath = `${job.user_id || 'anon'}/tahakkuk/${job.id}/${filename}`;
        let uploaded = false;
        try {
          const { error: upErr } = await supabase.storage
            .from('musavirim-dosyalar')
            .upload(storagePath, buf, { contentType: 'application/pdf', upsert: true });
          uploaded = !upErr;
        } catch {
          uploaded = false;
        }
        kaydedilenFisler.push({
          tahakkukOid: oid,
          filename,
          donem: pack.donem || '',
          tur: pack.tur || '',
          path: uploaded ? storagePath : null,
          // Worker / UI WhatsApp icin; buyuk dosyalarda storage tercih
          pdfBase64: uploaded ? null : buf.toString('base64'),
        });
      } catch (err) {
        loglar.push({ tip: 'hata', mesaj: `PDF kayit: ${err.message || err}` });
      }
    }
    if (kaydedilenFisler.length) {
      loglar.push({ tip: 'ok', mesaj: `Tahakkuk PDF: ${kaydedilenFisler.length} dosya` });
    }
  }

  const metin = olusturMetin({
    tip: p.whatsappTip || mukellef.whatsappTip || 'makbuz',
    firmaAdi: mukellef.ad,
    vkn,
    donemEtiket: p.donemEtiket || '',
    kalemler,
  });

  const ay0 = aylar[0] || { yil, ay: new Date().getMonth() + 1 };
  const donemKey = `${ay0.yil}-${String(ay0.ay).padStart(2, '0')}`;

  return {
    ok: true,
    kalemler,
    metin,
    loglar,
    kaydedilenFisler,
    mukellefId: mukellef.id,
    vkn,
    bellekKayit: {
      id: mukellef.id,
      ad: mukellef.ad,
      vkn,
      kalemler,
      pdfDosyalari: kaydedilenFisler,
      donemler: {
        [donemKey]: {
          kalemler,
          pdfDosyalari: kaydedilenFisler,
          ok: true,
          zaman: new Date().toISOString(),
        },
      },
      sonDonem: donemKey,
      zaman: new Date().toISOString(),
    },
  };
}

async function handleHizliXml(job) {
  // Parent repo server libs (CommonJS)
  const portalPath = path.join(__dirname, '..', 'server', 'hizli-xml', 'lib', 'portal', 'index.cjs');
  const { portalGetir, resolveIndirmeParams } = require(portalPath);
  const os = await import('os');
  const fs = await import('fs');
  const AdmZip = require('adm-zip');

  const tmpRoot = path.join(os.tmpdir(), 'musavirim-worker-hizli', String(Date.now()));
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    const params = resolveIndirmeParams({ ...job.payload, indirmeKlasoru: tmpRoot });
    const portal = portalGetir(params.portal || 'hizli');
    const result = await portal.indirFatura(params, { onLog: () => {} });
    const zip = new AdmZip();
    let fileCount = 0;
    function addDir(dir, prefix = '') {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) addDir(full, path.join(prefix, name));
        else if (/\.(xml|zip)$/i.test(name)) {
          zip.addLocalFile(full, prefix);
          fileCount += 1;
        }
      }
    }
    addDir(result.klasor || tmpRoot);
    const zipBuf = zip.toBuffer();
    const filename = `xml_${params.yil || ''}-${params.ay || ''}.zip`;
    const storagePath = `${job.user_id}/hizli-xml/${job.id}-${filename}`;
    const { error: upErr } = await supabase.storage
      .from('musavirim-dosyalar')
      .upload(storagePath, zipBuf, { contentType: 'application/zip', upsert: true });
    if (upErr) {
      // bucket yoksa base64 sonuçta dön (küçük dosyalar)
      return {
        ok: true,
        xmlSayisi: result.xmlSayisi || fileCount,
        yeni: result.yeni || fileCount,
        zipBase64: zipBuf.toString('base64'),
        filename,
        storageUyari: upErr.message,
      };
    }
    return {
      ok: true,
      xmlSayisi: result.xmlSayisi || fileCount,
      yeni: result.yeni || fileCount,
      storagePath,
      filename,
    };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function handleHksExport(job) {
  const ExcelJS = require('exceljs');
  const { chromium } = await import('playwright');
  const p = job.payload || {};
  const cookieHeader = String(p.cookie || '');
  if (!cookieHeader) throw new Error('HKS cookie gerekli — once webden giris yapin');

  const filterName = String(p.filterName || '').trim();
  if (!filterName) throw new Error('Filtre adi bos');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });
    const cookies = cookieHeader
      .split(';')
      .map((part) => {
        const [name, ...rest] = part.trim().split('=');
        return {
          name: name.trim(),
          value: rest.join('=').trim(),
          domain: 'hks.hal.gov.tr',
          path: '/',
        };
      })
      .filter((c) => c.name && c.value);
    await context.addCookies(cookies);

    const page = await context.newPage();
    const BILDIRIM = 'https://hks.hal.gov.tr/Pages/Bildirimci/BildirimListesi.aspx';
    await page.goto(BILDIRIM, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const html = await page.content();
    if (/Login\.aspx|txtCaptchaCodeTextBox/i.test(html) || /Login\.aspx/i.test(page.url())) {
      throw new Error('HKS oturumu gecersiz — webden tekrar giris yapin');
    }

    const kunyeTuru = p.kunyeTuru || 'Referans';
    try {
      await page.selectOption('#MainContent_ddlKunyeTuru', { label: kunyeTuru });
    } catch {
      try {
        await page.selectOption('#MainContent_ddlKunyeTuru', { label: 'Malın Geliş Künyesi' });
      } catch {
        /* ignore */
      }
    }
    await page.waitForTimeout(400);

    const baslangicFormatted = String(p.baslangicTarihi || '').replace(/\//g, '.');
    const bitisFormatted = String(p.bitisTarihi || '').replace(/\//g, '.');
    if (baslangicFormatted) {
      const el = await page.$('#x\\:1558800468\\.0\\:mkr\\:3');
      if (el) {
        await el.click();
        await el.evaluate((n) => {
          n.value = '';
        });
        await el.type(baslangicFormatted, { delay: 0 });
        await page.keyboard.press('Tab');
      }
    }
    if (bitisFormatted) {
      const el = await page.$('#x\\:815955057\\.0\\:mkr\\:3');
      if (el) {
        await el.click();
        await el.evaluate((n) => {
          n.value = '';
        });
        await el.type(bitisFormatted, { delay: 0 });
        await page.keyboard.press('Tab');
      }
    }

    const search = await page.$('#MainContent_btnSearch');
    if (search) {
      await search.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1500);
    }

    const allRows = [];
    let pageNum = 1;
    let hasNext = true;
    while (hasNext && pageNum <= 40) {
      const batch = await page.evaluate((filter) => {
        const normalize = (s) =>
          String(s || '')
            .toLocaleUpperCase('tr-TR')
            .replace(/İ/g, 'I')
            .replace(/Ş/g, 'S')
            .replace(/Ğ/g, 'G')
            .replace(/Ü/g, 'U')
            .replace(/Ö/g, 'O')
            .replace(/Ç/g, 'C')
            .replace(/\s+/g, ' ')
            .trim();
        const filterNorm = normalize(filter);
        const out = [];
        const rows = document.querySelectorAll('#MainContent_BildirimListele1_gvBildirimList tr');
        let headers = [];
        let malinSahibiIndex = -1;
        let bildirimciIndex = -1;
        rows.forEach((row) => {
          const ths = row.querySelectorAll('th');
          if (ths.length) {
            headers = [...ths].map((h) => (h.textContent || '').trim());
            headers.forEach((text, idx) => {
              if (text.includes('Malın Sahibi')) malinSahibiIndex = idx;
              if (text.includes('Bildirimci')) bildirimciIndex = idx;
            });
            return;
          }
          const cells = [...row.querySelectorAll('td')].map((c) => (c.textContent || '').trim());
          if (!cells.length) return;
          const sahip = malinSahibiIndex >= 0 ? cells[malinSahibiIndex] : '';
          const bildirimci = bildirimciIndex >= 0 ? cells[bildirimciIndex] : '';
          const sahipN = normalize(sahip);
          const bildirimciN = normalize(bildirimci);
          const match =
            !filterNorm ||
            sahipN.includes(filterNorm) ||
            filterNorm.includes(sahipN) ||
            bildirimciN.includes(filterNorm) ||
            filterNorm.includes(bildirimciN);
          if (!match) return;
          const obj = { malinSahibi: sahip, bildirimci };
          headers.forEach((h, i) => {
            if (h) obj[h] = cells[i] || '';
          });
          if (!headers.length) {
            cells.forEach((v, i) => {
              obj['col' + i] = v;
            });
          }
          out.push(obj);
        });
        return out;
      }, filterName);

      allRows.push(...batch);

      const clicked = await page.evaluate((currentPage) => {
        const links = document.querySelectorAll('#MainContent_BildirimListele1_gvBildirimList a');
        for (const link of links) {
          if ((link.textContent || '').trim() === String(currentPage + 1)) {
            link.click();
            return true;
          }
        }
        return false;
      }, pageNum);
      if (clicked) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1200);
        pageNum += 1;
      } else {
        hasNext = false;
      }
    }

    if (!allRows.length) {
      throw new Error(
        `Filtreye uyan veri yok: "${filterName}". Filtre / tarih / künye türünü kontrol edin.`,
      );
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Künye Belgeleri');
    const preferred = [
      'Künye No',
      'Bildirim Tarihi',
      'Malın Adı',
      'Miktar',
      'Birim',
      'Malın Birim Fiyatı',
      'Birim Fiyat',
      'İl',
      'İlçe',
      'Üreticinin Adı-Soyadı',
      'Üretici',
      'TC/VKN',
      'Malın Cinsi',
      'Malın Sahibi',
      'Bildirimci',
    ];
    const keySet = new Set();
    allRows.forEach((r) => Object.keys(r).forEach((k) => keySet.add(k)));
    const keys = [
      ...preferred.filter((k) => keySet.has(k)),
      ...[...keySet].filter((k) => !preferred.includes(k)),
    ];
    worksheet.columns = keys.map((k) => ({ header: k, key: k, width: Math.min(40, Math.max(12, k.length + 2)) }));
    worksheet.getRow(1).font = { bold: true };
    for (const row of allRows) worksheet.addRow(row);

    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    const safeKunye = String(kunyeTuru).replace(/[^\wğüşıöçĞÜŞİÖÇ\- ]+/gi, '').replace(/\s+/g, '_');
    const filename = `HKS_Kunye_${safeKunye}_${baslangicFormatted.replace(/\./g, '-') || 'bas'}_${bitisFormatted.replace(/\./g, '-') || 'bit'}.xlsx`;
    const storagePath = `${job.user_id || 'anon'}/hks/${job.id}-${filename}`;
    let uploaded = false;
    try {
      const { error: upErr } = await supabase.storage
        .from('musavirim-dosyalar')
        .upload(storagePath, buf, {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          upsert: true,
        });
      uploaded = !upErr;
    } catch {
      uploaded = false;
    }

    return {
      ok: true,
      success: true,
      count: allRows.length,
      rowCount: allRows.length,
      filename,
      fileName: filename,
      excelBase64: buf.toString('base64'),
      storagePath: uploaded ? storagePath : null,
      message: `${allRows.length} künye Excel olarak hazırlandı (bulut).`,
      filterName,
      kunyeTuru,
    };
  } finally {
    await browser.close();
  }
}

async function processJob(job) {
  console.log('job', job.id, job.tip);
  try {
    let sonuc;
    switch (job.tip) {
      case 'wa_start':
        sonuc = await handleWaStart();
        break;
      case 'wa_logout':
        sonuc = await handleWaLogout();
        break;
      case 'wa_gonder':
        sonuc = await handleWaGonder(job);
        break;
      case 'tahakkuk_cek':
        sonuc = await handleTahakkukCek(job);
        break;
      case 'hizli_xml_indir':
        sonuc = await handleHizliXml(job);
        break;
      case 'hks_export':
      case 'hks_indir':
        sonuc = await handleHksExport(job);
        break;
      default:
        throw new Error('Bilinmeyen tip: ' + job.tip);
    }
    await finishJob(job.id, true, sonuc, null);
    console.log('job tamam', job.id);
  } catch (err) {
    console.error('job hata', job.id, err);
    await finishJob(job.id, false, null, err.message || String(err));
  }
}

function startHealthServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        wa: waClient ? waClient.status : 'kapali',
        ts: Date.now(),
      }),
    );
  });
  server.on('error', (err) => {
    console.warn('health server:', err.message);
  });
  server.listen(PORT, () => console.log('health :' + PORT));
}

async function loop() {
  console.log('musavirim-worker dinliyor…', { POLL_MS, DATA_DIR });
  for (;;) {
    try {
      const job = await claimJob();
      if (job) await processJob(job);
    } catch (err) {
      console.error('poll hata', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

await mkdir(DATA_DIR, { recursive: true });
await mkdir(path.join(DATA_DIR, 'whatsapp-auth'), { recursive: true });
startHealthServer();
loop();
