import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, type App } from '../src/app.js';
import { readConfig, type Config } from '../src/config.js';
import type { Ocr } from '../src/ocr.js';
import { MockQQ } from './mock-qq.js';

process.env.LOG_LEVEL ??= 'silent';
if (process.env.LOG_LEVEL === 'silent') { console.warn = () => {}; console.error = () => {}; const l = console.log; console.log = (...a) => { if (!/^\d{4}-.*\[(qq|web|media|ocr|backup|main)/.test(String(a[0]))) l(...a); }; }

export const U = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4';
export const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export async function until<T>(fn: () => T | undefined | false | null | Promise<T | undefined | false | null>, what = '条件', ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    let v: T | undefined | false | null, err: unknown;
    try { v = await fn(); } catch (e) { err = e; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`等待超时：${what}`, { cause: err });
    await new Promise((r) => setTimeout(r, 10));
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function cfg(mock: MockQQ | null, dataDir: string, over: Partial<Config> = {}): Config {
  return { ...readConfig({}), host: '127.0.0.1', port: 0, dataDir, adminPassword: 'test-password', qq: mock ? { appId: 'app', secret: 'sec', apiBase: mock.base } : { appId: '', secret: '', apiBase: '' }, receiptDelayMs: 60, backupKeep: 0, allowPrivateMedia: true, ...over };
}
export interface Env { mock: MockQQ; app: App; dir: string; restart(): Promise<void>; stop(): Promise<void>; reply(re: RegExp, after?: number): Promise<string> }
export async function boot(over: Partial<Config> = {}, opts: { ocr?: Ocr | null; bind?: boolean } = {}): Promise<Env> {
  const mock = new MockQQ();
  await mock.start();
  const dir = tmp(), c = cfg(mock, dir, over);
  const go = () => startApp(c, { ocr: opts.ocr ?? null, mediaRetry: [20, 20, 20], backoff: [20] });
  const env: Env = {
    mock, dir, app: await go(),
    async restart() { await env.app.close(); env.app = await go(); await until(() => env.app.bot!.gateway.state === 'online', '重启后上线'); },
    async stop() { await env.app.close(); await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
    reply: (re, after = 0) => until(() => mock.sent.slice(after).find((s) => re.test(s.content))?.content, `回复 ${re}；实际：${JSON.stringify(mock.sent.map((s) => s.content))}`),
  };
  await until(() => env.app.bot!.gateway.state === 'online', '上线');
  if (opts.bind !== false) env.app.store.db.run('INSERT INTO qq_users(openid,bound_at) VALUES(?,?)', U, 1);
  return env;
}
/** 带登录态的 API 客户端 */
export async function login(app: App): Promise<(p: string, o?: { method?: string; body?: any; form?: FormData }) => Promise<{ status: number; data: any; res: Response }>> {
  const r = await fetch(app.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'tg' }, body: JSON.stringify({ password: 'test-password' }) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  return async (p, o = {}) => {
    const res = await fetch(app.url + '/api' + p, { method: o.method ?? 'GET', headers: { cookie, 'x-requested-with': 'tg', ...(o.body ? { 'content-type': 'application/json' } : {}) }, body: o.form ?? (o.body ? JSON.stringify(o.body) : undefined) });
    const t = await res.clone().text();
    let data: any = t; try { data = JSON.parse(t); } catch {}
    return { status: res.status, data, res };
  };
}
