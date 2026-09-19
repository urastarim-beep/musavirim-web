import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';

const HATIRLA_KEY = 'musavirim_hatirla_eposta';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [beniHatirla, setBeniHatirla] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const kayitli = localStorage.getItem(HATIRLA_KEY);
    if (kayitli) setEmail(kayitli);
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) {
      setError('Giriş başarısız: e-posta veya şifre hatalı.');
      return;
    }
    if (beniHatirla) localStorage.setItem(HATIRLA_KEY, email);
    else localStorage.removeItem(HATIRLA_KEY);
  }

  return (
    <div className="center-screen login-bg">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">
          <img src="/icon.png" alt="" width="48" height="48" />
          <div>
            <h1>Muşavirim</h1>
            <p>Bulut araç platformu</p>
          </div>
        </div>
        <label>E-posta</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
        <label>Şifre</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={beniHatirla}
            onChange={(e) => setBeniHatirla(e.target.checked)}
          />
          Beni hatırla
        </label>
        {error && <div className="error-text">{error}</div>}
        <button type="submit" className="primary" disabled={loading}>
          {loading ? 'Giriş yapılıyor…' : 'Giriş Yap'}
        </button>
      </form>
    </div>
  );
}
