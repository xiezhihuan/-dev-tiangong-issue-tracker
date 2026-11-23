import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录：src/ 与 dist/ 都在根目录的下一级。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  adminPassword: string;
  /** true / false，或只信任来自某处的代理，如 loopback（本机上的穿透客户端）。 */
  trustProxy: boolean | string;
  cookieSecure: boolean;
  /** 对外访问地址（如 https://fb.example.com），用于生成手机二维码和 MCP 配置。 */
  publicUrl: string;
  qq: { appId: string; secret: string; apiBase: string };
  /** 同一人连续发送的消息在此时间内自动并入同一条反馈。 */
  mergeWindowMs: number;
  /** 回执防抖：连发多条（如 9 张截图）只回一次。 */
  receiptDelayMs: number;
  ocr: boolean;
  maxAttachmentBytes: number;
  backupKeep: number;
  /** 仅供测试：允许从内网/本机下载附件。 */
  allowPrivateMedia: boolean;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number, min = 0): number {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`环境变量 ${key} 的值无效：${raw}`);
  return n;
}
const bool = (v: string | undefined, def: boolean) => (v?.trim() ? /^(1|true|yes|on)$/i.test(v.trim()) : def);

export function loadEnvFile(file = path.join(ROOT, '.env')): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: num(env, 'PORT', 8787),
    dataDir: path.resolve(ROOT, env.DATA_DIR?.trim() || 'data'),
    adminPassword: env.ADMIN_PASSWORD ?? '',
    trustProxy: env.TRUST_PROXY?.trim() === 'loopback' ? 'loopback' : bool(env.TRUST_PROXY, false),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    publicUrl: (env.PUBLIC_URL?.trim() ?? '').replace(/\/+$/, ''),
    qq: {
      appId: env.QQ_APP_ID?.trim() ?? '',
      secret: env.QQ_APP_SECRET?.trim() ?? '',
      apiBase: (env.QQ_API_BASE?.trim() || 'https://api.bot.qq.com').replace(/\/+$/, ''),
    },
    mergeWindowMs: num(env, 'MERGE_WINDOW_MINUTES', 5) * 60_000,
    receiptDelayMs: num(env, 'RECEIPT_DELAY_MS', 2500),
    ocr: bool(env.OCR_ENABLED, true),
    maxAttachmentBytes: num(env, 'MAX_ATTACHMENT_MB', 200, 1) * 1024 * 1024,
    backupKeep: num(env, 'BACKUP_KEEP_DAYS', 14),
    allowPrivateMedia: false,
  };
}

/** 启动前校验，返回问题列表。 */
export function validateConfig(c: Config): string[] {
  const errs: string[] = [];
  if (c.adminPassword.length < 8) errs.push('ADMIN_PASSWORD 未设置或少于 8 位（网页后台登录密码）');
  if (c.adminPassword === 'change-me-please') errs.push('ADMIN_PASSWORD 仍是示例值，请修改');
  if (c.publicUrl && !/^https?:\/\/[^/]+/.test(c.publicUrl)) errs.push('PUBLIC_URL 须以 http:// 或 https:// 开头');
  if (Boolean(c.qq.appId) !== Boolean(c.qq.secret)) errs.push('QQ_APP_ID 与 QQ_APP_SECRET 必须同时填写');
  return errs;
}
