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

  async start() {
    if (this.status === 'hazir' && this.sock) {
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

      const b = await loadBaileys();
      const makeSocket = b.makeWASocket || b.default;
      const useAuth = b.useMultiFileAuthState;
      const reason = b.DisconnectReason;
      const Browsers = b.Browsers;
      const fetchLatestBaileysVersion = b.fetchLatestBaileysVersion;

      if (typeof makeSocket !== 'function' || typeof useAuth !== 'function') {
        throw new Error('WhatsApp kutuphanesi yuklenemedi.');
      }

      const { state, saveCreds } = await useAuth(this.authDir);

      // Surumu en fazla 3 sn bekle; gelmezse paket varsayilani
      let version;
      if (typeof fetchLatestBaileysVersion === 'function') {
        try {
          const v = await withTimeout(fetchLatestBaileysVersion(), 3000, null);
          if (v && v.version) version = v.version;
        } catch (_) { /* ignore */ }
      }

      if (this.sock) {
        try { this.sock.end(undefined); } catch (_) { /* ignore */ }
        this.sock = null;
      }

      this.status = 'baglaniyor';
      this.emit('state', this.getState());

      const sock = makeSocket({
        auth: state,
        version,
        printQRInTerminal: false,
        logger: silentLogger(),
        browser: (Browsers && Browsers.appropriate)
          ? Browsers.appropriate('Desktop')
          : (Browsers && Browsers.macOS)
            ? Browsers.macOS('Desktop')
            : ['Mac OS', 'Chrome', '14.4.1'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 20000,
        defaultQueryTimeoutMs: 20000,
        keepAliveIntervalMs: 15000,
        getMessage: async () => undefined,
      });
      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        try {
          const { connection, lastDisconnect, qr } = update || {};

          if (qr) {
            this._reconnectCount = 0;
            try {
              this.lastQrDataUrl = await QRCode.toDataURL(String(qr), {
                margin: 1,
                width: 260,
                errorCorrectionLevel: 'M',
              });
              this.status = 'qr';
              this.lastError = '';
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
            this.emit('state', this.getState());
          }

          if (connection === 'close') {
            const errObj = lastDisconnect?.error;
            const code = errObj?.output?.statusCode || errObj?.statusCode;
            const errMsg = errObj?.message || String(errObj || 'baglanti koptu');
            const loggedOut = code === reason?.loggedOut;
            this.sock = null;
            this.userName = '';

            if (this._intentionalStop || loggedOut) {
              this.status = 'kapali';
              this.lastQrDataUrl = null;
              this.lastError = loggedOut ? 'Oturum kapatildi / cihaz cikarildi' : '';
              this.emit('state', this.getState());
              return;
            }

            this._reconnectCount += 1;
            this.lastError = `Kopma (${code || '?'}): ${errMsg}`;

            // 8 denemeden sonra dur — sonsuz dongu kullaniciyi kilitliyor
            if (this._reconnectCount >= 8) {
              this.status = 'hata';
              this.lastError = `Karekod alinamadi. ${this.lastError}. Oturumu Kapat → tekrar Baglan.`;
              this.emit('state', this.getState());
              return;
            }

            this.status = 'baglaniyor';
            this.emit('state', this.getState());
            if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
            this._reconnectTimer = setTimeout(() => {
              this.starting = false;
              this.start().catch((err) => {
                this.status = 'hata';
                this.lastError = err.message;
                this.emit('state', this.getState());
              });
            }, 1500);
          }
        } catch (err) {
          this.status = 'hata';
          this.lastError = err.message;
          this.emit('state', this.getState());
        }
      });

      await this._waitForQrOrReady(15000);
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
    try {
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
      }
    } catch (_) { /* ignore */ }
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
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = `90${d.slice(1)}`;
  if (d.length === 10 && d.startsWith('5')) d = `90${d}`;
  if (d.length < 11) return '';
  return `${d}@s.whatsapp.net`;
}

module.exports = { WhatsappClient, toJid, prefetchBaileys };
