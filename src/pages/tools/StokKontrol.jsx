import React, { useState } from 'react';
import { ToolShell } from './_shared';

export default function StokKontrol() {
  const [fileName, setFileName] = useState('');
  const [msg, setMsg] = useState('');

  function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setMsg('XML seçildi. Stok karşılaştırma motoru bir sonraki sprintte eklenecek.');
  }

  return (
    <ToolShell
      title="Stok Kontrol"
      lead="XML dosyalarından stok kontrolü (istemci tarafı)."
    >
      <div className="tool-form">
        <label>XML dosyası</label>
        <input type="file" accept=".xml,.zip" onChange={onFile} />
        {fileName && <p className="muted">Seçilen: {fileName}</p>}
        {msg && <p className="muted">{msg}</p>}
      </div>
    </ToolShell>
  );
}
