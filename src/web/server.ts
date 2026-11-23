import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fstatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ROOT, type Config } from '../config.js';
import { fmtTime, toCsv, toJson, toMarkdown } from '../exports.js';
import { logger } from '../log.js';
import { INLINE, trustedMime, type Media } from '../media.js';
import type { Bot } from '../qq/bot.js';
import { SEVERITY, STATUS, UserError, type Filter, type NewAttachment, type Store } from '../store.js';

const log = logger('web');
const COOKIE = 'tg_session';
const TTL = 30 * 86400_000;
const ACTOR = '网页';

export interface WebDeps { config: Config; store: Store; media: Media; bot: Bot | null; startedAt: number }

export async function createServer({ config, store, media, bot, startedAt }: WebDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: config.trustProxy, bodyLimit: 2 * 1024 * 1024, forceCloseConnections: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxAttachmentBytes, files: 20, fields: 30, fieldSize: 1024 * 1024 } });

  // ───── 登录：密码 + 签名 Cookie；改密码后旧会话自动失效 ─────
  let secret = store.db.kvGet('session_secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); store.db.kvSet('session_secret', secret); }
  const key = crypto.createHash('sha256').update(`${secret}\0${config.adminPassword}`).digest();
  const sign = (exp: string) => crypto.createHmac('sha256', key).update(exp).digest('hex');
  const same = (a: string, b: string) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
  const authed = (req: FastifyRequest): boolean => {
    const [exp, mac] = (req.cookies[COOKIE] ?? '').split('.');
    return !!exp && !!mac && Number(exp) > Date.now() && same(mac, sign(exp));
  };
  const fails = new Map<string, { n: number; until: number }>();

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'same-origin')
      .header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    // 用匹配到的路由判断而非原始 URL，避免 /%61pi/… 这类编码绕过
    const p = req.routeOptions?.url ?? '';
    if (!p.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    // 写操作要求自定义头，跨站表单无法携带
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'tg') return reply.code(403).send({ error: '非法请求来源' });
    if (p !== '/api/login' && !authed(req)) return reply.code(401).send({ error: '请先登录' });
  });
  app.setErrorHandler((e: any, _req, reply) => {
    if (e instanceof UserError) return reply.code(e.status).send({ error: e.message });
    const code = e.statusCode ?? 500;
    if (code >= 500) log.error('请求处理失败', e);
    return reply.code(code).send({ error: code === 413 ? '文件过大' : code >= 500 ? '服务器内部错误' : e.message });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: '不存在' }));

  app.get('/healthz', async (_req, reply) => {
    store.db.get('SELECT 1');
    const state = bot?.gateway.state ?? 'disabled';
    return reply.code(state === 'blocked' ? 503 : 200).send({ ok: true, bot: state });
  });

  app.post('/api/login', async (req, reply) => {
    const f = fails.get(req.ip);
    if (f && f.n >= 5 && f.until > Date.now()) return reply.code(429).send({ error: '尝试次数过多，请 5 分钟后再试' });
    const pw = (req.body as any)?.password;
    if (typeof pw !== 'string' || !same(pw, config.adminPassword)) {
      if (fails.size > 5000) fails.clear();
      fails.set(req.ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 5 * 60_000 });
      return reply.code(401).send({ error: '密码错误' });
    }
    fails.delete(req.ip);
    const exp = String(Date.now() + TTL);
    return reply.setCookie(COOKIE, `${exp}.${sign(exp)}`, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: TTL / 1000 }).send({ ok: true });
  });
  app.post('/api/logout', async (_req, reply) => reply.clearCookie(COOKIE, { path: '/' }).send({ ok: true }));

  // ───── 通用 ─────
  const day = (s: unknown, next = false): number | undefined => {
    const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(String(s ?? ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (next ? 1 : 0)).getTime() : undefined;
  };
  const filter = (req: FastifyRequest): Filter => {
    const q = req.query as Record<string, string>;
    const s = (k: string) => (typeof q[k] === 'string' && q[k] ? q[k] : undefined);
    return { q: s('q'), status: s('status'), category: s('category'), product: s('product'), severity: s('severity'), topic: s('topic'), reporter: s('reporter'), tag: s('tag'), from: day(q.from), to: day(q.to, true), deleted: q.deleted === '1', sort: s('sort'), page: Number(q.page) || 1, pageSize: Math.min(Number(q.pageSize) || 30, 200) };
  };
  const id = (req: FastifyRequest, k = 'id'): number => Number((req.params as any)[k]);
  const body = (req: FastifyRequest): any => (req.body && typeof req.body === 'object' ? req.body : {});

  app.get('/api/meta', async () => ({
    status: STATUS, severity: SEVERITY, categories: store.taxonomy('category'), products: store.taxonomy('product'),
    reporters: store.db.all(`SELECT DISTINCT reporter v FROM feedbacks WHERE reporter<>'' AND deleted_at IS NULL ORDER BY 1 LIMIT 500`).map((r) => r.v),
    tags: store.db.all('SELECT DISTINCT tag v FROM feedback_tags ORDER BY 1 LIMIT 500').map((r) => r.v),
    users: store.db.all('SELECT openid,nickname FROM qq_users'), topics: store.topics().map((t) => ({ id: t.id, title: t.title, count: t.count })),
  }));

  // ───── 反馈 ─────
  app.get('/api/feedbacks', async (req) => store.list(filter(req)));
  app.get('/api/feedbacks/:id', async (req) => ({ ...store.detail(id(req)), similar: store.similar(id(req)) }));
  app.patch('/api/feedbacks/:id', async (req) => { store.update(id(req), body(req), ACTOR); return store.detail(id(req)); });
  app.delete('/api/feedbacks/:id', async (req) => { store.remove(id(req), ACTOR); return { ok: true }; });
  app.post('/api/feedbacks/:id/restore', async (req) => { store.restore(id(req), ACTOR); return { ok: true }; });
  app.post('/api/feedbacks/:id/group', async (req) => store.group(id(req), Number(body(req).with), ACTOR));
  app.post('/api/feedbacks/:id/merge', async (req) => { store.merge(id(req), Number(body(req).into), ACTOR); return { ok: true }; });
  app.post('/api/messages/:id/move', async (req) => ({ id: store.moveMessage(id(req), body(req).to == null ? null : Number(body(req).to), ACTOR) }));

  /** multipart：text / kind / reporter 等字段 + files */
  async function readForm(req: FastifyRequest): Promise<{ fields: Record<string, string>; atts: NewAttachment[] }> {
    const fields: Record<string, string> = {}, atts: NewAttachment[] = [];
    if (!req.isMultipart()) return { fields: body(req), atts };
    for await (const part of req.parts()) {
      if (part.type === 'field') fields[part.fieldname] = String(part.value);
      else {
        const s = await media.save(part.file, part.filename);
        if (part.file.truncated) throw new UserError('文件过大', 413);
        const mime = trustedMime(s.mime, part.mimetype);
        atts.push({ kind: s.mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'voice' : mime.startsWith('video/') ? 'video' : 'file', filename: part.filename, mime, size: s.size, path: s.path, sha256: s.sha256 });
      }
    }
    return { fields, atts };
  }
  const append = (fid: number, f: Record<string, string>, atts: NewAttachment[]) => {
    const text = String(f.text ?? '').trim();
    if (!text && !atts.length) throw new UserError('内容不能为空');
    if (text.length > 100_000) throw new UserError('内容过长');
    store.addMessage(fid, { channel: 'web', author: ACTOR, kind: f.kind === 'note' ? 'note' : 'report', text, sentAt: Date.now(), attachments: atts });
  };
  app.post('/api/feedbacks', async (req) => {
    const { fields, atts } = await readForm(req);
    const fid = store.db.tx(() => {
      const n = store.createFeedback(ACTOR);
      append(n, { ...fields, kind: 'report' }, atts);
      const patch = Object.fromEntries(['title', 'reporter', 'product', 'category', 'severity', 'source', 'version'].filter((k) => fields[k]).map((k) => [k, fields[k]]));
      store.update(n, patch, ACTOR);
      return n;
    });
    media.kick();
    return { id: fid };
  });
  app.post('/api/feedbacks/:id/messages', async (req) => {
    store.require(id(req));
    const { fields, atts } = await readForm(req);
    append(id(req), fields, atts);
    media.kick();
    return { ok: true };
  });

  // ───── 附件 ─────
  app.get('/api/attachments/:id', async (req, reply: FastifyReply) => {
    const a = store.db.get('SELECT * FROM attachments WHERE id=?', id(req));
    if (!a?.path || !fs.existsSync(media.abs(a.path))) throw new UserError('附件不存在', 404);
    const inline = INLINE.test(a.mime) && (req.query as any).dl !== '1';
    const name = a.filename || `附件${a.id}${path.extname(a.path)}`;
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox").header('Cache-Control', 'private, max-age=86400')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.type(inline ? a.mime : 'application/octet-stream').sendFile(a.path, media.dir, { cacheControl: false, contentType: false, acceptRanges: true });
  });
  app.post('/api/attachments/:id/retry', async (req) => { media.retry(id(req)); return { ok: true }; });

  // ───── 同类问题 ─────
  app.get('/api/topics', async (req) => store.topics(String((req.query as any).q ?? '')));
  app.post('/api/topics', async (req) => ({ id: store.createTopic(String(body(req).title ?? '')) }));
  app.get('/api/topics/:id', async (req) => store.topic(id(req)));
  app.patch('/api/topics/:id', async (req) => { const { cascade, ...patch } = body(req); store.updateTopic(id(req), patch, ACTOR, cascade === true); return store.topic(id(req)); });
  app.delete('/api/topics/:id', async (req) => { store.deleteTopic(id(req)); return { ok: true }; });

  // ───── 统计 / 导出 ─────
  app.get('/api/stats', async (req) => store.stats(filter(req)));
  app.get('/api/export/:fmt', async (req, reply) => {
    const fmt = (req.params as any).fmt as string, f = filter(req), name = `feedback-${fmtTime(Date.now()).slice(0, 10)}.${fmt}`;
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    if (fmt === 'csv') return reply.type('text/csv; charset=utf-8').send(toCsv(store, f));
    if (fmt === 'md') return reply.type('text/markdown; charset=utf-8').send(toMarkdown(store, f));
    if (fmt === 'json') return reply.type('application/json; charset=utf-8').send(toJson(store, f));
    throw new UserError('不支持的格式', 404);
  });

  // ───── 设置 ─────
  const kind = (req: FastifyRequest): 'category' | 'product' => {
    const k = (req.params as any).kind;
    if (k !== 'category' && k !== 'product') throw new UserError('类型无效', 404);
    return k;
  };
  app.post('/api/taxonomy/:kind', async (req) => { const b = body(req); store.saveTaxonomy(kind(req), { id: b.id ? Number(b.id) : undefined, name: String(b.name ?? ''), keywords: String(b.keywords ?? ''), sort: b.sort === undefined ? undefined : Number(b.sort) }); return { ok: true }; });
  app.delete('/api/taxonomy/:kind/:id', async (req) => { store.deleteTaxonomy(kind(req), id(req)); return { ok: true }; });
  app.get('/api/system', async () => ({
    bot: bot ? { state: bot.gateway.state, reason: bot.gateway.reason, lastEventAt: bot.gateway.lastEventAt } : { state: 'disabled', reason: '未配置 QQ_APP_ID / QQ_APP_SECRET', lastEventAt: 0 },
    ocr: media.ocr ? 'ready' : config.ocr ? 'unavailable' : 'disabled',
    queue: store.db.get(`SELECT COALESCE(SUM(status='pending'),0) downloading, COALESCE(SUM(status='failed'),0) failed, COALESCE(SUM(status='done' AND ocr_status='pending'),0) recognizing FROM attachments`),
    users: store.db.all('SELECT openid,nickname,bound_at FROM qq_users ORDER BY bound_at'),
    mergeWindowMinutes: config.mergeWindowMs / 60_000, startedAt, dataDir: config.dataDir,
  }));
  app.post('/api/bind-code', async () => {
    const code = String(crypto.randomInt(10_000_000, 100_000_000)), exp = Date.now() + 10 * 60_000;
    store.db.kvSet('bind_code', JSON.stringify({ code, exp }));
    return { code, exp };
  });
  app.delete('/api/qq-users/:openid', async (req) => { store.db.run('DELETE FROM qq_users WHERE openid=?', (req.params as any).openid); return { ok: true }; });

  await app.register(fstatic, { root: path.join(ROOT, 'public'), cacheControl: false, etag: true });
  return app;
}
