import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { startApp, type App } from '../src/app.js';
import { backupOnce } from '../src/backup.js';
import { validateConfig, readConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { cfg, login, PNG, tmp } from './helper.js';

let app: App, api: Awaited<ReturnType<typeof login>>, dir: string;
before(async () => { dir = tmp(); app = await startApp(cfg(null, dir), { ocr: null }); api = await login(app); });
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const raw = (p: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<number>((ok, bad) => { const u = new URL(app.url); http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (r) => { r.resume(); ok(r.statusCode!); }).on('error', bad).end(); });
const form = (o: Record<string, string | Blob>, name?: string) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) typeof v === 'string' ? f.set(k, v) : f.append(k, v, name); return f; };

test('未登录全部拒绝，编码路径、大小写也绕不过', async () => {
  for (const p of ['/api/feedbacks', '/api/export/csv', '/api/attachments/1', '/%61pi/feedbacks', '/api/%66eedbacks', '/api//feedbacks', '//api/feedbacks', '/API/feedbacks', '/x/../api/feedbacks', '/api/system'])
    assert.ok([401, 403, 404].includes(await raw(p)), `${p} → ${await raw(p)}`);
  assert.equal(await raw('/api/feedbacks', { cookie: 'tg_session=9999999999999.deadbeef' }), 401);
  for (const p of ['/../package.json', '/..%2f.env', '/%2e%2e/src/main.ts']) assert.ok([400, 403, 404].includes(await raw(p)), p);
});
test('写操作缺少自定义头被拒（防 CSRF）', async () => assert.equal(await raw('/api/feedbacks', {}, 'POST'), 403));
test('新增（文字+截图）、读取附件、追加、修改、回收站', async () => {
  const r = await api('/feedbacks', { method: 'POST', form: form({ text: '导出失败', reporter: '王五', severity: 'high', files: new Blob([PNG], { type: 'image/png' }) }, '截图 1.png') });
  assert.equal(r.status, 200);
  const id = r.data.id, d = (await api(`/feedbacks/${id}`)).data, att = d.messages[0].attachments[0];
  assert.deepEqual([d.reporter, d.severity, att.filename, att.kind], ['王五', 'high', '截图 1.png', 'image']);
  const f = await api(`/attachments/${att.id}`);
  assert.equal(f.res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await f.res.arrayBuffer()), PNG);
  await api(`/feedbacks/${id}/messages`, { method: 'POST', form: form({ text: '备注一下', kind: 'note' }) });
  assert.equal((await api(`/feedbacks/${id}`)).data.messages[1].kind, 'note');
  assert.equal((await api(`/feedbacks/${id}`, { method: 'PATCH', body: { status: 'resolved', resolution: '已修' } })).data.status, 'resolved');
  assert.equal((await api(`/feedbacks/${id}`, { method: 'PATCH', body: { status: 'xx' } })).status, 400);
  assert.equal((await api(`/feedbacks/${id}`, { method: 'PATCH', body: { id: 5 } })).status, 400);
  await api(`/feedbacks/${id}`, { method: 'DELETE' });
  assert.equal((await api('/feedbacks')).data.total, 0);
  assert.equal((await api('/feedbacks?deleted=1')).data.total, 1);
  await api(`/feedbacks/${id}/restore`, { method: 'POST', body: {} });
  assert.equal((await api('/feedbacks?q=导出')).data.total, 1);
});
test('恶意文件只能下载、不能在页面内执行', async () => {
  const r = await api('/feedbacks', { method: 'POST', form: form({ text: 'x', files: new Blob(['<script>alert(1)</script>'], { type: 'image/png' }) }, 'a.html') });
  const att = (await api(`/feedbacks/${r.data.id}`)).data.messages[0].attachments[0];
  const f = await api(`/attachments/${att.id}`);
  assert.equal(f.res.headers.get('content-type'), 'application/octet-stream');
  assert.match(f.res.headers.get('content-disposition')!, /^attachment/);
  assert.match(f.res.headers.get('content-security-policy')!, /sandbox/);
});
test('空内容、不存在的编号返回明确错误', async () => {
  assert.equal((await api('/feedbacks', { method: 'POST', form: form({ text: ' ' }) })).status, 400);
  assert.equal((await api('/feedbacks/9999')).status, 404);
  assert.equal((await api('/feedbacks/abc')).status, 404);
  assert.equal((await api('/attachments/9999')).status, 404);
});
test('同类问题、统计、导出、分类维护', async () => {
  const mk = async (text: string) => (await api('/feedbacks', { method: 'POST', body: { text } })).data.id;
  const a = await mk('打印页眉错位'), b = await mk('打印预览页眉错位了');
  const g = (await api(`/feedbacks/${a}/group`, { method: 'POST', body: { with: b } })).data;
  assert.equal(g.count, 2);
  assert.equal((await api(`/topics/${g.topicId}`, { method: 'PATCH', body: { solution: '装字体', status: 'resolved', cascade: true } })).data.feedbacks[0].status, 'resolved');
  const s = (await api('/stats')).data;
  assert.ok(s.total >= 4 && s.byCategory.some((c: any) => c.name === '打印' && c.count === 2));
  const sum = (await api('/summary')).data;
  assert.equal(sum.total, s.total); assert.equal(sum.open + sum.doing, s.todo); assert.equal(sum.resolved, s.resolved);
  assert.equal(sum.days.length, 14); assert.equal(sum.days.at(-1).count, sum.today); assert.equal(sum.today, s.total);
  assert.match((await api('/export/csv')).data, /打印页眉错位/);
  assert.ok(Array.isArray((await api(`/export/json?topic=${g.topicId}`)).data));
  assert.equal((await api('/taxonomy/product', { method: 'POST', body: { name: 'PC端', keywords: '电脑' } })).status, 200);
  assert.equal((await api('/taxonomy/product', { method: 'POST', body: { name: 'PC端', keywords: '' } })).status, 400);
  assert.equal((await api('/taxonomy/hack', { method: 'POST', body: { name: 'x' } })).status, 404);
  assert.match((await api('/bind-code', { method: 'POST', body: {} })).data.code, /^\d{8}$/);
});
test('登录限速', async () => {
  const t = (pw: string) => fetch(app.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'tg' }, body: JSON.stringify({ password: pw }) }).then((r) => r.status);
  for (let i = 0; i < 5; i++) assert.equal(await t('bad'), 401);
  assert.equal(await t('test-password'), 429);
});
test('备份可独立打开且数据完整', () => {
  const f = backupOnce(app.store.db, dir, 3)!;
  const db = new Db(f);
  assert.equal(db.get('SELECT COUNT(*) n FROM feedbacks')!.n, app.store.db.get('SELECT COUNT(*) n FROM feedbacks')!.n);
  db.close();
});
test('配置校验', () => {
  assert.equal(validateConfig(readConfig({})).length, 1);
  assert.equal(validateConfig(readConfig({ ADMIN_PASSWORD: 'abcdefgh', QQ_APP_ID: '1' })).length, 1);
  assert.throws(() => readConfig({ PORT: 'abc' }));
});
test('经本机代理的 HTTPS 登录自动加 Secure；局域网 HTTP 不加；非本机来源不能伪造', async () => {
  const d = tmp(), a = await startApp(cfg(null, d, { trustProxy: 'loopback' }), { ocr: null });
  const b = await startApp(cfg(null, d + 'b'), { ocr: null });
  const lg = async (x: App, h: Record<string, string>) => (await fetch(x.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'tg', ...h }, body: JSON.stringify({ password: 'test-password' }) })).headers.get('set-cookie')!;
  try {
    assert.match(await lg(a, { 'x-forwarded-proto': 'https' }), /; Secure/);
    assert.doesNotMatch(await lg(a, {}), /; Secure/);
    assert.doesNotMatch(await lg(b, { 'x-forwarded-proto': 'https' }), /; Secure/);
  } finally { await a.close(); await b.close(); fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(d + 'b', { recursive: true, force: true }); }
});
