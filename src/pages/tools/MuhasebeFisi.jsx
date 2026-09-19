import React, { useState } from 'react';
import { ToolShell } from './_shared';

export default function MuhasebeFisi() {
  const [fileName, setFileName] = useState('');
  const [note, setNote] = useState('');

  function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setNote('Dosya seçildi. Tarayıcıda tam dönüştürücü bir sonraki adımda eklenecek; şimdilik dosya adı kaydedildi.');
  }

  return (
    <ToolShell
      title="Muhasebe Fişi"
      lead="XML / fatura dosyasını muhasebe fişine dönüştürün (istemci tarafı)."
    >
      <div className="tool-form">
        <label>Dosya seç</label>
        <input type="file" accept=".xml,.xlsx,.xls,.csv" onChange={onFile} />
        {fileName && <p className="muted">Seçilen: {fileName}</p>}
        {note && <p className="muted">{note}</p>}
      </div>
    </ToolShell>
  );
}
