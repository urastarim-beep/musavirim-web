import React from 'react';
import { useNavigate } from 'react-router-dom';

const TOOLS = [
  { to: '/hks', icon: '◈', title: 'HKS Bildirim', desc: 'Hal kayıt sisteminden bildirim indir' },
  { to: '/hizli-xml', icon: '⇩', title: 'Hızlı XML', desc: 'e-Fatura ve e-Arşiv XML toplu indir' },
  { to: '/muhasebe-fisi', icon: '▣', title: 'Muhasebe Fişi', desc: 'Faturayı muhasebe fişine dönüştür' },
  { to: '/uyumsoft-unideva', icon: '⇄', title: 'Uyumsoft → Unideva', desc: 'Format dönüşümü ve aktarım' },
  { to: '/stok-kontrol', icon: '▦', title: 'Stok Kontrol', desc: 'Stok ve envanter kontrolleri' },
  { to: '/tahakkuk', icon: '▤', title: 'Tahakkuk Makbuz', desc: 'Makbuz işlemleri ve WhatsApp' },
];

export default function Home({ profile }) {
  const navigate = useNavigate();

  return (
    <div className="welcome">
      <div className="welcome-bg" aria-hidden="true" />
      <div className="welcome-inner">
        <header className="welcome-hero">
          <p className="welcome-kicker">Merhaba, {profile.ad_soyad}</p>
          <h1>Muşavirim</h1>
          <p className="welcome-lead">
            Mali müşavir araçlarınız bulutta. Bir araç seçerek başlayın.
          </p>
        </header>

        <div className="welcome-grid" role="list">
          {TOOLS.map((t, i) => (
            <button
              key={t.to}
              type="button"
              className="welcome-card"
              style={{ '--i': i }}
              onClick={() => navigate(t.to)}
            >
              <span className="welcome-card-mark" aria-hidden="true">{t.icon}</span>
              <span className="welcome-card-title">{t.title}</span>
              <span className="welcome-card-desc">{t.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
