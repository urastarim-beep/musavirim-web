import React, { useEffect, useState } from 'react';
import { createJob, listJobs } from '../../lib/jobs';

export function ToolShell({ title, lead, children }) {
  return (
    <div className="tool-page">
      <header className="tool-header">
        <h1>{title}</h1>
        {lead && <p>{lead}</p>}
      </header>
      <div className="tool-body">{children}</div>
    </div>
  );
}

export function JobList({ tip }) {
  const [jobs, setJobs] = useState([]);
  const [err, setErr] = useState('');

  async function yenile() {
    try {
      const all = await listJobs(30);
      setJobs(tip ? all.filter((j) => j.tip === tip) : all);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    yenile();
    const t = setInterval(yenile, 5000);
    return () => clearInterval(t);
  }, [tip]);

  return (
    <div className="job-list">
      <div className="job-list-head">
        <h2>İş kuyruğu</h2>
        <button type="button" className="btn ghost" onClick={yenile}>Yenile</button>
      </div>
      {err && <div className="error-text">{err}</div>}
      {!jobs.length && <p className="muted">Henüz iş yok.</p>}
      <ul>
        {jobs.map((j) => (
          <li key={j.id}>
            <span className={`badge badge-${j.durum}`}>{j.durum}</span>
            <span className="job-tip">{j.tip}</span>
            <span className="job-time">{new Date(j.created_at).toLocaleString('tr-TR')}</span>
            {j.hata_mesaji && <span className="error-text">{j.hata_mesaji}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export async function enqueue(tip, payload) {
  return createJob(tip, payload);
}
