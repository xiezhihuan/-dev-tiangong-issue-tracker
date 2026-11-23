/** 端到端：模拟 QQ 平台 + 真实 OCR + 真实 Chrome。截图输出到 test-output/。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, devices, type Page } from 'playwright-core';
import { startApp } from '../src/app.js';
import { ROOT } from '../src/config.js';
import { createOcr } from '../src/ocr.js';
import { cfg, tmp, U, until } from './helper.js';
import { MockQQ } from './mock-qq.js';

const OUT = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const ocr = await createOcr();
assert.ok(ocr, 'OCR 必须可用');
const browser = await chromium.launch({ channel: 'chrome' });
const errors: string[] = [];
const ok = (s: string) => console.log('✓ ' + s);
let app: Awaited<ReturnType<typeof startApp>> | undefined;
const mock = new MockQQ(), dir = tmp();

/** 生成一张仿微信聊天截图。 */
async function wechat(msgs: [string, string][], long = 1): Promise<Buffer> {
  const p = await browser.newPage({ viewport: { width: 390, height: 600 }, deviceScaleFactor: 3 });
  const rows = Array.from({ length: long }, () => msgs).flat();
  await p.setContent(`<meta charset=utf8><body style="margin:0;background:#ededed;font:17px 'PingFang SC',sans-serif;width:390px"><div style="text-align:center;padding:12px">客户交流群(28)</div>${rows.map(([n, t], i) => `<div style="display:flex;flex-direction:${n === '我' ? 'row-reverse' : 'row'};padding:8px 12px;gap:10px"><div style="width:40px;height:40px;background:#7aa"></div><div><div style="font-size:12px;color:#888">${n}</div><div style="background:${n === '我' ? '#95ec69' : '#fff'};padding:10px;max-width:250px">${t}${long > 1 ? `编号${1000 + i}` : ''}</div></div></div>`).join('')}`);
  const b = await p.screenshot({ fullPage: true });
  await p.close();
  return b;
}
async function watch(p: Page): Promise<void> {
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/401|429/.test(m.text())) errors.push(m.text()); });
}

