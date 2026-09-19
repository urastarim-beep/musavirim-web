import { createRequire } from 'module';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const { portalGetir, resolveIndirmeParams } = require('../server/hizli-xml/lib/portal/index.cjs');

export const config = {
  api: {
    bodyParser: { sizeLimit: '2mb' },
    responseLimit: false,
  },
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'POST gerekli' });
    return;
  }

  const tmpRoot = path.join(os.tmpdir(), 'musavirim-hizli', String(Date.now()));

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    fs.mkdirSync(tmpRoot, { recursive: true });

    const params = resolveIndirmeParams({
      ...body,
      indirmeKlasoru: tmpRoot,
    });

    const portalId = String(params.portal || 'hizli').toLowerCase();
    const portal = portalGetir(portalId);
    if (!portal || typeof portal.indirFatura !== 'function') {
      res.status(400).json({ ok: false, message: 'Portal bulunamadi: ' + portalId });
      return;
    }

    const result = await portal.indirFatura(params, {
      onLog: () => {},
    });

    const klasor = result.klasor || tmpRoot;
    const zip = new AdmZip();
    let fileCount = 0;
    function addDir(dir, prefix = '') {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) addDir(full, path.join(prefix, name));
        else if (/\.(xml|zip)$/i.test(name)) {
          zip.addLocalFile(full, prefix);
          fileCount += 1;
        }
      }
    }
    addDir(klasor);

    if (fileCount === 0 && !(result.xmlSayisi > 0)) {
      res.status(404).json({
        ok: false,
        message: result.message || 'Indirilecek XML bulunamadi (donem/filtreyi kontrol edin).',
      });
      return;
    }

    const zipBuf = zip.toBuffer();
    const firma = String(params.firmaAdi || params.vkn || 'xml')
      .replace(/[^\w\-ğüşıöçĞÜŞİÖÇ ]+/gi, '_')
      .slice(0, 40)
      .trim() || 'xml';
    const filename = `${firma}_${params.yil || ''}-${String(params.ay || '').padStart(2, '0')}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Xml-Count', String(result.xmlSayisi || fileCount));
    res.setHeader('X-Xml-Yeni', String(result.yeni || fileCount));
    res.setHeader('Access-Control-Expose-Headers', 'X-Xml-Count, X-Xml-Yeni, Content-Disposition');
    res.status(200).send(zipBuf);
  } catch (err) {
    console.error('[hizli-xml-indir]', err);
    res.status(500).json({
      ok: false,
      message: err.message || String(err),
    });
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
