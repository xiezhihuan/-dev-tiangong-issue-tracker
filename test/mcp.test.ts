import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { startApp, type App } from '../src/app.js';
import { Db } from '../src/db.js';
import { accessUrls } from '../src/web/access.js';
import { boot, cfg, login, sleep, tmp, U, until, type Env } from './helper.js';

let app: App, dir: string, api: Awaited<ReturnType<typeof login>>, token: string, client: Client;
const connect = async (url: string, t: string) => { const c = new Client({ name: 'test', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${t}` } } })); return c; };
const call = async (name: string, args: Record<string, unknown> = {}, c = client) => { const r: any = await c.callTool({ name, arguments: args }); let data: any = r.content[0]?.text; try { data = JSON.parse(data); } catch {} return { err: r.isError === true, data, content: r.content }; };
const form = (o: Record<string, string>, files: [string, Blob][] = []) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); for (const [n, b] of files) f.append('files', b, n); return f; };
const add = async (o: Record<string, string>, files: [string, Blob][] = []): Promise<number> => (await api('/feedbacks', { method: 'POST', form: form(o, files) })).data.id;
const att = async (id: number): Promise<number> => (await api(`/feedbacks/${id}`)).data.messages[0].attachments[0].id;
const post = (headers: Record<string, string>, method = 'POST') => fetch(app.url + '/mcp', { method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined });

before(async () => {
  dir = tmp(); app = await startApp(cfg(null, dir), { ocr: null }); api = await login(app);
  token = (await api('/mcp-tokens', { method: 'POST', body: { name: '测试' } })).data.token;
  client = await connect(app.url, token);
});
after(async () => { await client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('MCP：没有令牌、令牌错误、登录 Cookie、跨站来源、非 POST 都被拒绝', async () => {
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: 'Bearer tgm_wrong' })).status, 401);
  assert.equal((await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ authorization: `Bearer ${token}` }, 'GET')).status, 405);
  assert.equal((await post({ authorization: `Bearer ${token}` })).status, 200);
  assert.equal((await fetch(app.url + '/api/feedbacks', { headers: { authorization: `Bearer ${token}` } })).status, 401, 'MCP 令牌不能访问后台接口');
  assert.equal((await fetch(app.url + '/api/mcp-tokens', { method: 'POST', headers: { 'x-requested-with': 'tg' } })).status, 401);
});
test('MCP：令牌只存哈希，撤销后立即失效', async () => {
  const t = (await api('/mcp-tokens', { method: 'POST', body: { name: '临时' } })).data;
  const rows = (await api('/system')).data.tokens;
  assert.ok(rows.some((r: any) => r.name === '临时') && !JSON.stringify(rows).includes(t.token) && !('hash' in rows[0]));
  assert.ok(!JSON.stringify(app.store.db.all('SELECT * FROM api_tokens')).includes(t.token));
  assert.equal((await post({ authorization: `Bearer ${t.token}` })).status, 200);
  await api(`/mcp-tokens/${t.id}`, { method: 'DELETE' });
  assert.equal((await post({ authorization: `Bearer ${t.token}` })).status, 401);
  assert.equal((await api('/mcp-tokens', { method: 'POST', body: { name: '' } })).status, 400);
});
test('MCP：工具齐全且都声明只读', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['find_similar_issues', 'get_attachment', 'get_issue', 'get_overview', 'list_known_problems', 'search_issues']);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  assert.match(client.getInstructions()!, /只读/);
});
test('MCP：搜索、条件、分页、详情、相似、方案、统计', async () => {
  const a = await add({ text: '导出PDF提示文件损坏，错误码 E-2031', reporter: '王经理', severity: 'urgent' });
  const b = await add({ text: '导出 PDF 文件损坏打不开' });
  await add({ text: '登录收不到验证码' });
  await api(`/feedbacks/${a}`, { method: 'PATCH', body: { status: 'resolved', resolution: '升级到 V3.2.2' } });
  const g = (await api(`/feedbacks/${b}/group`, { method: 'POST', body: { with: a } })).data;
  await api(`/topics/${g.topicId}`, { method: 'PATCH', body: { root_cause: '导出组件不兼容', solution: '升级' } });

  const s = (await call('search_issues', { query: '损坏 E-2031' })).data;
  assert.deepEqual([s.total, s.issues[0].id, s.issues[0].status, s.issues[0].severity, s.issues[0].resolution, s.issues[0].submitted_via], [1, a, '已解决', '紧急', '升级到 V3.2.2', '网页']);
  assert.equal((await call('search_issues', { status: 'resolved' })).data.total, 1);
  assert.equal((await call('search_issues', { reporter: '王经理' })).data.total, 1);
  assert.equal((await call('search_issues', { from: '2000-01-01', to: '2000-01-02' })).data.total, 0);
  assert.deepEqual((await call('search_issues', { page_size: 1, page: 2, sort: 'old' })).data.issues.map((i: any) => i.id), [b]);
  const miss = (await call('search_issues', { query: 'PDF导出之后文件损坏怎么办' })).data;
  assert.equal(miss.total, 0); assert.ok(miss.similar.some((x: any) => x.id === a));

  const d = (await call('get_issue', { id: a })).data;
  assert.match(d.content.text, /E-2031/); assert.equal(d.known_problem.root_cause, '导出组件不兼容'); assert.ok(d.similar.some((x: any) => x.id === b));
  const f = (await call('find_similar_issues', { text: '用户说导出 PDF 后文件损坏' })).data.similar;
  assert.ok(f.length >= 2 && [a, b].includes(f[0].id) && f.some((x: any) => x.resolution === '升级到 V3.2.2'));
  assert.deepEqual((await call('find_similar_issues', { text: 'zzqq 完全无关' })).data.similar, []);
  const k = (await call('list_known_problems', { query: '不兼容' })).data;
  assert.deepEqual([k.total, k.problems[0].issue_count, k.problems[0].solution], [1, 2, '升级']);
  const o = (await call('get_overview')).data;
  assert.equal(o.total, 3); assert.ok(o.filter_values.categories.includes('打印'));
});
test('MCP：参数错误、不存在、已删除都返回明确错误', async () => {
  for (const [n, a] of [['get_issue', { id: 99999 }], ['get_issue', { id: 'x' }], ['get_issue', {}], ['search_issues', { status: 'xx' }], ['search_issues', { from: '2026-13-40' }], ['search_issues', { from: '2026-02-30' }], ['get_attachment', { id: 99999 }]] as const) {
    const r = await call(n, a); assert.ok(r.err, `${n} ${JSON.stringify(a)}`); assert.doesNotMatch(String(r.data), /服务器内部错误/);
  }
  const id = await add({ text: '将被删除的机密内容' }, [['a.txt', new Blob(['机密'])]]), x = await att(id);
  await api(`/feedbacks/${id}`, { method: 'DELETE' });
  assert.ok((await call('get_issue', { id })).err); assert.ok((await call('get_attachment', { id: x })).err);
  assert.equal((await call('search_issues', { query: '机密' })).data.total, 0);
  assert.ok(!JSON.stringify((await call('find_similar_issues', { text: '将被删除的机密内容' })).data).includes('机密'));
});
test('MCP：超长正文可以翻页取全，一个字不少', async () => {
  const long = Array.from({ length: 4000 }, (_, i) => `第${i}行日志`).join('\n'), id = await add({ text: long });
  let got = '', off: number | undefined = 0, n = 0;
  while (off !== undefined) { const c: any = (await call('get_issue', { id, content_offset: off })).data.content; got += c.text; off = c.next_offset; n++; assert.ok(n < 20); }
  assert.ok(n > 1 && got.replace(/\r\n/g, '\n').endsWith(long));
});
test('MCP：图片缩小后返回、文本日志（UTF-8/GBK）可读、二进制不误读', async () => {
  const cv = createCanvas(1200, 9000); cv.getContext('2d').fillRect(0, 0, 600, 4000);
  const big = await add({ text: '长截图' }, [['long.png', new Blob([new Uint8Array(await cv.encode('png'))])]]);
  const r = await call('get_attachment', { id: await att(big) });
  assert.equal(r.content[1].type, 'image');
  const img = await loadImage(Buffer.from(r.content[1].data, 'base64'));
  assert.ok(Math.max(img.width, img.height) <= 1568, `${img.width}x${img.height}`);
  const log = await add({ text: '日志' }, [['e.log', new Blob(['错误：空指针 at main.ts:1'])]]);
  assert.match((await call('get_attachment', { id: await att(log) })).data.content.text, /空指针/);
  const gbk = await add({ text: 'GBK 日志' }, [['g.log', new Blob([new Uint8Array([0xb4, 0xed, 0xce, 0xf3])])]]);
  assert.equal((await call('get_attachment', { id: await att(gbk) })).data.content.text, '错误');
  const bin = await add({ text: '二进制' }, [['x.bin', new Blob([new Uint8Array([0, 1, 2, 255])])]]);
  assert.match((await call('get_attachment', { id: await att(bin) })).data.note, /无法直接查看/);
});
test('列表：提交来路、摘要、缩略图、按来路筛选', async () => {
  const id = await add({ text: '缩略图测试' }, [['a.png', new Blob([new Uint8Array(await createCanvas(4, 4).encode('png'))])]]);
  const f = (await api(`/feedbacks?q=缩略图测试`)).data.items[0];
  assert.deepEqual([f.channel, f.excerpt, f.thumb], ['web', '缩略图测试', await att(id)]);
  assert.ok((await api('/feedbacks?channel=web')).data.total > 0);
  assert.equal((await api('/feedbacks?channel=qq')).data.total, 0);
});

test('QQ 发消息提交新问题 → 网页与 MCP 立即可查', async () => {
  const e: Env = await boot();
  try {
    e.mock.say(U, '提交：导出报表一直转圈'); await e.reply(/已记录 #1/);
    e.mock.say(U, '提交问题: 打印机找不到'); await e.reply(/已记录 #2/);
    e.mock.say(U, '/提交 登录闪退'); await e.reply(/已记录 #3/);
    e.mock.say(U, '新问题'); await e.reply(/记为新的一条/);
    e.mock.say(U, '附件预览空白'); await e.reply(/已记录 #4/);
    e.mock.say(U, '提交按钮点了没反应'); // 正文以「提交」开头但不是指令
    await until(() => e.app.store.detail(4).messages.length === 2, '普通正文不受影响');
    assert.equal(e.app.store.require(1).title, '导出报表一直转圈');
    const a = await login(e.app), t = (await a('/mcp-tokens', { method: 'POST', body: { name: 'x' } })).data.token, c = await connect(e.app.url, t);
    const r = (await call('search_issues', { query: '转圈' }, c)).data;
    assert.deepEqual([r.total, r.issues[0].id, r.issues[0].submitted_via], [1, 1, 'QQ']);
    assert.ok(!JSON.stringify((await call('get_issue', { id: 1 }, c)).data).includes(U), '不暴露 QQ openid');
    assert.equal((await a('/feedbacks?channel=qq')).data.total, 4);
    await e.restart(); await sleep(20);
    const c2 = await connect(e.app.url, t);
    assert.equal((await call('search_issues', {}, c2)).data.total, 4, '服务重启后令牌仍有效');
    await c2.close();
  } finally { await e.stop(); }
});
test('经本机穿透代理：域名访问网页登录和 MCP 正常，跨站来源仍被拒', async () => {
  const http = await import('node:http'), d = tmp(), a = await startApp(cfg(null, d, { trustProxy: 'loopback', publicUrl: 'https://fb.example.com' }), { ocr: null });
  const up = new URL(a.url);
  // 模拟穿透客户端：两种常见做法——保留 Host，或改写 Host 并带 X-Forwarded-Host
  const mk = (rewrite: boolean) => new Promise<any>((ok) => { const s = http.createServer((q, r) => { const h: any = { ...q.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' }; if (rewrite) { h['x-forwarded-host'] = 'fb.example.com'; h.host = up.host; } else h.host = 'fb.example.com'; q.pipe(http.request({ host: up.hostname, port: up.port, path: q.url, method: q.method, headers: h }, (x) => { r.writeHead(x.statusCode!, x.headers); x.pipe(r); })); }).listen(0, '127.0.0.1', () => ok(s)); });
  const t = (await (await login(a))('/mcp-tokens', { method: 'POST', body: { name: 'x' } })).data.token;
  try {
    for (const rewrite of [false, true]) {
      const s = await mk(rewrite), base = `http://127.0.0.1:${s.address().port}`;
      const lg = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'tg' }, body: '{"password":"test-password"}' });
      assert.equal(lg.status, 200); assert.match(lg.headers.get('set-cookie')!, /; Secure/);
      const c = await connect(base, t); assert.equal((await call('search_issues', {}, c)).data.total, 0); await c.close();
      const rpc = (origin: string) => fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t}`, origin }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }).then((r) => r.status);
      assert.equal(await rpc('https://fb.example.com'), 200); assert.equal(await rpc('https://evil.example'), 403);
      s.closeAllConnections(); s.close();
    }
  } finally { await a.close(); fs.rmSync(d, { recursive: true, force: true }); }
});
test('旧数据库自动升级，数据不变', () => {
  const d = tmp(), f = path.join(d, 'a.db'), db = new Db(f);
  db.raw.exec(`DROP TABLE api_tokens; PRAGMA user_version=1; INSERT INTO feedbacks(title,created_at,updated_at) VALUES('旧',1,1)`); db.close();
  const n = new Db(f);
  assert.equal(n.get('SELECT title FROM feedbacks')!.title, '旧'); assert.equal(n.all('SELECT * FROM api_tokens').length, 0);
  n.close(); fs.rmSync(d, { recursive: true, force: true });
});
test('手机访问地址：仅本机时不给地址，配置了对外地址就用它', () => {
  assert.deepEqual(accessUrls({ publicUrl: '', host: '127.0.0.1' }, 8787), []);
  const [a] = accessUrls({ publicUrl: 'https://fb.example.com', host: '0.0.0.0' }, 8787);
  assert.equal(a!.url, 'https://fb.example.com'); assert.equal(a!.kind, 'public'); assert.match(a!.qr, /^data:image\/gif;base64,/);
  for (const x of accessUrls({ publicUrl: 'https://x.cn', host: '0.0.0.0' }, 8787).slice(1)) assert.match(x.url, /^http:\/\/\d+\.\d+\.\d+\.\d+:8787$/);
});
