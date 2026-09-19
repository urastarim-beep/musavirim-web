import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { supabase, supabaseConfigured } from './supabaseClient';
import Login from './pages/Login';
import HubLayout from './layout/HubLayout';
import Home from './pages/Home';
import Firmalar from './pages/Firmalar';
import ToolEmbed from './pages/ToolEmbed';

function SetupHint() {
  return (
    <div className="center-screen">
      <div className="login-card">
        <h1>Muşavirim</h1>
        <p className="setup-hint">
          Supabase ayarları eksik. <code>.env</code> dosyasına
          {' '}<code>VITE_SUPABASE_URL</code> ve <code>VITE_SUPABASE_ANON_KEY</code> ekleyin.
        </p>
      </div>
    </div>
  );
}

function ToolRoute() {
  const { toolId } = useParams();
  return <ToolEmbed toolId={toolId} />;
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
          <Route path="/firmalar" element={<Firmalar />} />
          <Route path="/:toolId" element={<ToolRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
