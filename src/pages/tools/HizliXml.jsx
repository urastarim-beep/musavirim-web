import React, { useState } from 'react';
import { ToolShell, JobList, enqueue } from './_shared';

export default function HizliXml() {
  const [apiKey, setApiKey] = useState('');
  const [baslangic, setBaslangic] = useState('');
  const [bitis, setBitis] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function baslat(e) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const job = await enqueue('hizli_xml_indir', { apiKey, baslangic, bitis });
      setMsg(`İş kuyruğa alındı: ${job.id.slice(0, 8)}…`);
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolShell
      title="Hızlı XML"
      lead="e-Fatura / e-Arşiv indirme işi worker üzerinden çalışır."
    >
      <form className="tool-form" onSubmit={baslat}>
        <label>API / entegrasyon anahtarı</label>
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
        <label>Başlangıç tarihi</label>
        <input type="date" value={baslangic} onChange={(e) => setBaslangic(e.target.value)} required />
        <label>Bitiş tarihi</label>
        <input type="date" value={bitis} onChange={(e) => setBitis(e.target.value)} required />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Gönderiliyor…' : 'İndirmeyi başlat'}
        </button>
        {msg && <p className="muted">{msg}</p>}
      </form>
      <JobList tip="hizli_xml_indir" />
    </ToolShell>
  );
}
