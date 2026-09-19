import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

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
const outDir = path.join(root, 'import-data');
fs.mkdirSync(outDir, { recursive: true });

function extractLocalStorage(logPath, key) {
  if (!fs.existsSync(logPath)) return null;
  const buf = fs.readFileSync(logPath);

  // Chromium Local Storage often stores strings as UTF-16LE
  const keyUtf16 = Buffer.alloc(key.length * 2);
  for (let i = 0; i < key.length; i++) {
    keyUtf16.writeUInt16LE(key.charCodeAt(i), i * 2);
  }
  let idx = buf.indexOf(keyUtf16);
  let text = null;
  if (idx >= 0) {
    text = buf.slice(idx).toString('utf16le');
  } else {
    // fallback: strip nulls from utf8 misread
    text = buf.toString('utf8').replace(/\0/g, '');
    if (!text.includes(key)) return null;
  }

  const keyPos = text.indexOf(key);
  if (keyPos < 0) return null;
  let start = -1;
  for (let i = keyPos + key.length; i < text.length; i++) {
    if (text[i] === '[' || text[i] === '{') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  let raw = text.slice(start, end + 1);
  // LevelDB/UTF-16 artifacts: drop non-printable control chars
  raw = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn('JSON parse:', key, e.message, 'snippet:', JSON.stringify(raw.slice(0, 60)));
    return null;
  }
}

function copyIfExists(src, name) {
  if (!fs.existsSync(src)) {
    console.log('yok:', src);
    return null;
  }
  const dest = path.join(outDir, name);
  fs.copyFileSync(src, dest);
  console.log('kopyalandi:', name);
  return dest;
}

function dumpLocal() {
  const hksLog = path.join(
    APPDATA,
    'musavirim/Partitions/musavirim-hks/Local Storage/leveldb/000003.log',
  );
  const mfLog = path.join(
    APPDATA,
    'musavirim/Partitions/musavirim-mf/Local Storage/leveldb/000003.log',
  );

  const hks = extractLocalStorage(hksLog, 'hksAccounts');
  const mf = extractLocalStorage(mfLog, 'mf_firmalar');
  if (hks) {
    fs.writeFileSync(path.join(outDir, 'hksAccounts.json'), JSON.stringify(hks, null, 2));
    console.log('hksAccounts:', Array.isArray(hks) ? hks.length : typeof hks);
  } else console.log('hksAccounts cikarilamadi');
  if (mf) {
    fs.writeFileSync(path.join(outDir, 'mf_firmalar.json'), JSON.stringify(mf, null, 2));
    console.log('mf_firmalar: ok');
  } else console.log('mf_firmalar cikarilamadi');

  copyIfExists(path.join(APPDATA, 'musavirim/hizli-xml/kullanicilar.json'), 'hizli_kullanicilar.json');
  copyIfExists(path.join(APPDATA, 'musavirim/hizli-xml/config.json'), 'hizli_config.json');
  copyIfExists(path.join(APPDATA, 'musavirim/stok-kontrol/settings.json'), 'stok_settings.json');
  copyIfExists(path.join(APPDATA, 'musavirim/tahakkuk/mukellefler.json'), 'tahakkuk_mukellefler.json');
  copyIfExists(path.join(APPDATA, 'musavirim/tahakkuk/son-cekim.json'), 'tahakkuk_son_cekim.json');
}

function readJson(name) {
  const p = path.join(outDir, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function uploadToSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('.env icinde SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY gerekli');

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Admin user id from profiles
  const { data: profiles, error: pErr } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('role', 'admin')
    .limit(1);
  if (pErr) throw pErr;
  const userId = profiles?.[0]?.id;
  if (!userId) throw new Error('Admin profil bulunamadi — once profiles insert yap');

  const bundle = {
    hizli_xml: {
      kullanicilar: readJson('hizli_kullanicilar.json'),
      config: readJson('hizli_config.json'),
    },
    hks: { accounts: readJson('hksAccounts.json') },
    muhasebe_fisi: { firmalar: readJson('mf_firmalar.json') },
    stok_kontrol: { settings: readJson('stok_settings.json') },
    tahakkuk: {
      mukellefler: readJson('tahakkuk_mukellefler.json'),
      son_cekim: readJson('tahakkuk_son_cekim.json'),
    },
  };

  // Upsert each tool into arac_ayarlari
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
    console.log('supabase arac_ayarlari:', arac);
  }

  // Also populate firmalar from hizli profiles + tahakkuk mukellefler
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
  // dedupe by vkn or ad
  const seen = new Set();
  const unique = [];
  for (const f of firmalar) {
    const k = f.vkn || f.ad.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(f);
  }

  // clear+insert firmalar for clean import (admin only project)
  const { error: delErr } = await supabase.from('firmalar').delete().neq('id', '00000000-0000-0000-0000-000000000000');
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
if (mode === 'upload' || mode === 'all') {
  await uploadToSupabase();
}
