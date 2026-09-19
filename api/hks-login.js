/**
 * HKS ASP.NET login — captcha ile alınan cookie + form alanlarıyla POST.
 */
const LOGIN_URL = 'https://hks.hal.gov.tr/Pages/Account/Login.aspx';
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

function encodeForm(fields) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : String(v)));
  }
  return parts.join('&');
}

function loginFailedMessage(html, finalUrl) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ');
  const patterns = [
    /([Gg]üvenlik\s*[Kk]odu[^.!\n]{0,40})/,
    /([Kk]ullan[ıi]c[ıi]\s*ad[ıi]\s*veya\s*[şs]ifre[^.!\n]{0,40})/,
    /([Hh]atal[ıi]\s*[Gg]iri[şs][^.!\n]{0,60})/,
    /([Cc]aptcha[^.!\n]{0,40})/,
    /(BotDetect[^.!\n]{0,40})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  if (/Login\.aspx/i.test(finalUrl)) return 'Giris basarisiz. Kullanici, sifre veya guvenlik kodunu kontrol edin.';
  return 'Giris basarisiz.';
}

function looksLoggedIn(url, html) {
  if (/AnaSayfasi|Bildirimci|Default\.aspx/i.test(url) && !/Login\.aspx/i.test(url)) return true;
  if (/Ho[şs]geldin|Ç[ıi]k[ıi][şs]\s*Yap|Logout/i.test(html) && !/txtCaptchaCodeTextBox/i.test(html)) {
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'POST gerekli' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const captcha = String(body.captcha || '').trim();
    const cookie = String(body.cookie || '');
    const form = body.form || {};

    if (!username || !password || !captcha) {
      res.status(400).json({ success: false, message: 'Kullanici adi, sifre ve guvenlik kodu gerekli.' });
      return;
    }
    if (!cookie || !form.fields) {
      res.status(400).json({
        success: false,
        message: 'Oturum suresi doldu. Guvenlik kodunu Yenile ile yeniden alin.',
      });
      return;
    }

    const fields = { ...form.fields };
    const userField = form.usernameField || 'ctl02$ctl00$txtUserName';
    const passField = form.passwordField || 'ctl02$ctl00$txtPassword';
    const captchaField = form.captchaField || 'ctl02$ctl00$txtCaptchaCodeTextBox';
    const submitField = form.submitField || 'ctl02$ctl00$btnLogin';
    const submitValue = form.submitValue || fields[submitField] || 'Giriş';

    fields[userField] = username;
    fields[passField] = password;
    fields[captchaField] = captcha;
    fields[submitField] = submitValue;
    // ASP.NET postback
    if (!('__EVENTTARGET' in fields)) fields.__EVENTTARGET = '';
    if (!('__EVENTARGUMENT' in fields)) fields.__EVENTARGUMENT = '';

    const action = form.action || LOGIN_URL;
    const postRes = await fetch(action, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml',
        Origin: 'https://hks.hal.gov.tr',
        Referer: LOGIN_URL,
        Cookie: cookie,
      },
      body: encodeForm(fields),
      redirect: 'manual',
    });

    let cookies = mergeCookies(cookie, pickSetCookies(postRes));
    let status = postRes.status;
    let location = postRes.headers.get('location') || '';
    let html = '';

    // 302/301 takip (manuel — cookie biriktir)
    let hops = 0;
    let currentUrl = action;
    while ((status === 301 || status === 302 || status === 303 || status === 307) && hops < 8) {
      hops += 1;
      if (!location) break;
      const nextUrl = location.startsWith('http')
        ? location
        : new URL(location, currentUrl).href;
      const hopRes = await fetch(nextUrl, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          Cookie: cookies,
          Referer: currentUrl,
        },
        redirect: 'manual',
      });
      cookies = mergeCookies(cookies, pickSetCookies(hopRes));
      status = hopRes.status;
      location = hopRes.headers.get('location') || '';
      currentUrl = nextUrl;
      if (status >= 200 && status < 300) {
        html = await hopRes.text();
        break;
      }
    }

    if (!html && status >= 200 && status < 300) {
      html = await postRes.text();
      currentUrl = action;
    } else if (!html && location) {
      // son konum
      currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
    }

    // Hâlâ login sayfasındaysak gövdeyi oku
    if (!html && status >= 200 && status < 400) {
      try {
        html = await postRes.text();
      } catch {
        /* ignore */
      }
    }

    if (looksLoggedIn(currentUrl, html)) {
      res.status(200).json({
        success: true,
        message: 'Giris basarili.',
        cookie: cookies,
        url: currentUrl,
      });
      return;
    }

    // Bazen 200 ile login sayfası döner
    if (/txtCaptchaCodeTextBox|BotDetectCaptcha/i.test(html) || /Login\.aspx/i.test(currentUrl)) {
      res.status(200).json({
        success: false,
        message: loginFailedMessage(html, currentUrl),
        cookie: cookies,
      });
      return;
    }

    // Belirsiz ama cookie güncellendi — başarılı say
    if (cookies.includes('ASP.NET_SessionId') && hops > 0 && !/Login\.aspx/i.test(currentUrl)) {
      res.status(200).json({
        success: true,
        message: 'Giris basarili.',
        cookie: cookies,
        url: currentUrl,
      });
      return;
    }

    res.status(200).json({
      success: false,
      message: loginFailedMessage(html, currentUrl),
      cookie: cookies,
    });
  } catch (err) {
    console.error('[hks-login]', err);
    res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
  maxDuration: 30,
};
