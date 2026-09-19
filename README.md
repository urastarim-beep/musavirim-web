# Muşavirim Bulut (Vercel + Supabase + Worker)

Masaüstü Muşavirim hub’ının bulut sürümü. Çek programı (`cek-fis-web`) ile aynı model:

- **Vercel** — Vite + React arayüz (girişli)
- **Supabase** — Auth, Postgres, Storage
- **Railway / VPS worker** — HKS (Playwright), WhatsApp (Baileys), uzun işler

## 1. Supabase

1. [supabase.com](https://supabase.com) → yeni proje `musavirim` (çek projesinden ayrı tutun).
2. **SQL Editor** → [`supabase/schema.sql`](supabase/schema.sql) içeriğini çalıştırın.
3. **Authentication → Users → Add user** ile admin oluşturun (Auto Confirm).
4. UUID’yi kopyalayıp SQL’de:

```sql
insert into profiles (id, role, ad_soyad)
values ('ADMIN-UUID', 'admin', 'Uras Tarım');
```

5. **Project Settings → API** anahtarlarını alın.

## 2. Yerel çalıştırma

```bash
cd musavirim-web
copy .env.example .env
# .env içini doldurun
npm install
npm run dev
```

## 3. Vercel

1. Bu repo’yu GitHub’a push edin.
2. vercel.com → Import → Framework: Vite.
3. Environment Variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (sadece server/api için; anon’u tarayıcıya koyun)
4. Deploy.

## 4. Worker (HKS / WhatsApp / Tahakkuk)

[`worker/README.md`](worker/README.md) — Railway’de sürekli süreç.

1. Railway → GitHub `musavirim-web` → **Root Directory: `worker`**
2. Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATA_DIR=/data`
3. Volume mount: `/data` (WhatsApp oturumu)
4. Deploy sonrası site: Tahakkuk → Ayarlar → Bağlan (QR), Sorgula; HKS giriş sonrası export job’a düşer

Yerel: `cd worker && npm install && npm start` (aynı env).

## Araçlar

| Araç | Bulut durumu |
|------|----------------|
| HKS | Captcha + giriş (API); export → worker Playwright |
| Hızlı XML | Vercel API + worker (ZIP) |
| Muhasebe Fişi | Tam UI + bulut kayıt |
| Uyumsoft → Unideva | İstemci dönüştürücü |
| Stok Kontrol | UI (motor worker/sonraki) |
| Tahakkuk / WA | EBYN/IVD + Baileys QR → worker |

Masaüstü `Musavirim.exe` geçiş süresince yedek olarak kalabilir.
