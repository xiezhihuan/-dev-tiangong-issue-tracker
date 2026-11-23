/** 驱动打包后的 .app：引导、绑定、提交、局域网、设置、崩溃恢复、导入、重置。截图在 test-output/desktop。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { MockQQ } from '../../test/mock-qq.js';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const APP = process.env.TG_APP ?? path.join(here, '../release/天工反馈.app'), OUT = path.join(root, 'test-output/desktop');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const ok = (s: string) => console.log('✓ ' + s), sleep = (n: number) => new Promise((r) => setTimeout(r, n));
async function until<T>(fn: () => T | Promise<T>, what: string, ms = 20_000): Promise<NonNullable<T>> { const end = Date.now() + ms; let err: unknown; for (;;) { try { const v = await fn(); if (v) return v as NonNullable<T>; } catch (e) { err = e; } if (Date.now() > end) throw new Error('等待超时：' + what, { cause: err }); await sleep(80); } }
const freePort = () => new Promise<number>((ok2) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok2(p)); }); });
const U = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4';
const errors: string[] = [];
const health = async (u: string) => { try { return (await fetch(u + '/healthz', { signal: AbortSignal.timeout(2000) })).status; } catch { return 0; } };

const mock = new MockQQ(); await mock.start();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tgapp-'));
let el: ElectronApplication;
async function launch(h = home, extra: string[] = []): Promise<void> {
  el = await _electron.launch({ executablePath: path.join(APP, 'Contents/MacOS/天工反馈'), args: ['--use-mock-keychain', ...extra], env: { ...process.env as Record<string, string>, TG_HOME: h, QQ_API_BASE: mock.base, NO_PROXY: '127.0.0.1' } });
  el.on('window', (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(m.text()); }); });
}
const win = (re: RegExp): Promise<Page> => until(() => el.windows().find((w) => re.test(w.url())), `窗口 ${re}`);
const panel = () => win(/ui\/index\.html/), mainWin = () => win(/^http:\/\/127/);
const visible = (re: string) => el.evaluate(({ BrowserWindow }, r) => BrowserWindow.getAllWindows().some((w) => new RegExp(r).test(w.webContents.getURL()) && w.isVisible()), re);
const t = (k: 'notice' | 'tray' | 'pid') => el.evaluate((_e, key) => (globalThis as any).__test[key], k);
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(OUT, n + '.png') });
const fits = async (p: Page, n: string) => { const o = await p.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, ...[...document.querySelectorAll('.main, .main *')].map((x) => x.getBoundingClientRect().right - innerWidth))); assert.ok(o <= 0, `${n} 横向溢出 ${o}`); };

try {
  for (const how of ['SIGTERM', 'quit'] as const) {
    await launch(); await (await panel()).getByRole('button', { name: '开始设置' }).waitFor();
    const proc = el!.process();
    if (how === 'SIGTERM') proc.kill('SIGTERM'); else await el!.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); });
    await until(() => proc.exitCode !== null || proc.signalCode !== null, `未设置时 ${how} 能退出`, 8000);
  }
  ok('未设置时也能正常退出');
  // ───── 引导 ─────
  await launch();
  let p = await panel();
  await p.getByRole('heading', { name: '天工反馈' }).waitFor(); await shot(p, '01-封面'); await fits(p, '封面');
  await p.getByRole('button', { name: '开始设置' }).click();
  await p.getByRole('button', { name: '下一步' }).click(); await p.getByText('请填写 AppID').waitFor();
  await p.getByLabel('AppID').fill('12345678'); await p.getByLabel('AppSecret').fill('wrong');
  await p.getByRole('button', { name: '测试连接' }).click(); await p.getByText('invalid appid or secret').waitFor();
  await p.getByLabel('AppSecret').fill('sec');
  await p.getByRole('button', { name: '测试连接' }).click(); await p.getByText('连接成功，机器人「测试机器人」').waitFor();
  await p.locator('#qqHelp summary').click(); await shot(p, '02-QQ机器人');
  await p.getByRole('button', { name: '下一步' }).click();
  await p.getByRole('button', { name: '下一步' }).click(); await p.getByText('请设置登录密码').waitFor();
  await p.getByRole('button', { name: '生成' }).click();
  const pw = await until(() => p.locator('#adminPassword').inputValue(), '生成密码'); assert.equal(pw.length, 12);
  const busyPort = await freePort(), hog = http.createServer((_q, r) => r.end('x')); await new Promise<void>((r) => hog.listen(busyPort, '0.0.0.0', r));
  await p.locator('#port').fill(String(busyPort)); await p.getByText(`监听 0.0.0.0:${busyPort}`).waitFor();
  assert.equal(await p.locator('.invalid').count(), 0, '改对后不再标红'); await shot(p, '03-访问');
  await p.getByRole('button', { name: '下一步' }).click();
  await p.getByText('测试机器人（12345678）').waitFor(); await shot(p, '04-确认');
  ok('引导：逐步校验、测试 QQ 凭据、生成密码');
  await p.getByRole('button', { name: '启动' }).click();
  await p.getByText(`端口 ${busyPort} 已被占用`).waitFor({ timeout: 30_000 });
  await p.getByText(/占用它的是/).waitFor(); assert.doesNotMatch(await p.locator('#portFix').innerText(), /false/); assert.equal(await p.locator('.invalid').count(), 1); await shot(p, '05-端口占用');
  assert.equal(await p.getByRole('button', { name: '停止旧版' }).count(), 0, '不是旧版就不给停止按钮');
  const port = await freePort();
  await p.locator('#port').fill(String(port)); hog.close();
  await p.getByRole('button', { name: '下一步' }).click(); await p.getByRole('button', { name: '启动' }).click();
  const code = await (async () => { await p.locator('.code').waitFor({ timeout: 40_000 }); return p.locator('.code').innerText(); })();
  ok('端口冲突：说明被谁占用，换端口后启动');
  await p.locator('#bindBox').getByText('机器人在线').waitFor(); await shot(p, '06-绑定');
  mock.say(U, code); await p.getByText('已绑定：小工').waitFor(); await shot(p, '07-绑定成功');
  ok('显示绑定码 → QQ 发送 → 界面自动变为已绑定');

  // ───── 问题库 ─────
  await p.getByRole('button', { name: '进入问题库' }).click();
  let m = await mainWin(); await m.getByText('还没有反馈').waitFor();
  assert.equal(await m.getByLabel('密码').count(), 0);
  assert.deepEqual(await m.evaluate(() => [typeof (globalThis as any).require, Object.keys((globalThis as any).tgDesktop)]), ['undefined', ['openSettings']]);
  mock.say(U, '提交：导出报表一直转圈'); await until(() => mock.sent.find((s) => /已记录 #1/.test(s.content)), '回执');
  await until(async () => (await t('notice'))?.title === '新问题 #1', '系统通知', 15_000);
  assert.equal((await t('notice')).body, '导出报表一直转圈');
  await m.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await m.locator('tr', { hasText: '导出报表一直转圈' }).waitFor(); await shot(m, '08-问题库');
  assert.match(await t('tray'), /机器人在线/);
  ok('问题库自动登录；QQ 提交后弹通知、列表可见');
  await m.getByRole('button', { name: '控制台' }).click(); p = await panel();
  await p.getByText('服务运行中').waitFor(); await p.locator('img.qr').waitFor(); await sleep(300); await shot(p, '09-运行状态'); await fits(p, '运行状态');
  const lan = (await p.locator('#phoneCard .url').first().innerText()).trim();
  assert.match(lan, new RegExp(`^http://\\d+\\.\\d+\\.\\d+\\.\\d+:${port}$`)); assert.ok(!lan.includes('127.0.0.1'));
  assert.equal(await health(lan), 200);
  const lg = await fetch(lan + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'tg' }, body: JSON.stringify({ password: pw }) });
  assert.equal(lg.status, 200); assert.doesNotMatch(lg.headers.get('set-cookie')!, /Secure/);
  assert.equal((await fetch(lan + '/api/feedbacks')).status, 401);
  ok(`局域网地址 ${lan} 可访问，需要密码登录`);

  // ───── 关窗、崩溃 ─────
  await el.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close()));
  await until(async () => !(await visible('.*')), '窗口收起'); assert.equal(await health(lan), 200);
  ok('关闭窗口后服务继续运行');
  const pid = await t('pid'); process.kill(pid, 'SIGKILL');
  await until(async () => (await t('pid')) && (await t('pid')) !== pid && (await health(lan)) === 200, '崩溃后自动重启', 30_000);
  ok('服务进程被杀后自动重启');

  // ───── 设置 ─────
  await el.evaluate(({ app }) => { app.emit('activate'); }); m = await mainWin(); await until(() => visible('^http'), '点 Dock 图标打开问题库');
  await m.getByRole('button', { name: '控制台' }).click();
  await p.getByRole('button', { name: '设置', exact: true }).click(); await shot(p, '10-设置');
  await p.locator('#stepper').getByText('AI 助手').click();
  await p.getByLabel('令牌名称').fill('我的 Claude'); await p.getByRole('button', { name: '生成访问令牌' }).click();
  const cmd = await p.locator('.cmd').first().innerText(), token = /Bearer (tgm_[\w-]+)/.exec(cmd)![1]!; await shot(p, '11-AI助手');
  const rpc = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_issues', arguments: { query: '转圈' } } }) });
  assert.match(await rpc.text(), /导出报表一直转圈/);
  ok('生成 MCP 令牌并查到问题');
  await p.locator('#stepper').getByRole('button', { name: '访问' }).click();
  await p.locator('#publicBox summary').click(); await p.locator('#publicUrl').fill(`http://127.0.0.1:${port}`); await p.getByRole('button', { name: '测试', exact: true }).click(); await p.getByText('可以访问').waitFor();
  await p.locator('#publicUrl').fill('https://fb.example.com/x'); await p.getByRole('button', { name: '保存并重启服务' }).click(); await p.getByText('不要带路径').waitFor();
  await p.locator('#publicUrl').fill(''); await p.getByText('仅这台电脑', { exact: true }).click(); await p.getByRole('button', { name: '保存并重启服务' }).click();
  await p.getByText('已保存，服务已重启').waitFor({ timeout: 30_000 });
  assert.equal(await health(lan), 0); assert.equal(await health(`http://127.0.0.1:${port}`), 200);
  await p.getByText('局域网内都能打开').click(); await p.getByRole('button', { name: '保存并重启服务' }).click(); await until(async () => (await health(lan)) === 200, '恢复局域网');
  ok('外网地址测试与校验；「仅这台电脑」时局域网打不开，切回后恢复');
  await p.locator('#nav').getByText('诊断').click(); await p.getByRole('button', { name: '开始自检' }).click(); await p.locator('.mark').first().waitFor({ timeout: 30_000 });
  const bad = await p.locator('#checks .item:has(.mark.bad)').allInnerTexts(); await shot(p, '12-诊断');
  assert.deepEqual(bad, [], '自检应全部通过'); ok('诊断全部通过（含文字识别）');
  await p.emulateMedia({ colorScheme: 'dark' }); await p.locator('#nav').getByText('运行状态').click(); await sleep(200); await shot(p, '13-深色'); await p.emulateMedia({ colorScheme: null });
  await el.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => /index\.html/.test(x.webContents.getURL()))!; w.setSize(820, 600); }); await sleep(300); await fits(p, '最小窗口'); await shot(p, '14-最小窗口');

  // ───── 退出、再次打开 ─────
  const last = await t('pid'); await el.close();
  await until(async () => (await health(lan)) === 0, '退出后端口释放'); assert.throws(() => process.kill(last, 0), '服务进程已退出');
  const disk = ['config.json', 'secrets.json'].map((f) => fs.readFileSync(path.join(home, f), 'utf8')).join(); assert.ok(!disk.includes(pw));
  await launch(); m = await mainWin(); await m.locator('tr', { hasText: '导出报表一直转圈' }).waitFor({ timeout: 30_000 });
  assert.equal(await visible('index\\.html'), false);
  ok('退出干净；密钥不落明文；再次打开直接进入问题库');

  // ───── 关机、静默启动、启动途中退出 ─────
  let proc = el!.process(); const svc = await t('pid');
  await el!.evaluate(({ app, powerMonitor }) => { let blocked = false; app.on('before-quit', (e) => { blocked = e.defaultPrevented; (globalThis as any).blocked = blocked; }); setTimeout(() => { powerMonitor.emit('shutdown'); app.quit(); }, 10); });
  await until(() => proc.exitCode !== null || proc.signalCode !== null, '关机时不拦截、立即退出', 4000);
  await until(() => { try { process.kill(svc, 0); return false; } catch { return true; } }, '服务一起退出'); assert.equal(await health(lan), 0);
  await launch(home, ['--hidden']); await until(async () => (await health(lan)) === 200, '静默启动后服务可用'); await sleep(1500);
  assert.equal(await visible('.*'), false, '开机启动不弹窗口');
  await el!.evaluate(({ app }) => { app.emit('activate'); }); m = await mainWin(); await m.locator('tr', { hasText: '导出报表一直转圈' }).waitFor(); await el!.close();
  await until(async () => (await health(lan)) === 0, '退出');
  proc = spawn(path.join(APP, 'Contents/MacOS/天工反馈'), ['--use-mock-keychain'], { env: { ...process.env, TG_HOME: home, QQ_API_BASE: mock.base } });
  await sleep(700); const at = Date.now(); proc.kill('SIGTERM'); await until(() => proc.exitCode !== null || proc.signalCode !== null, '启动途中能退出', 8000); await sleep(1500); assert.equal(await health(lan), 0);
  ok(`关机不被打断；开机静默启动；启动途中可退出（${Date.now() - at - 1500}ms）`);
  await launch(); m = await mainWin(); await m.locator('tr', { hasText: '导出报表一直转圈' }).waitFor({ timeout: 30_000 });

  // ───── 重置 ─────
  await m.getByRole('button', { name: '控制台' }).click(); p = await panel(); await p.locator('#nav').getByText('诊断').click();
  await el.evaluate(({ dialog, shell }) => { dialog.showMessageBox = (async () => ({ response: 1 })) as any; shell.trashItem = async () => {}; });
  await p.getByRole('button', { name: '清空…' }).click(); await p.getByRole('button', { name: '开始设置' }).waitFor({ timeout: 20_000 });
  assert.equal(fs.existsSync(path.join(home, 'data')), false); assert.equal(await health(`http://127.0.0.1:${port}`), 0);
  await el.close(); ok('清空数据后回到封面');

  // ───── 导入旧版 ─────
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'tgold-')), oldPort = await freePort();
  fs.writeFileSync(path.join(old, '.env'), `ADMIN_PASSWORD=old-password\nQQ_APP_ID=12345678\nQQ_APP_SECRET=sec\nPORT=${oldPort}\n`);
  const oldProc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/main.js'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ADMIN_PASSWORD: 'old-password', QQ_APP_ID: '12345678', QQ_APP_SECRET: 'sec', QQ_API_BASE: mock.base, PORT: String(oldPort), HOST: '127.0.0.1', DATA_DIR: path.join(old, 'data'), OCR_ENABLED: 'false' } });
  const ob = `http://127.0.0.1:${oldPort}`; await until(async () => (await health(ob)) === 200, '旧版启动');
  const ck = (await fetch(ob + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'tg' }, body: '{"password":"old-password"}' })).headers.get('set-cookie')!.split(';')[0]!;
  const fd = new FormData(); fd.set('text', '旧版里的问题'); fd.append('files', new Blob(['日志内容'], { type: 'text/plain' }), 'a.log');
  await fetch(ob + '/api/feedbacks', { method: 'POST', headers: { cookie: ck, 'x-requested-with': 'tg' }, body: fd });
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tgapp2-'));
  await launch(home2); p = await panel();
  await el.evaluate(({ dialog }, d) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as any; }, old);
  await p.getByRole('button', { name: '我用过旧版' }).click(); await p.getByText('旧版服务正在运行（PID').waitFor(); await shot(p, '15-导入');
  assert.equal(await p.locator('#importOk').isDisabled(), true);
  await p.getByRole('button', { name: '停止旧版' }).click(); await until(() => oldProc.exitCode !== null, '旧版优雅退出'); assert.equal(oldProc.exitCode, 0);
  await p.getByRole('button', { name: '用这些数据' }).click();
  assert.equal(await p.getByLabel('AppID').inputValue(), '12345678');
  await p.getByRole('button', { name: '下一步' }).click(); await p.getByRole('button', { name: '下一步' }).click(); await p.locator('#summary').getByText('1 条问题、1 个附件').waitFor();
  await p.getByRole('button', { name: '导入并启动' }).click(); await p.locator('#bindBox .code').waitFor({ timeout: 40_000 });
  await p.getByRole('button', { name: '稍后再绑定' }).click(); m = await mainWin(); await m.locator('tr', { hasText: '旧版里的问题' }).click();
  await m.getByText('a.log').waitFor();
  const files = fs.readdirSync(path.join(home2, 'data/files'), { recursive: true }).length; assert.ok(files > 0);
  assert.ok(fs.existsSync(path.join(old, 'data/feedback.db')), '旧文件夹不动');
  await el.close();
  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tgapp3-')); await launch(home3); p = await panel();
  await el.evaluate(({ dialog }, d) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as any; }, old);
  await p.getByRole('button', { name: '我用过旧版' }).click(); await p.getByText('只复制').waitFor(); await p.getByRole('button', { name: '取消' }).click();
  await p.getByRole('button', { name: '开始设置' }).click(); assert.equal(await p.getByLabel('AppID').inputValue(), '');
  await p.getByText('暂不连接 QQ').click(); await p.getByRole('button', { name: '下一步' }).click(); await p.locator('#adminPassword').fill('12345678'); await p.locator('#port').fill(String(await freePort()));
  await p.getByRole('button', { name: '下一步' }).click(); await p.getByRole('button', { name: '启动', exact: true }).click(); m = await mainWin(); await m.getByText('还没有反馈').waitFor({ timeout: 40_000 });
  await el.close(); fs.rmSync(home3, { recursive: true, force: true });
  ok('取消导入就不会导入；不连 QQ 也能用');
  ok('导入旧版：识别并停止旧服务、沿用设置、问题和附件都在、旧文件夹不动');
  assert.deepEqual(errors, [], '界面报错'); console.log('\n桌面端端到端全部通过');
  for (const d of [home, home2, old]) fs.rmSync(d, { recursive: true, force: true });
} catch (e) {
  console.log('✗ 失败', e, errors); process.exitCode = 1;
  try { let i = 0; for (const w of el!.windows()) await shot(w, `失败-${i++}`); } catch {}
  try { console.log(fs.readFileSync(path.join(home, 'logs/service.log'), 'utf8').slice(-2000)); } catch {}
  await el!.close().catch(() => {});
} finally { await mock.stop(); process.exit(); }
