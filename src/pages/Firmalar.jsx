import React, { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

export default function Firmalar() {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    supabase
      .from('firmalar')
      .select('id, ad, vkn, created_at')
      .order('ad')
      .then(({ data, error }) => {
        if (error) setErr(error.message);
        else setRows(data || []);
      });
  }, []);

  return (
    <div className="tool-page">
      <header className="tool-header">
        <h1>Firmalar</h1>
        <p>Masaüstünden aktarılan firmalar / mükellefler ({rows.length})</p>
      </header>
      {err && <div className="error-text">{err}</div>}
      <div className="job-list">
        <ul>
          {rows.map((r) => (
            <li key={r.id}>
              <span className="job-tip">{r.ad}</span>
              <span className="job-time">{r.vkn || '—'}</span>
            </li>
          ))}
        </ul>
        {!rows.length && <p className="muted">Henüz firma yok.</p>}
      </div>
    </div>
  );
}
