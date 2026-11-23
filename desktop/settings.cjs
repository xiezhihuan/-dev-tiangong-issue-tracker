// 设置的读写与校验。普通设置存 config.json；密码和 AppSecret 用系统提供的加密（macOS 钥匙串 / Windows DPAPI）后存 secrets.json。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { configured: false, qqAppId: '', skipQQ: false, scope: 'lan', port: 8787, publicUrl: '', notify: true, autostart: true, keepAwake: true, ocr: true, mergeMinutes: 5 };
const SECRETS = ['adminPassword', 'qqSecret'];

class SettingsError extends Error { constructor(message, field) { super(message); this.field = field; } }
const fail = (m, f) => { throw new SettingsError(m, f); };

/** 去掉易混字符的 12 位随机密码。 */
const randomPassword = () => Array.from(crypto.randomBytes(12), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

function normalizeUrl(raw) {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  if (!v.includes('://')) v = 'https://' + v;
  let u;
  try { u = new URL(v); } catch { return fail('外网地址格式不对，应形如 https://fb.example.com', 'publicUrl'); }
  if (!/^https?:$/.test(u.protocol) || !u.host) fail('外网地址须以 http:// 或 https:// 开头', 'publicUrl');
  if (u.pathname !== '/' || u.search || u.hash) fail('外网地址只填到域名，不要带路径', 'publicUrl');
  return u.origin;
}

class Settings {
  /** @param crypt { encrypt(string): Buffer, decrypt(Buffer): string } */
  constructor(home, crypt) {
    this.home = home; this.crypt = crypt;
    this.file = path.join(home, 'config.json'); this.secretFile = path.join(home, 'secrets.json');
    this.secretError = '';
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    this.load();
  }
  read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
  write(file, v) { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
  load() {
    const raw = this.read(this.file) ?? {};
    this.v = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw).filter(([k, x]) => k in DEFAULTS && typeof x === typeof DEFAULTS[k])) };
    this.secrets = {};
    const enc = this.read(this.secretFile) ?? {};
    for (const k of SECRETS) if (enc[k]) try { this.secrets[k] = this.crypt.decrypt(Buffer.from(enc[k], 'base64')); } catch (e) { this.secretError = `读取已保存的密钥失败：${e.message}`; }
  }
  /** 给界面看的，不含密钥明文。 */
  view() { return { ...this.v, hasPassword: !!this.secrets.adminPassword, hasSecret: !!this.secrets.qqSecret, secretError: this.secretError }; }

  save(patch) {
    const n = { ...this.v }, s = { ...this.secrets };
    for (const [k, x] of Object.entries(patch)) {
      if (SECRETS.includes(k)) { if (typeof x === 'string' && x) s[k] = k === 'qqSecret' ? x.trim() : x; } // 留空 = 不改
      else if (k in DEFAULTS && typeof x === typeof DEFAULTS[k]) n[k] = x;
      else fail(`不支持的设置：${k}`);
    }
    n.qqAppId = n.qqAppId.trim();
    if (!n.skipQQ) {
      if (!/^\d{5,}$/.test(n.qqAppId)) fail('请填写 AppID（一串数字）；暂时没有可以勾选「暂不连接 QQ」', 'qqAppId');
      if (!s.qqSecret) fail('请填写 AppSecret', 'qqSecret');
    }
    if (!s.adminPassword || s.adminPassword.length < 8) fail('登录密码至少 8 位', 'adminPassword');
    if (!['lan', 'local'].includes(n.scope)) fail('访问范围无效', 'scope');
    if (!Number.isInteger(n.port) || n.port < 1024 || n.port > 65535) fail('端口须是 1024–65535 的整数', 'port');
    if (!Number.isInteger(n.mergeMinutes) || n.mergeMinutes < 0 || n.mergeMinutes > 120) fail('合并时间须是 0–120 的整数', 'mergeMinutes');
    n.publicUrl = normalizeUrl(n.publicUrl);
    if (n.publicUrl && s.adminPassword.length < 12) fail('开放外网访问时，登录密码至少 12 位', 'adminPassword');
    const enc = Object.fromEntries(SECRETS.filter((k) => s[k]).map((k) => [k, this.crypt.encrypt(s[k]).toString('base64')]));
    this.write(this.secretFile, enc); this.write(this.file, n);
    this.v = n; this.secrets = s; this.secretError = '';
  }

  get dataDir() { return path.join(this.home, 'data'); }
  /** 启动服务用的环境变量。 */
  env() {
    const v = this.v;
    return {
      HOST: v.scope === 'lan' ? '0.0.0.0' : '127.0.0.1', PORT: String(v.port), DATA_DIR: this.dataDir, ADMIN_PASSWORD: this.secrets.adminPassword ?? '',
      QQ_APP_ID: v.skipQQ ? '' : v.qqAppId, QQ_APP_SECRET: v.skipQQ ? '' : this.secrets.qqSecret ?? '', PUBLIC_URL: v.publicUrl,
      TRUST_PROXY: 'loopback', OCR_ENABLED: String(v.ocr), MERGE_WINDOW_MINUTES: String(v.mergeMinutes),
      ...(process.env.QQ_API_BASE ? { QQ_API_BASE: process.env.QQ_API_BASE } : {}),
    };
  }
}

/** 读旧版 .env 里可以沿用的设置。 */
function parseEnv(text) {
  const e = Object.fromEntries([...text.matchAll(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/gm)].map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')]));
  return { qqAppId: e.QQ_APP_ID ?? '', qqSecret: e.QQ_APP_SECRET ?? '', adminPassword: e.ADMIN_PASSWORD === 'change-me-please' ? '' : e.ADMIN_PASSWORD ?? '', port: Number(e.PORT) || DEFAULTS.port, publicUrl: e.PUBLIC_URL ?? '' };
}

module.exports = { Settings, SettingsError, DEFAULTS, normalizeUrl, randomPassword, parseEnv };
