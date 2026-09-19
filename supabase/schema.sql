-- ============================================
-- MUŞAVİRİM BULUT — Supabase şeması
-- Dashboard > SQL Editor'de çalıştırın
-- ============================================

create extension if not exists "uuid-ossp";

-- ---------- Firmalar ----------
create table if not exists firmalar (
  id uuid primary key default uuid_generate_v4(),
  ad text not null,
  vkn text,
  created_at timestamptz default now()
);

-- ---------- Profiller ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'personel')),
  ad_soyad text,
  created_at timestamptz default now()
);

-- ---------- Firma üyeleri (personel hangi firmaları görür) ----------
create table if not exists firma_uyeleri (
  id uuid primary key default uuid_generate_v4(),
  firma_id uuid not null references firmalar(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  unique (firma_id, user_id)
);

-- ---------- Worker iş kuyruğu (HKS, WhatsApp, XML vb.) ----------
create table if not exists jobs (
  id uuid primary key default uuid_generate_v4(),
  tip text not null,
  durum text not null default 'bekliyor'
    check (durum in ('bekliyor', 'calisiyor', 'tamam', 'hata', 'iptal')),
  payload jsonb not null default '{}'::jsonb,
  sonuc jsonb,
  hata_mesaji text,
  user_id uuid not null references auth.users(id) on delete cascade,
  firma_id uuid references firmalar(id) on delete set null,
  created_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists idx_jobs_durum_created on jobs (durum, created_at);
create index if not exists idx_jobs_user on jobs (user_id, created_at desc);

-- ---------- Araç ayarları / kimlik bilgileri (şifreli değil — RLS ile koru) ----------
create table if not exists arac_ayarlari (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  arac text not null,
  ayar jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  unique (user_id, arac)
);

-- ---------- WhatsApp oturum durumu (worker yazar) ----------
create table if not exists whatsapp_durum (
  id int primary key default 1,
  bagli boolean default false,
  qr_data text,
  son_guncelleme timestamptz default now(),
  mesaj text
);
insert into whatsapp_durum (id) values (1) on conflict (id) do nothing;

-- ---------- Yardımcı: admin mi? ----------
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function can_access_firma(p_firma_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select is_admin()
    or exists (
      select 1 from firma_uyeleri
      where firma_id = p_firma_id and user_id = auth.uid()
    );
$$;

-- ============================================
-- RLS
-- ============================================
alter table firmalar enable row level security;
alter table profiles enable row level security;
alter table firma_uyeleri enable row level security;
alter table jobs enable row level security;
alter table arac_ayarlari enable row level security;
alter table whatsapp_durum enable row level security;

-- profiles
create policy "profil kendi kaydini gorur" on profiles
  for select using (id = auth.uid() or is_admin());

create policy "admin profil gunceller" on profiles
  for update using (is_admin());

-- firmalar
create policy "firma erisim" on firmalar
  for select using (is_admin() or can_access_firma(id));

create policy "admin firma yazar" on firmalar
  for all using (is_admin());

-- firma_uyeleri
create policy "uye kendi kayitlarini gorur" on firma_uyeleri
  for select using (user_id = auth.uid() or is_admin());

create policy "admin uye yonetir" on firma_uyeleri
  for all using (is_admin());

-- jobs
create policy "job kendi veya admin" on jobs
  for select using (user_id = auth.uid() or is_admin());

create policy "job ekle" on jobs
  for insert with check (user_id = auth.uid());

create policy "job kendi guncelle" on jobs
  for update using (user_id = auth.uid() or is_admin());

-- arac_ayarlari
create policy "ayar kendi" on arac_ayarlari
  for all using (user_id = auth.uid() or is_admin());

-- whatsapp_durum — sadece admin okur
create policy "wa admin okur" on whatsapp_durum
  for select using (is_admin());

create policy "wa admin yazar" on whatsapp_durum
  for update using (is_admin());

-- ============================================
-- STORAGE: Dashboard > Storage'dan private bucket oluşturun: musavirim-dosyalar
-- Sonra aşağıdaki politikaları çalıştırın.
-- ============================================

-- create policy "dosya yukleme"
--   on storage.objects for insert
--   with check (
--     bucket_id = 'musavirim-dosyalar'
--     and auth.role() = 'authenticated'
--   );
--
-- create policy "dosya okuma"
--   on storage.objects for select
--   using (
--     bucket_id = 'musavirim-dosyalar'
--     and auth.role() = 'authenticated'
--   );
