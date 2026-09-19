import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const childEnv = { ...process.env };
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (!m) continue;
  const k = m[1].trim();
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  childEnv[k] = v;
}
if (!childEnv.SUPABASE_URL && childEnv.VITE_SUPABASE_URL) {
  childEnv.SUPABASE_URL = childEnv.VITE_SUPABASE_URL;
}
childEnv.DATA_DIR = childEnv.DATA_DIR || path.join(__dirname, 'data');
childEnv.POLL_MS = childEnv.POLL_MS || '2000';
childEnv.PORT = childEnv.PORT || '8787';

const child = spawn(process.execPath, ['index.js'], {
  cwd: __dirname,
  env: childEnv,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code || 0));
