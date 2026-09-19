import React, { useState } from 'react';
import { ToolShell, JobList, enqueue } from './_shared';

export default function Hks() {
  const [vkn, setVkn] = useState('');
  const [kullanici, setKullanici] = useState('');
  const [sifre, setSifre] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function baslat(e) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const job = await enqueue('hks_indir', { vkn, kullanici, sifre });
      setMsg(`İş kuyruğa alındı: ${job.id.slice(0, 8)}… Worker işleyince sonuç burada görünür.`);
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolShell
      title="HKS Bildirim"
      lead="İndirme işi bulut worker’da (Playwright) çalışır. Bilgileri girip kuyruğa alın."
    >
      <form className="tool-form" onSubmit={baslat}>
        <label>VKN / TCKN</label>
        <input value={vkn} onChange={(e) => setVkn(e.target.value)} required />
        <label>Kullanıcı</label>
        <input value={kullanici} onChange={(e) => setKullanici(e.target.value)} required />
        <label>Şifre</label>
        <input type="password" value={sifre} onChange={(e) => setSifre(e.target.value)} required />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Gönderiliyor…' : 'İndirmeyi başlat'}
        </button>
        {msg && <p className="muted">{msg}</p>}
      </form>
      <JobList tip="hks_indir" />
    </ToolShell>
  );
}
