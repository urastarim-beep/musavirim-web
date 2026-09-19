/**
 * Chromium LevelDB localStorage extractor.
 * Values are usually UTF-16LE JSON; early writes may be latin1.
 * Prefer the last/longest UTF-16 parse (correct Turkish: İ Ş ğ ü…).
 */
import fs from 'fs';

function parseJsonValue(text) {
  const openCh = text[0];
  if (openCh !== '{' && openCh !== '[') return null;
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let j = 0; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === openCh) depth += 1;
    else if (c === closeCh) {
      depth -= 1;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    return { parsed: JSON.parse(text.slice(0, end + 1)), len: end + 1 };
  } catch {
    return null;
  }
}

function score(parsed) {
  const s = JSON.stringify(parsed);
  return (
    s.length +
    (s.includes('stokMap') ? 50000 : 0) +
    (s.includes('cariMap') ? 20000 : 0) +
    (s.includes('profile') ? 10000 : 0) +
    (s.includes('password') ? 5000 : 0) +
    (s.includes('firmaAdi') ? 3000 : 0)
  );
}

/**
 * @param {string} logPath
 * @param {string} key localStorage key e.g. mf_firmalar
 * @returns {any|null}
 */
export function extractLocalStorage(logPath, key) {
  if (!fs.existsSync(logPath)) return null;
  const buf = fs.readFileSync(logPath);
  const keyB = Buffer.from(key, 'utf8');
  const candidates = [];

  let idx = 0;
  while ((idx = buf.indexOf(keyB, idx)) >= 0) {
    const from = idx + keyB.length;
    for (let i = from; i < Math.min(from + 48, buf.length - 1); i++) {
      // UTF-16LE JSON start: {\\0 or [\\0
      if ((buf[i] === 0x7b || buf[i] === 0x5b) && buf[i + 1] === 0x00) {
        const text = buf.slice(i, Math.min(buf.length, i + 400000)).toString('utf16le');
        const got = parseJsonValue(text);
        if (got) {
          candidates.push({
            enc: 'utf16',
            idx,
            len: got.len,
            parsed: got.parsed,
            score: score(got.parsed) + 100000, // prefer utf16
          });
        }
        break;
      }
      // latin1 / utf8 JSON
      if (buf[i] === 0x7b || buf[i] === 0x5b) {
        if (buf[i + 1] === 0x00) continue; // handled above
        const text = buf.slice(i, Math.min(buf.length, i + 400000)).toString('latin1');
        const got = parseJsonValue(text);
        if (got) {
          candidates.push({
            enc: 'latin1',
            idx,
            len: got.len,
            parsed: got.parsed,
            score: score(got.parsed),
          });
        }
        break;
      }
    }
    idx += keyB.length;
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.idx - a.idx);
  return candidates[0].parsed;
}

export function extractFirstExisting(paths, key) {
  for (const p of paths) {
    const v = extractLocalStorage(p, key);
    if (v != null) return { path: p, value: v };
  }
  return null;
}
