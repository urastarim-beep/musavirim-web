import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { ToolShell } from './_shared';

export default function Uyumsoft() {
  const [rows, setRows] = useState(0);
  const [msg, setMsg] = useState('');

  function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const wb = XLSX.read(reader.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        setRows(data.length);
        setMsg(`Okundu: ${wb.SheetNames[0]} — ${data.length} satır. Eşleştirme motoru sonraki adımda eklenecek.`);
      } catch (err) {
        setMsg(err.message);
      }
    };
    reader.readAsArrayBuffer(f);
  }

  return (
    <ToolShell
      title="Uyumsoft → Unideva"
      lead="Excel eşleştirmesini tarayıcıda yapın; çıktıyı indirin."
    >
      <div className="tool-form">
        <label>Excel dosyası</label>
        <input type="file" accept=".xlsx,.xls" onChange={onFile} />
        {rows > 0 && <p className="muted">{rows} satır yüklendi.</p>}
        {msg && <p className="muted">{msg}</p>}
      </div>
    </ToolShell>
  );
}
