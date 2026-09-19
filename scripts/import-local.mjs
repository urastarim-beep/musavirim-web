/**
 * Yerel Electron AppData → Supabase aktarım
 * Çalıştır: node scripts/import-local.mjs
 *
 * .env içinde SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY gerekir.
 * ADMIN_USER_ID: Authentication'daki admin UUID
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) throw new Error('.env yok');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    process.env[m[1]] = m[2].trim();
  }
}

loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '9a0fddc6-0692-4a08-b592-974fb99ab5d0';

if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY eksik');

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const musavirim = path.join(appData, 'musavirim');

function okuJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function upsertArac(arac, ayar) {
  const { error } = await supabase.from('arac_ayarlari').upsert(
    {
      user_id: ADMIN_USER_ID,
      arac,
      ayar,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,arac' },
  );
  if (error) throw error;
}

async function importHizliXml() {
  const store = okuJson(path.join(musavirim, 'hizli-xml', 'kullanicilar.json'));
  const config = okuJson(path.join(musavirim, 'hizli-xml', 'config.json')) || {};
  if (!store?.kullanicilar?.length) {
    console.log('Hızlı XML: yerel veri yok');
    return { firmalar: 0, hesaplar: 0 };
  }

  let firmaSayisi = 0;
  for (const ham of store.kullanicilar) {
    const cfg = ham.config || ham;
    const ad = String(cfg.firmaAdi || ham.ad || 'Firma').trim();
    const vkn = String(cfg.vkn || '').replace(/\D/g, '') || null;

    let firmaId = null;
    if (vkn) {
      const { data: mevcut } = await supabase
        .from('firmalar')
        .select('id')
        .eq('vkn', vkn)
        .maybeSingle();
      if (mevcut?.id) {
        firmaId = mevcut.id;
        await supabase.from('firmalar').update({ ad }).eq('id', firmaId);
      }
    }
    if (!firmaId) {
      const { data: created, error } = await supabase
        .from('firmalar')
        .insert({ ad, vkn })
        .select('id')
        .single();
      if (error) throw error;
      firmaId = created.id;
      firmaSayisi += 1;
    }

    await supabase.from('firma_uyeleri').upsert(
      { firma_id: firmaId, user_id: ADMIN_USER_ID },
      { onConflict: 'firma_id,user_id' },
    );
  }

  await upsertArac('hizli-xml', {
    aktifKullaniciId: store.aktifKullaniciId || null,
    kullanicilar: store.kullanicilar,
    config,
    kaynak: 'local-import',
    aktarimTarihi: new Date().toISOString(),
  });

  console.log(`Hızlı XML: ${store.kullanicilar.length} hesap, ~${firmaSayisi} yeni firma`);
  return { firmalar: firmaSayisi, hesaplar: store.kullanicilar.length };
}

async function importStok() {
  const settings = okuJson(path.join(musavirim, 'stok-kontrol', 'settings.json'));
  if (!settings) {
    console.log('Stok: yerel ayar yok');
    return;
  }
  await upsertArac('stok-kontrol', {
    settings,
    kaynak: 'local-import',
    aktarimTarihi: new Date().toISOString(),
  });
  console.log('Stok: settings aktarıldı');
}

async function main() {
  console.log('Aktarım başlıyor…', { url, admin: ADMIN_USER_ID });
  await importHizliXml();
  await importStok();
  console.log('Bitti.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
