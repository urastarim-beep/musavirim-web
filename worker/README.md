# Muşavirim Worker (Railway / VPS)

Sürekli açık Node süreci. Supabase `jobs` tablosunu dinler.

## Railway

1. Yeni proje → bu `worker` klasörünü root yapın (veya monorepo root + start command).
2. Env:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Start: `npm start`
4. Volume ekleyin (WhatsApp auth için): `/app/data`

## Yerel

```bash
cd worker
npm install
set SUPABASE_URL=...
set SUPABASE_SERVICE_ROLE_KEY=...
npm start
```
