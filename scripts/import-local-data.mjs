import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { extractFirstExisting } from './extract-leveldb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'import-data');
fs.mkdirSync(outDir, { recursive: true });

function loadEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}
loadEnv();

const APPDATA = process.env.APPDATA || '';

function copyIfExists(src, name) {
  if (!fs.existsSync(src)) {
    console.log('yok:', src);
    return null;
  }
  const dest = path.join(outDir, name);
  fs.copyFileSync(src, dest);
  console.log('kopyalandi:', name, fs.statSync(dest).size, 'bytes');
  return dest;
}

function writeJson(name, data) {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2), 'utf8');
}

function dumpLocal() {
  const hks = extractFirstExisting(
    [
      path.join(APPDATA, 'musavirim/Partitions/musavirim-hks/Local Storage/leveldb/000003.log'),
      path.join(APPDATA, 'hks-bildirim-indirici/Local Storage/leveldb/000003.log'),
    ],
    'hksAccounts',
  );
  const mf = extractFirstExisting(
    [
      path.join(APPDATA, 'musavirim/Partitions/musavirim-mf/Local Storage/leveldb/000003.log'),
      path.join(APPDATA, 'muhasebe-fisi-olusturucu/Local Storage/leveldb/000003.log'),
    ],
    'mf_firmalar',
  );

  if (hks) {
    writeJson('hksAccounts.json', hks.value);
    console.log(
      'hksAccounts:',
      Array.isArray(hks.value) ? hks.value.length : typeof hks.value,
      Array.isArray(hks.value) ? hks.value.map((a) => a.firmaAdi) : '',
    );
  } else console.log('hksAccounts cikarilamadi');

  if (mf) {
    writeJson('mf_firmalar.json', mf.value);
    const names = Object.values(mf.value).map((f) => f?.name);
    const stok = Object.keys(Object.values(mf.value)[0]?.profile?.stokMap || {});
    console.log('mf_firmalar:', Object.keys(mf.value).length, names, 'stokKeys:', stok);
  } else console.log('mf_firmalar cikarilamadi');

  copyIfExists(path.join(APPDATA, 'musavirim/hizli-xml/kullanicilar.json'), 'hizli_kullanicilar.json');
  copyIfExists(path.join(APPDATA, 'musavirim/hizli-xml/config.json'), 'hizli_config.json');
  copyIfExists(path.join(APPDATA, 'hizli-xml-indirici/data/kullanicilar.json'), 'hizli_kullanicilar_legacy.json');
  copyIfExists(path.join(APPDATA, 'musavirim/stok-kontrol/settings.json'), 'stok_settings.json');
  copyIfExists(path.join(APPDATA, 'musavirim/tahakkuk/mukellefler.json'), 'tahakkuk_mukellefler.json');
  copyIfExists(path.join(APPDATA, 'musavirim/tahakkuk/son-cekim.json'), 'tahakkuk_son_cekim.json');
}

function readJson(name) {
  const p = path.join(outDir, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function summarize(arac, ayar) {
  if (arac === 'hizli_xml') {
    const u = ayar?.kullanicilar?.kullanicilar || [];
    return `users=${u.length}`;
  }
  if (arac === 'hks') return `accounts=${ayar?.accounts?.length ?? 0}`;
  if (arac === 'muhasebe_fisi') {
    const f = ayar?.firmalar || {};
    const n = typeof f === 'object' && !Array.isArray(f) ? Object.keys(f).length : 0;
    return `firmalar=${n}`;
  }
  if (arac === 'tahakkuk') {
    const m = ayar?.mukellefler?.mukellefler || ayar?.mukellefler || [];
    return `mukellef=${Array.isArray(m) ? m.length : '?'}`;
  }
  if (arac === 'stok_kontrol') return `settings=${ayar?.settings ? 'ok' : 'yok'}`;
  return '';
}

async function uploadToSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('.env icinde SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY gerekli');

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profiles, error: pErr } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('role', 'admin')
    .limit(1);
  if (pErr) throw pErr;
  const userId = profiles?.[0]?.id;
  if (!userId) throw new Error('Admin profil bulunamadi');

  const hizliUsers = readJson('hizli_kullanicilar.json') || readJson('hizli_kullanicilar_legacy.json');
  const mf = readJson('mf_firmalar.json');

  const bundle = {
    hizli_xml: {
      kullanicilar: hizliUsers,
      config: readJson('hizli_config.json'),
    },
    hks: { accounts: readJson('hksAccounts.json') },
    muhasebe_fisi: { firmalar: mf },
    stok_kontrol: { settings: readJson('stok_settings.json') },
    tahakkuk: {
      mukellefler: readJson('tahakkuk_mukellefler.json'),
      son_cekim: readJson('tahakkuk_son_cekim.json'),
    },
  };

  for (const [arac, ayar] of Object.entries(bundle)) {
    const { error } = await supabase.from('arac_ayarlari').upsert(
      {
        user_id: userId,
        arac,
        ayar,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,arac' },
    );
    if (error) throw error;
    console.log('supabase arac_ayarlari:', arac, summarize(arac, ayar));
  }

  const firmalar = [];
  const hizli = bundle.hizli_xml?.kullanicilar?.kullanicilar || [];
  for (const u of hizli) {
    const cfg = u.config || u;
    const ad = String(cfg.firmaAdi || u.ad || '').trim();
    const vkn = String(cfg.vkn || '').replace(/\D/g, '');
    if (ad) firmalar.push({ ad, vkn: vkn || null });
  }
  const muk = bundle.tahakkuk?.mukellefler?.mukellefler || [];
  for (const m of muk) {
    const ad = String(m.ad || '').trim();
    const vkn = String(m.vkn || '').replace(/\D/g, '');
    if (ad) firmalar.push({ ad, vkn: vkn || null });
  }
  if (mf && typeof mf === 'object') {
    for (const f of Object.values(mf)) {
      const ad = String(f?.name || '').trim();
      if (ad) firmalar.push({ ad, vkn: null });
    }
  }

  const seen = new Set();
  const unique = [];
  for (const f of firmalar) {
    const k = f.vkn || f.ad.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(f);
  }

  const { error: delErr } = await supabase
    .from('firmalar')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (delErr) console.warn('firmalar silme:', delErr.message);
  if (unique.length) {
    const { error: insErr } = await supabase.from('firmalar').insert(unique);
    if (insErr) throw insErr;
  }
  console.log('firmalar eklendi:', unique.length);
  console.log('TAMAM — kullanici:', userId);
}

const mode = process.argv[2] || 'all';
if (mode === 'dump' || mode === 'all') dumpLocal();
if (mode === 'upload' || mode === 'all') await uploadToSupabase();
