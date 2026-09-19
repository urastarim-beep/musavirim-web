import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';

const NAV = [
  { to: '/', label: 'Ana Sayfa', end: true, icon: '⌂' },
  { to: '/firmalar', label: 'Firmalar', icon: '☰' },
  { to: '/hks', label: 'HKS Bildirim', icon: '◈' },
  { to: '/hizli-xml', label: 'Hızlı XML', icon: '⇩' },
  { to: '/muhasebe-fisi', label: 'Muhasebe Fişi', icon: '▣' },
  { to: '/uyumsoft-unideva', label: 'Uyumsoft → Unideva', icon: '⇄' },
  { to: '/stok-kontrol', label: 'Stok Kontrol', icon: '▦' },
  { to: '/tahakkuk', label: 'Tahakkuk Makbuz', icon: '▤' },
];

export default function HubLayout({ profile }) {
  const navigate = useNavigate();

  async function cikis() {
    await supabase.auth.signOut();
    navigate('/');
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="logo" src="/icon.png" alt="Muşavirim" width="42" height="42" />
          <div>
            <strong>Muşavirim</strong>
            <span>{profile.ad_soyad}</span>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="nav-text">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <button type="button" className="sifre-toggle" onClick={cikis}>
          Çıkış Yap
        </button>
      </aside>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
