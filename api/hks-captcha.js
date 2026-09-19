/**
 * HKS captcha + form alanları (aynı sayfa anlık görüntüsü).
 * Login bu form + cookie ile yapılmalı; yeniden GET captcha'yı bozar.
 */
const LOGIN_URL = 'https://hks.hal.gov.tr/Pages/Account/Login.aspx';
const BASE = 'https://hks.hal.gov.tr/Pages/Account/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function mergeCookies(existing, setCookieList) {
  const map = new Map();
  for (const part of String(existing || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const raw of setCookieList || []) {
    if (!raw) continue;
    const first = String(raw).split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) map.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function pickSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const one = res.headers.get('set-cookie');
  return one ? [one] : [];
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractCaptchaSrc(html) {
  const patterns = [
    /id="[^"]*CaptchaImage"[^>]*src="([^"]+)"/i,
    /src="([^"]*BotDetectCaptcha\.ashx\?get=image[^"]*)"/i,
    /src='([^']*BotDetectCaptcha\.ashx\?get=image[^']*)'/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtml(m[1]);
  }
  return null;
}

function absUrl(src) {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/')) return 'https://hks.hal.gov.tr' + src;
  return BASE + src.replace(/^\.\//, '');
}

function extractInputs(html) {
  const fields = {};
  for (const m of html.matchAll(/<input[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/\bname="([^"]+)"/i) || [])[1];
    if (!name) continue;
    const value = decodeHtml((tag.match(/\bvalue="([^"]*)"/i) || [])[1] || '');
    fields[name] = value;
  }
  return fields;
}

async function fetchCaptchaSession() {
  const loginRes = await fetch(LOGIN_URL, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!loginRes.ok) {
    throw new Error('HKS login sayfasi acilamadi: HTTP ' + loginRes.status);
  }
  let cookies = mergeCookies('', pickSetCookies(loginRes));
  const html = await loginRes.text();
  const fields = extractInputs(html);
  const src = extractCaptchaSrc(html);
  if (!src) throw new Error('Captcha gorseli bulunamadi (sayfa yapisi degismis olabilir).');

  const imgUrl = absUrl(src);
  const imgRes = await fetch(imgUrl, {
    headers: {
      'User-Agent': UA,
      Accept: 'image/*,*/*',
      Referer: LOGIN_URL,
      Cookie: cookies,
    },
  });
  if (!imgRes.ok) {
    throw new Error('Captcha resmi indirilemedi: HTTP ' + imgRes.status);
  }
  cookies = mergeCookies(cookies, pickSetCookies(imgRes));
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const ctype = imgRes.headers.get('content-type') || 'image/jpeg';
  const captcha = `data:${ctype};base64,${buf.toString('base64')}`;

  return {
    captcha,
    cookie: cookies,
    form: {
      action: LOGIN_URL,
      fields,
      usernameField: 'ctl02$ctl00$txtUserName',
      passwordField: 'ctl02$ctl00$txtPassword',
      captchaField: 'ctl02$ctl00$txtCaptchaCodeTextBox',
      submitField: 'ctl02$ctl00$btnLogin',
      submitValue: fields['ctl02$ctl00$btnLogin'] || 'Giriş',
    },
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ success: false, message: 'POST/GET gerekli' });
    return;
  }

  try {
    // Her captcha isteği taze oturum — önceki cookie ile GET captcha'yı bozar
    const session = await fetchCaptchaSession();
    res.status(200).json({
      success: true,
      captcha: session.captcha,
      cookie: session.cookie,
      form: session.form,
    });
  } catch (err) {
    console.error('[hks-captcha]', err);
    res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 30,
};
