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
  const cloudRef = useRef({});
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setReady(false);
      setErr('');
      try {
        const { data, error } = await supabase
          .from('arac_ayarlari')
          .select('ayar')
          .eq('arac', meta.arac)
          .maybeSingle();
        if (error) throw error;
        const a = data?.ayar || {};
        if (cancelled) return;

        cloudRef.current = a;

        // Same-origin localStorage (MF / HKS native keys)
        if (meta.arac === 'muhasebe_fisi' && a.firmalar) {
          localStorage.setItem('mf_firmalar', JSON.stringify(a.firmalar));
        }
        if (meta.arac === 'hks' && a.accounts) {
          localStorage.setItem('hksAccounts', JSON.stringify(a.accounts));
        }

        setReady(true);
        setTick((t) => t + 1);
      } catch (e) {
        if (!cancelled) {
          setErr(e.message);
          cloudRef.current = {};
          setReady(true);
          setTick((t) => t + 1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toolId, meta.arac]);

  function injectCloudIntoIframe() {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const payload = cloudRef.current || {};
    try {
      win.__MUSAVIRIM_CLOUD__ = payload;
      win.sessionStorage.setItem('__MUSAVIRIM_CLOUD__', JSON.stringify(payload));
      win.postMessage({ type: 'musavirim-cloud-data', payload }, '*');
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    async function onMsg(ev) {
      if (!ev.data) return;

      if (ev.data.type === 'musavirim-cloud-request') {
        const win = iframeRef.current?.contentWindow;
        if (win) {
          win.postMessage({ type: 'musavirim-cloud-data', payload: cloudRef.current || {} }, '*');
        }
        return;
      }

      if (ev.data.type === 'musavirim-download-xml') {
        // Eski parent-indirme yolu; yeni akış iframe içinde (showSaveFilePicker).
        // Geriye dönük uyumluluk için bırakıldı.
        const { reqId, form } = ev.data;
        const reply = (result) => {
          if (iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              { type: 'musavirim-download-result', reqId, result },
              '*',
            );
          }
        };
        try {
          const res = await fetch('/api/hizli-xml-indir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form || {}),
          });
          const ctype = res.headers.get('content-type') || '';
          if (!res.ok) {
            let message = 'Indirme hatasi.';
            if (ctype.includes('application/json')) {
              const j = await res.json();
              message = j.message || message;
            } else {
              message = (await res.text()) || message;
            }
            reply({ ok: false, message });
            return;
          }
          const blob = await res.blob();
          const filename = res.headers.get('X-Filename') || 'xml-indir.zip';
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          reply({
            ok: true,
            xmlSayisi: Number(res.headers.get('X-Xml-Count') || 0),
            yeni: Number(res.headers.get('X-Xml-Yeni') || 0),
            message: 'ZIP Indirilenler klasorune kaydedildi.',
          });
        } catch (e) {
          reply({ ok: false, message: e.message || String(e) });
        }
        return;
      }

      if (ev.data.type !== 'musavirim-save') return;
      const { arac, payload } = ev.data;
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      cloudRef.current = payload;
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
      {err && (
        <div className="error-text" style={{ padding: '8px 16px' }}>
          {err}
        </div>
      )}
      {!ready && <div className="center-screen">Veriler yükleniyor…</div>}
      {iframeSrc && (
        <iframe
          ref={iframeRef}
          title={meta.title}
          src={iframeSrc}
          className="tool-iframe"
          onLoad={injectCloudIntoIframe}
        />
      )}
    </div>
  );
}
