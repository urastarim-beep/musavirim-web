import React, { useEffect, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { ToolShell, JobList, enqueue } from './_shared';

export default function Tahakkuk({ profile }) {
  const [telefon, setTelefon] = useState('');
  const [metin, setMetin] = useState('');
  const [wa, setWa] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (profile.role !== 'admin') return;
    supabase
      .from('whatsapp_durum')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data }) => setWa(data));
  }, [profile.role]);

  async function gonder(e) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const job = await enqueue('wa_gonder', { telefon, metin });
      setMsg(`WhatsApp işi kuyruğa alındı: ${job.id.slice(0, 8)}…`);
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolShell
      title="Tahakkuk Makbuz"
      lead="Makbuz / mesaj gönderimi WhatsApp worker üzerinden yapılır."
    >
      {profile.role === 'admin' && (
        <div className="status-card">
          <strong>WhatsApp durumu</strong>
          <p className="muted">
            {wa?.bagli ? 'Bağlı' : 'Bağlı değil'}
            {wa?.mesaj ? ` — ${wa.mesaj}` : ''}
          </p>
          {wa?.qr_data && (
            <p className="muted">QR bekleniyor (worker ekranından / tablodan).</p>
          )}
        </div>
      )}

      <form className="tool-form" onSubmit={gonder}>
        <label>Telefon (90…)</label>
        <input value={telefon} onChange={(e) => setTelefon(e.target.value)} required />
        <label>Mesaj</label>
        <textarea rows={4} value={metin} onChange={(e) => setMetin(e.target.value)} required />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Gönderiliyor…' : 'WhatsApp kuyruğuna ekle'}
        </button>
        {msg && <p className="muted">{msg}</p>}
      </form>
      <JobList tip="wa_gonder" />
    </ToolShell>
  );
}