try {
  await mock.start();
  app = await startApp({ ...cfg(mock, dir), receiptDelayMs: 300 }, { ocr, backoff: [50] });
  const p = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await watch(p);
  const reply = (re: RegExp, from = 0) => until(() => mock.sent.slice(from).find((s) => re.test(s.content))?.content, String(re), 30_000);

  await p.goto(app.url);
  await p.getByLabel('密码').fill('wrong-password'); await p.getByRole('button', { name: '登录' }).click();
  await p.getByText('密码错误').waitFor();
  await p.getByLabel('密码').fill('test-password'); await p.getByRole('button', { name: '登录' }).click();
  await p.getByText('还没有反馈').waitFor();
  ok('登录');

  await p.goto(app.url + '/#/settings');
  await p.getByRole('button', { name: '生成绑定码' }).click();
  const code = await p.locator('.code').innerText();
  mock.say(U, code); await reply(/绑定成功/);
  const prod = p.locator('.card', { hasText: '名称和关键词出现在反馈里' }).locator('.row').last();
  await prod.getByLabel('名称').fill('天工桌面端'); await prod.getByLabel('关键词').fill('电脑版,桌面端'); await prod.getByRole('button', { name: '添加' }).click();
  await p.getByText('自动归类的反馈已重新识别').waitFor();
  ok('后台生成绑定码 → QQ 绑定；维护产品');

  mock.files.set('/file/1', { body: await wechat([['王经理', '你好，我们导出PDF的时候一直提示文件损坏，错误码 E-2031'], ['王经理', '电脑版 V3.2.1，昨天升级以后就这样了'], ['我', '收到，我先记录一下']]), type: 'image/png' });
  mock.say(U, '客户：王经理');
  mock.say(U, '', { attachments: [{ content_type: 'image/png', filename: 'wx1.png', url: mock.base + '/file/1' }] });
  const r1 = await reply(/已记录 #1/);
  console.log('--- 回执 ---\n' + r1 + '\n------------');
  assert.match(r1, /文件损坏/); assert.match(r1, /导入导出与文件｜天工桌面端｜V3\.2\.1/); assert.match(r1, /反馈人：王经理/);
  const f1 = app.store.detail(1).messages[1].attachments[0].text as string;
  assert.ok(f1.includes('收到，我先记录一下') && f1.includes('2031'), f1);
  ok('微信截图 → QQ → OCR → 自动标题/分类/产品/版本');

  mock.say(U, '/解决 升级到 V3.2.2 后修复'); await reply(/已标为解决/);
  mock.say(U, '客户：李律师\n导出PDF提示文件损坏打不开');
  const r2 = await reply(/已记录 #2/);
  console.log('--- 回执 ---\n' + r2 + '\n------------');
  assert.match(r2, /以前有类似的[\s\S]*#1[\s\S]*升级到 V3\.2\.2/);
  mock.say(U, '同类 1'); await reply(/共 2 条/);
  ok('第二次同类反馈 → 回执直接带出上次的处理办法 → 归类');

  mock.files.set('/file/2', { body: await wechat([['赵总', '登录收不到验证码'], ['我', '好的我看一下']], 22), type: 'image/png' });
  mock.say(U, '新建'); mock.say(U, '', { attachments: [{ content_type: 'image/png', filename: 'long.png', url: mock.base + '/file/2' }] });
  await reply(/已记录 #3/);
  const long = app.store.detail(3).messages[0].attachments[0].text as string;
  const got = Array.from({ length: 44 }, (_, i) => 1000 + i).filter((n) => long.includes(`编号${n}`)).length;
  console.log(`长截图识别到 ${got}/44 行`);
  assert.equal(got, 44);
  ok('长截图切片识别');
  mock.say(U, '', { attachments: [{ content_type: 'voice', filename: 'v.silk', url: mock.base + '/file/none', asr_refer_text: '手机端点案件列表会卡住半分钟' }] });
  await until(() => app!.store.list({ q: '卡住半分钟' }).total === 1);
  ok('语音：音频下载失败时转写文字仍入库可搜');

  await p.goto(app.url + '/#/feedbacks');
  await p.reload();
  await p.getByText('共 3 条').waitFor();
  await p.screenshot({ path: path.join(OUT, '1-列表.png') });
  await p.locator('.kpi', { hasText: '已解决' }).click(); await p.getByText('共 1 条').waitFor(); await p.locator('.kpi.on', { hasText: '已解决' }).click(); await p.getByText('共 3 条').waitFor();
  await p.locator('.views a', { hasText: '未归并' }).click(); await p.getByText('共 1 条').waitFor(); await p.locator('.views a', { hasText: '回收站' }).click(); await p.getByText('没有符合条件的反馈').waitFor();
  await p.getByRole('link', { name: '清除条件' }).click(); await p.getByText('共 3 条').waitFor();
  ok('概览卡片、快捷视图筛选');
  await p.getByLabel('搜索').fill('2031'); await p.getByLabel('搜索').press('Enter');
  await p.getByText('共 1 条').waitFor();
  ok('按截图里的文字搜索到反馈');
  await p.locator('tbody tr').first().click();
  await p.getByRole('heading', { name: /#1/ }).waitFor();
  await p.locator('.att img').first().waitFor();
  await until(async () => p.locator('.att img').first().evaluate((i: any) => i.naturalWidth > 0));
  await p.screenshot({ path: path.join(OUT, '2-详情.png'), fullPage: true });
  await p.locator('label', { hasText: '优先级' }).locator('select').selectOption('urgent');
  await p.getByText('已保存').waitFor();
  await until(() => app!.store.require(1).severity === 'urgent');
  await p.getByPlaceholder('追加内容或备注').fill('已回访客户'); await p.getByLabel('仅作内部备注').check(); await p.getByRole('button', { name: '追加' }).click();
  await p.locator('.msg.note', { hasText: '已回访客户' }).waitFor();
  ok('详情：图片显示、改字段、加备注');

  const seg = p.getByRole('group', { name: '状态' });
  await seg.getByRole('button', { name: '处理中' }).click(); await until(() => app!.store.require(1).status === 'doing');
  await p.locator('.seg .doing.on').waitFor();
  await seg.getByRole('button', { name: '已解决' }).click(); await until(() => app!.store.require(1).status === 'resolved');
  await p.getByRole('button', { name: '删除' }).click(); await p.locator('dialog.ask').getByRole('button', { name: '取消' }).click();
  await p.locator('dialog').waitFor({ state: 'detached' }); assert.equal(app.store.require(1).deleted_at, null);
  await p.getByRole('button', { name: '移动/拆分' }).first().click(); await p.locator('dialog.ask input').fill('abc'); await p.locator('dialog.ask input').press('Enter');
  await p.locator('#toast.bad', { hasText: '编号无效' }).waitFor();
  ok('状态一键切换；应用内确认框、输入框可取消、校验报错');

  await p.getByRole('button', { name: '新增反馈' }).click();
  const dlg = p.locator('dialog');
  await dlg.locator('[name=reporter]').fill('孙女士');
  await dlg.locator('textarea').fill('<img src=x onerror=alert(1)> 打印预览页眉错位');
  await dlg.locator('input[type=file]').setInputFiles({ name: '截图.png', mimeType: 'image/png', buffer: mock.files.get('/file/1')!.body });
  await dlg.getByRole('button', { name: '保存' }).click();
  await p.getByRole('heading', { name: /#4/ }).waitFor();
  assert.equal(await p.locator('.msg .body img').count(), 0);
  ok('网页新增（含附件），恶意 HTML 只按文本显示');

  await p.goto(app.url + '/#/topics'); await p.locator('tbody tr').first().click();
  await p.getByPlaceholder('根本原因').fill('导出组件版本不兼容'); await p.getByPlaceholder('修复版本').fill('升级到 V3.2.2');
  await p.getByRole('button', { name: /标为已解决/ }).click();
  await until(() => app!.store.require(2).status === 'resolved');
  await p.screenshot({ path: path.join(OUT, '3-同类问题.png'), fullPage: true });
  ok('同类问题：沉淀原因与方案，批量解决');

  await p.goto(app.url + '/#/stats'); await p.getByText('反馈总数').waitFor();
  await p.locator('.bar').first().hover(); await p.locator('.bar .tip').first().waitFor();
  await p.screenshot({ path: path.join(OUT, '4-统计.png'), fullPage: true });
  await p.goto(app.url + '/#/settings'); await p.getByText('运行状态').waitFor();
  await p.locator('main').getByText('在线').waitFor();
  await p.screenshot({ path: path.join(OUT, '5-设置.png'), fullPage: true });
  ok('统计、设置页');

  const dl = p.waitForEvent('download');
  await p.goto(app.url + '/#/feedbacks'); await p.getByRole('link', { name: 'Markdown' }).click();
  assert.match(fs.readFileSync(await (await dl).path(), 'utf8'), /导出组件版本不兼容/);
  ok('导出');

  await p.goto(app.url + '/#/settings'); await p.getByRole('button', { name: '生成访问令牌' }).waitFor();
  await p.getByLabel('令牌名称').fill('我的 Claude'); await p.getByRole('button', { name: '生成访问令牌' }).click();
  const cmd = await p.locator('#mcp-out .cmd').first().innerText(), token = /Bearer (tgm_[\w-]+)/.exec(cmd)![1]!;
  assert.ok(cmd.startsWith(`claude mcp add --transport http --scope user tiangong-feedback ${app.url}/mcp `), cmd);
  await p.screenshot({ path: path.join(OUT, '8-MCP设置.png'), fullPage: true });
  const mcp = new Client({ name: 'e2e', version: '1' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const found: any = JSON.parse(((await mcp.callTool({ name: 'search_issues', arguments: { query: '2031' } })) as any).content[0].text);
  assert.deepEqual(found.issues.map((i: any) => i.id), [4, 1]);
  const shot: any = await mcp.callTool({ name: 'get_attachment', arguments: { id: 1 } });
  assert.equal(shot.content[1].type, 'image');
  await mcp.close();
  ok('网页生成 MCP 令牌 → 客户端按截图里的文字查到问题并看到截图');

  const mctx = await browser.newContext({ ...devices['iPhone 13'] });
  const m = await mctx.newPage();
  await watch(m);
  await m.goto(app.url); await m.getByLabel('密码').fill('test-password'); await m.getByRole('button', { name: '登录' }).tap();
  await m.locator('.rec').first().waitFor();
  const noOverflow = async (what: string) => { const o = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(o <= 0, `${what}横向溢出 ${o}px`); };
  assert.equal(await m.locator('.rec').count(), 4);
  assert.equal(await m.locator('table').isVisible(), false);
  for (const t of ['已解决', '待处理', 'QQ', '网页']) assert.ok(await m.locator('.rec', { hasText: t }).first().isVisible(), t);
  await until(async () => m.locator('.rec img').first().evaluate((i: any) => i.naturalWidth > 0));
  await noOverflow('列表'); await m.screenshot({ path: path.join(OUT, '6-手机列表.png') });
  await m.getByRole('button', { name: '筛选' }).tap();
  await m.screenshot({ path: path.join(OUT, '9-手机筛选.png') }); await noOverflow('筛选');
  await m.getByLabel('全部来路').selectOption('web'); await m.getByText('共 1 条').waitFor();
  await m.getByRole('button', { name: '筛选 1' }).waitFor();
  await m.goto(app.url + '/#/feedbacks'); await m.getByText('共 4 条').waitFor();
  await m.getByLabel('搜索').fill('2031'); await m.getByLabel('搜索').press('Enter'); await m.getByText('共 2 条').waitFor();
  await m.locator('.rec').last().tap(); await m.getByRole('heading', { name: /#1/ }).waitFor();
  await until(async () => m.locator('.att img').first().evaluate((i: any) => i.naturalWidth > 0));
  await noOverflow('详情'); await m.screenshot({ path: path.join(OUT, '7-手机详情.png') });
  await m.locator('.att img').first().tap(); await m.locator('dialog.img img').waitFor(); await m.locator('dialog.img').tap();
  for (const h of ['topics', 'topics/1', 'stats', 'settings']) { await m.goto(`${app.url}/#/${h}`); await m.locator('main .card, main .tablewrap').first().waitFor(); await noOverflow(h); await m.screenshot({ path: path.join(OUT, `10-手机-${h.replace('/', '-')}.png`) }); }
  await m.emulateMedia({ colorScheme: 'dark' }); await m.locator('nav a', { hasText: '提交记录' }).tap(); await m.locator('.rec').first().waitFor();
  await m.screenshot({ path: path.join(OUT, '11-手机深色.png') });
  // 在 QQ 里提交后切回页面，记录自动出现
  mock.say(U, '提交：手机端看得到新记录吗'); await reply(/已记录 #5/);
  await m.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await m.locator('.rec', { hasText: '手机端看得到新记录吗' }).waitFor();
  const wm: any = await (await fetch(app.url + '/manifest.webmanifest')).json();
  for (const i of wm.icons) assert.equal((await fetch(`${app.url}/${i.src}`)).status, 200);
  await mctx.close();
  ok('手机：卡片列表、筛选、搜索、看截图、各页无溢出、深色、QQ 提交后刷新可见、可加到主屏幕');
  await p.getByRole('button', { name: '退出' }).click(); await p.getByLabel('密码').waitFor();
  ok('退出登录');
  assert.deepEqual(errors, [], '浏览器控制台报错');
  console.log('\n端到端全部通过');
} catch (e) {
  console.log('✗ 失败', e, errors, mock.sent.map((s) => s.content));
  process.exitCode = 1;
} finally {
  await app?.close(); await mock.stop(); await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit();
}
