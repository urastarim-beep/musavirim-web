import React, { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';

const TOOL_META = {
  hks: { arac: 'hks', src: '/tools/hks/index.html', title: 'HKS Bildirim' },
  'hizli-xml': { arac: 'hizli_xml', src: '/tools/hizli-xml/index.html', title: 'Hızlı XML' },
  'muhasebe-fisi': { arac: 'muhasebe_fisi', src: '/tools/muhasebe-fisi/index.html', title: 'Muhasebe Fişi' },
  'uyumsoft-unideva': { arac: 'uyumsoft', src: '/tools/uyumsoft-unideva/index.html', title: 'Uyumsoft → Unideva' },
  'stok-kontrol': { arac: 'stok_kontrol', src: '/tools/stok-kontrol/index.html', title: 'Stok Kontrol' },
  tahakkuk: { arac: 'tahakkuk', src: '/tools/tahakkuk/index.html', title: 'Tahakkuk Makbuz' },
};

export default function ToolEmbed({ toolId }) {
  const meta = TOOL_META[toolId];
  const iframeRef = useRef(null);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setReady(false);
      setErr('');
      try {
        const { data: { user } } = await supabase.auth.getUser();
        const { data, error } = await supabase
          .from('arac_ayarlari')
          .select('ayar')
          .eq('arac', meta.arac)
          .maybeSingle();
        if (error) throw error;
        const a = data?.ayar || {};
        if (cancelled) return;

        if (meta.arac === 'muhasebe_fisi' && a.firmalar) {
          localStorage.setItem('mf_firmalar', JSON.stringify(a.firmalar));
        }
        if (meta.arac === 'hks' && a.accounts) {
          localStorage.setItem('hksAccounts', JSON.stringify(a.accounts));
        }

        // iframe scripts read this before boot
        sessionStorage.setItem('__MUSAVIRIM_CLOUD__', JSON.stringify(a));
        setReady(true);
        setTick((t) => t + 1);
      } catch (e) {
        if (!cancelled) {
          setErr(e.message);
          sessionStorage.setItem('__MUSAVIRIM_CLOUD__', '{}');
          setReady(true);
          setTick((t) => t + 1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toolId, meta.arac]);

  useEffect(() => {
    async function onMsg(ev) {
      if (!ev.data || ev.data.type !== 'musavirim-save') return;
      const { arac, payload } = ev.data;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from('arac_ayarlari').upsert(
        { user_id: user.id, arac, ayar: payload, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,arac' },
      );
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const iframeSrc = useMemo(() => {
    if (!ready) return null;
    return `${meta.src}?v=${tick}`;
  }, [ready, meta.src, tick]);

  if (!meta) return <div className="tool-page">Bilinmeyen araç</div>;

  return (
    <div className="tool-embed">
      <div className="tool-embed-bar">
        <strong>{meta.title}</strong>
        <span className="muted">Masaüstü arayüzü · veriler bulutta</span>
      </div>
      {err && <div className="error-text" style={{ padding: '8px 16px' }}>{err}</div>}
      {!ready && <div className="center-screen">Veriler yükleniyor…</div>}
      {iframeSrc && (
        <iframe
          ref={iframeRef}
          title={meta.title}
          src={iframeSrc}
          className="tool-iframe"
        />
      )}
    </div>
  );
}
