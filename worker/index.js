/**
 * Muşavirim Worker — Railway / VPS üzerinde sürekli çalışır.
 * Jobs tablosundan bekleyen işleri alır; HKS / WhatsApp / XML işler.
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   POLL_MS (opsiyonel, varsayılan 4000)
 */
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POLL_MS = Number(process.env.POLL_MS || 4000);

if (!url || !key) {
  console.error('SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY gerekli.');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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

async function handleHks(job) {
  // Playwright entegrasyonu: masaüstü apps/hks mantığı buraya taşınacak.
  // Şimdilik iskelet — job payload doğrulanır ve sonuç yazılır.
  const { vkn, kullanici } = job.payload || {};
  if (!vkn || !kullanici) throw new Error('vkn ve kullanici gerekli');

  // Placeholder: gerçek HKS otomasyonu sonraki adımda bağlanacak
  return {
    not: 'HKS Playwright otomasyonu worker iskeletine bağlanacak',
    vkn,
    kullanici,
  };
}

async function handleHizliXml(job) {
  const { apiKey, baslangic, bitis } = job.payload || {};
  if (!apiKey) throw new Error('apiKey gerekli');
  return {
    not: 'Hızlı XML API indirme worker iskeletine bağlanacak',
    baslangic,
    bitis,
  };
}

async function handleWa(job) {
  const { telefon, metin } = job.payload || {};
  if (!telefon || !metin) throw new Error('telefon ve metin gerekli');

  await supabase
    .from('whatsapp_durum')
    .upsert({
      id: 1,
      bagli: false,
      mesaj: 'Baileys oturumu henüz bağlanmadı — QR eşleme sonraki adım',
      son_guncelleme: new Date().toISOString(),
    });

  return {
    not: 'Baileys gönderimi worker iskeletine bağlanacak',
    telefon,
  };
}

async function processJob(job) {
  console.log('job', job.id, job.tip);
  try {
    let sonuc;
    switch (job.tip) {
      case 'hks_indir':
        sonuc = await handleHks(job);
        break;
      case 'hizli_xml_indir':
        sonuc = await handleHizliXml(job);
        break;
      case 'wa_gonder':
        sonuc = await handleWa(job);
        break;
      default:
        throw new Error('Bilinmeyen tip: ' + job.tip);
    }
    await finishJob(job.id, true, sonuc, null);
  } catch (err) {
    console.error(err);
    await finishJob(job.id, false, null, err.message || String(err));
  }
}

async function loop() {
  console.log('musavirim-worker dinliyor…');
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

await mkdir(path.join(process.cwd(), 'data'), { recursive: true });
await writeFile(path.join(process.cwd(), 'data', '.keep'), '');
loop();
