import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { supabase, supabaseConfigured } from './supabaseClient';
import Login from './pages/Login';
import HubLayout from './layout/HubLayout';
import Home from './pages/Home';
import Hks from './pages/tools/Hks';
import HizliXml from './pages/tools/HizliXml';
import MuhasebeFisi from './pages/tools/MuhasebeFisi';
import Uyumsoft from './pages/tools/Uyumsoft';
import StokKontrol from './pages/tools/StokKontrol';
import Tahakkuk from './pages/tools/Tahakkuk';

function SetupHint() {
  return (
    <div className="center-screen">
      <div className="login-card">
        <h1>Muşavirim</h1>
        <p className="setup-hint">
          Supabase ayarları eksik. <code>.env</code> dosyasına
          {' '}<code>VITE_SUPABASE_URL</code> ve <code>VITE_SUPABASE_ANON_KEY</code> ekleyin.
          Ayrıntılar için README.md.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    if (!supabaseConfigured) {
      setSession(null);
      return;
    }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      return;
    }
    supabase
      .from('profiles')
      .select('role, ad_soyad')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        setProfile({
          id: session.user.id,
          email: session.user.email,
          role: data?.role || 'personel',
          ad_soyad: data?.ad_soyad || session.user.email?.split('@')[0] || 'Kullanıcı',
        });
      });
  }, [session]);

  if (!supabaseConfigured) {
    return <SetupHint />;
  }

  if (session === undefined) {
    return <div className="center-screen">Yükleniyor…</div>;
  }

  if (!session) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<Login />} />
        </Routes>
      </BrowserRouter>
    );
  }

  if (!profile) {
    return <div className="center-screen">Yükleniyor…</div>;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<HubLayout profile={profile} />}>
          <Route path="/" element={<Home profile={profile} />} />
          <Route path="/hks" element={<Hks profile={profile} />} />
          <Route path="/hizli-xml" element={<HizliXml profile={profile} />} />
          <Route path="/muhasebe-fisi" element={<MuhasebeFisi profile={profile} />} />
          <Route path="/uyumsoft-unideva" element={<Uyumsoft profile={profile} />} />
          <Route path="/stok-kontrol" element={<StokKontrol profile={profile} />} />
          <Route path="/tahakkuk" element={<Tahakkuk profile={profile} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
