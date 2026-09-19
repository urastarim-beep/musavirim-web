# Muşavirim Worker

Sürekli açık Node süreci. Supabase `jobs` kuyruğunu işler.

## Ne yapar?

| Job tipi | İş |
|----------|-----|
| `wa_start` | WhatsApp QR → `whatsapp_durum` tablosu |
| `wa_gonder` | Metin / görsel gönder |
| `wa_logout` | Oturumu kapat |
| `tahakkuk_cek` | EBYN (+ opsiyonel IVD) sorgu |
| `hizli_xml_indir` | Portal XML ZIP |
| `hks_export` | HKS oturum cookie ile bildirim sayfası |

## Railway kurulum

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub (`musavirim-web`)
2. **Root Directory:** `worker`
3. Variables:
   - `SUPABASE_URL` = `https://xxxx.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = service role key
   - `DATA_DIR` = `/data`
   - `POLL_MS` = `3000`
4. Volume ekle: mount `/data` (WhatsApp auth kalıcı olsun)
5. Deploy → health `https://<railway-url>/` → `{"ok":true}`

## Yerel çalıştırma

```bash
cd worker
npm install
npx playwright install chromium

# PowerShell
$env:SUPABASE_URL="https://...."
$env:SUPABASE_SERVICE_ROLE_KEY="...."
npm start
```

## Web tarafı

Araçlar `createJob` ile kuyruğa yazar; worker alır. WhatsApp QR için `whatsapp_durum` satırını dinleyin.
