'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const QRCode = require('qrcode');

let baileysPromise = null;
function loadBaileys() {
  if (!baileysPromise) {
    baileysPromise = import('@whiskeysockets/baileys').then((m) => m).catch((err) => {
      baileysPromise = null;
      throw err;
    });
  }
  return baileysPromise;
}

function prefetchBaileys() {
  return loadBaileys().catch(() => null);
}

function silentLogger() {
  const noop = () => {};
  const child = () => silentLogger();
  return {
    level: 'silent',
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child,
  };
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * Ofis WhatsApp oturumu — QR ile baglan, makbuz/medya gonder.
 */
class WhatsappClient extends EventEmitter {
  constructor(authDir) {
    super();
    this.authDir = authDir;
    this.sock = null;
    this.status = 'kapali';
    this.lastQrDataUrl = null;
    this.starting = false;
    this.userName = '';
    this.lastError = '';
    this._reconnectTimer = null;
    this._intentionalStop = false;
    this._reconnectCount = 0;
  }

  getState() {
    return {
      status: this.status,
      qrDataUrl: this.lastQrDataUrl,
      userName: this.userName,
      hazir: this.status === 'hazir',
      hata: this.lastError || undefined,
    };
  }

  _wipeAuthDir() {
    try {
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
      }
    } catch (_) { /* ignore */ }
    try {
      fs.mkdirSync(this.authDir, { recursive: true });
    } catch (_) { /* ignore */ }
  }

  /**
   * @param {{ fresh?: boolean }} [opts] fresh=true yarim kalmis oturumu siler (telefon "cihaz baglanamadi" icin)
   */
  async start(opts = {}) {
    if (this.status === 'hazir' && this.sock && !opts.fresh) {
      this.emit('state', this.getState());
      return this.getState();
    }
    if (this.starting) return this.getState();
    this.starting = true;
    this._intentionalStop = false;
    this.lastError = '';

    try {
      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      // Bagli degilken Baglan: eski/yarim creds telefonu dusuruyor → temiz basla
      if (opts.fresh || (this.status !== 'hazir' && opts.fresh !== false)) {
        if (opts.fresh || this.status === 'hata' || this.status === 'qr' || this.status === 'baglaniyor' || this.status === 'kapali') {
          // Sadece henuz kayitli oturum yoksa veya fresh istendiğinde sil
          // registered kontrolü asagida auth yuklendikten sonra
        }
      }

      const b = await loadBaileys();
      const makeSocket = b.makeWASocket || b.default;
      const useAuth = b.useMultiFileAuthState;
      const reason = b.DisconnectReason;
      const Browsers = b.Browsers;
      const fetchLatestBaileysVersion = b.fetchLatestBaileysVersion;

      if (typeof makeSocket !== 'function' || typeof useAuth !== 'function') {
        throw new Error('WhatsApp kutuphanesi yuklenemedi.');
      }

      if (opts.fresh) {
        this._wipeAuthDir();
      }

      let { state, saveCreds } = await useAuth(this.authDir);
      const registered = !!(state?.creds?.registered || state?.creds?.me);
      if (!registered && (opts.fresh || this.status !== 'hazir')) {
        // Yarim kalmis dosyalar QR pairing'i bozar
        const files = fs.existsSync(this.authDir) ? fs.readdirSync(this.authDir) : [];
        if (files.length > 0 && !registered) {
          console.log('wa: yarim auth temizleniyor', files.length, 'dosya');
          this._wipeAuthDir();
          ({ state, saveCreds } = await useAuth(this.authDir));
        }
      }

      let version;
      if (typeof fetchLatestBaileysVersion === 'function') {
        try {
          const v = await withTimeout(fetchLatestBaileysVersion(), 12000, null);
          if (v && v.version) {
            version = v.version;
            console.log('wa: version', version.join('.'), 'latest=', !!v.isLatest);
          }
        } catch (e) {
          console.warn('wa: version fetch', e.message);
        }
      }

      if (this.sock) {
        try { this.sock.end(undefined); } catch (_) { /* ignore */ }
        this.sock = null;
      }

      this.status = 'baglaniyor';
      this.emit('state', this.getState());

      // Ubuntu/Chrome — WhatsApp "cihaz baglanamadi" icin en stabil fingerprint
      const browser =
        Browsers && typeof Browsers.ubuntu === 'function'
          ? Browsers.ubuntu('Chrome')
          : Browsers && typeof Browsers.macOS === 'function'
            ? Browsers.macOS('Chrome')
            : ['Ubuntu', 'Chrome', '22.04.4'];

      const sockOpts = {
        auth: state,
        printQRInTerminal: false,
        logger: silentLogger(),
        browser,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 500,
        getMessage: async () => undefined,
      };
      if (version) sockOpts.version = version;

      const sock = makeSocket(sockOpts);
      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        try {
          const { connection, lastDisconnect, qr } = update || {};

          if (qr) {
            this._reconnectCount = 0;
            try {
              this.lastQrDataUrl = await QRCode.toDataURL(String(qr), {
                margin: 2,
                width: 320,
                errorCorrectionLevel: 'M',
              });
              this.status = 'qr';
              this.lastError = '';
              console.log('wa: yeni karekod');
              this.emit('state', this.getState());
            } catch (err) {
              this.status = 'hata';
              this.lastError = err.message;
              this.emit('state', this.getState());
            }
          }

          if (connection === 'open') {
            this._reconnectCount = 0;
            this.status = 'hazir';
            this.lastQrDataUrl = null;
            this.lastError = '';
            this.userName = sock.user?.name || sock.user?.id || 'bagli';
            console.log('wa: baglandi', this.userName);
            this.emit('state', this.getState());
          }

          if (connection === 'close') {
            const errObj = lastDisconnect?.error;
            const code = errObj?.output?.statusCode || errObj?.statusCode;
            const errMsg = errObj?.message || String(errObj || 'baglanti koptu');
            const loggedOut = code === reason?.loggedOut;
            const badSession = code === reason?.badSession;
            const restartRequired = code === reason?.restartRequired;
            console.warn('wa: close', code, errMsg);

            this.sock = null;
            this.userName = '';

            if (this._intentionalStop || loggedOut) {
              this.status = 'kapali';
              this.lastQrDataUrl = null;
              this.lastError = loggedOut ? 'Oturum kapatildi / cihaz cikarildi' : '';
              if (loggedOut || badSession) this._wipeAuthDir();
              this.emit('state', this.getState());
              return;
            }

            if (badSession) {
              this._wipeAuthDir();
            }

            this._reconnectCount += 1;
            this.lastError = `Kopma (${code || '?'}): ${errMsg}`;

            if (this._reconnectCount >= 8) {
              this.status = 'hata';
              this.lastError = `Baglanti kurulamadi (${code || '?'}). Oturumu Kapat → tekrar Baglan. Telefonda Linked Devices'tan eski "Chrome/Ubuntu" cihazlari sil.`;
              this.emit('state', this.getState());
              return;
            }

            this.status = restartRequired || badSession ? 'baglaniyor' : 'baglaniyor';
            this.emit('state', this.getState());
            if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
            this._reconnectTimer = setTimeout(() => {
              this.starting = false;
              this.start({ fresh: badSession }).catch((err) => {
                this.status = 'hata';
                this.lastError = err.message;
                this.emit('state', this.getState());
              });
            }, restartRequired ? 800 : 1500);
          }
        } catch (err) {
          this.status = 'hata';
          this.lastError = err.message;
          this.emit('state', this.getState());
        }
      });

      await this._waitForQrOrReady(25000);
      return this.getState();
    } catch (err) {
      this.status = 'hata';
      this.lastError = err && err.message ? err.message : String(err);
      this.emit('state', this.getState());
      throw err;
    } finally {
      this.starting = false;
    }
  }

  _waitForQrOrReady(ms) {
    if (this.status === 'qr' || this.status === 'hazir' || this.status === 'hata') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const onState = (s) => {
        if (s.status === 'qr' || s.status === 'hazir' || s.status === 'hata') {
          cleanup();
          resolve();
        }
      };
      const t = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const cleanup = () => {
        clearTimeout(t);
        this.off('state', onState);
      };
      this.on('state', onState);
    });
  }

  async logout() {
    this._intentionalStop = true;
    this._reconnectCount = 0;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try {
      if (this.sock) await this.sock.logout();
    } catch (_) { /* ignore */ }
    this.sock = null;
    this.status = 'kapali';
    this.lastQrDataUrl = null;
    this.userName = '';
    this.lastError = '';
    this._wipeAuthDir();
    this.emit('state', this.getState());
    return this.getState();
  }

  stop() {
    this._intentionalStop = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try {
      if (this.sock) this.sock.end(undefined);
    } catch (_) { /* ignore */ }
    this.sock = null;
    if (this.status === 'hazir') this.status = 'kapali';
    this.emit('state', this.getState());
  }

  async sendImage(telefon, pngBuffer) {
    if (this.status !== 'hazir' || !this.sock) {
      throw new Error('WhatsApp bagli degil. Once karekodu okut.');
    }
    const jid = toJid(telefon);
    if (!jid) throw new Error('Gecerli telefon numarasi gerekli (05xx...).');

    const digits = jid.replace('@s.whatsapp.net', '');
    let target = jid;
    try {
      if (typeof this.sock.onWhatsApp === 'function') {
        const results = await this.sock.onWhatsApp(digits);
        const result = Array.isArray(results) ? results[0] : results;
        if (result && result.exists === false) {
          throw new Error('Bu numara WhatsApp kullanmiyor.');
        }
        if (result && result.jid) target = result.jid;
      }
    } catch (err) {
      if (/WhatsApp kullanmiyor/i.test(err.message)) throw err;
    }

    await this.sock.sendMessage(target, { image: pngBuffer });
    return { ok: true, jid: target };
  }

  async sendDocument(telefon, filePathOrBuf, fileName, mimetype = 'application/pdf') {
    if (this.status !== 'hazir' || !this.sock) {
      throw new Error('WhatsApp bagli degil. Once karekodu okut.');
    }
    const jid = toJid(telefon);
    if (!jid) throw new Error('Gecerli telefon numarasi gerekli (05xx...).');

    let target = jid;
    const digits = jid.replace('@s.whatsapp.net', '');
    try {
      if (typeof this.sock.onWhatsApp === 'function') {
        const results = await this.sock.onWhatsApp(digits);
        const result = Array.isArray(results) ? results[0] : results;
        if (result && result.exists === false) {
          throw new Error('Bu numara WhatsApp kullanmiyor.');
        }
        if (result && result.jid) target = result.jid;
      }
    } catch (err) {
      if (/WhatsApp kullanmiyor/i.test(err.message)) throw err;
    }

    const buf = Buffer.isBuffer(filePathOrBuf)
      ? filePathOrBuf
      : fs.readFileSync(filePathOrBuf);
    const name = fileName || (Buffer.isBuffer(filePathOrBuf) ? 'tahakkuk.pdf' : path.basename(filePathOrBuf));

    await this.sock.sendMessage(target, {
      document: buf,
      mimetype,
      fileName: name,
    });
    return { ok: true, jid: target, fileName: name };
  }

  async sendText(telefon, text) {
    if (this.status !== 'hazir' || !this.sock) {
      throw new Error('WhatsApp bagli degil. Once karekodu okut.');
    }
    const jid = toJid(telefon);
    if (!jid) throw new Error('Gecerli telefon numarasi gerekli.');
    await this.sock.sendMessage(jid, { text: String(text || '') });
    return { ok: true, jid };
  }
}

function toJid(telefon) {
  let d = String(telefon || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0')) d = '90' + d.slice(1);
  if (d.length === 10) d = '90' + d;
  return `${d}@s.whatsapp.net`;
}

module.exports = { WhatsappClient, toJid, prefetchBaileys };
