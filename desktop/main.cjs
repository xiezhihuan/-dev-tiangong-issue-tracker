const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, powerSaveBlocker, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const importer = require('./importer.cjs');
const { Service } = require('./service.cjs');
const { Settings, SettingsError, normalizeUrl, randomPassword } = require('./settings.cjs');

const NAME = '天工反馈', MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
/** 同一件事在两个系统里的叫法。 */
const WORD = MAC ? { tray: '菜单栏', vault: '系统钥匙串', trash: '废纸篓', firewall: `到「系统设置 → 网络 → 防火墙」允许${NAME}接受传入连接` } : { tray: '系统托盘', vault: 'Windows 数据保护', trash: '回收站', firewall: `到「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」勾选${NAME}（专用网络）` };
app.setName(NAME);
if (WIN) app.setAppUserModelId('com.tiangong.feedback'); // 与安装包快捷方式一致，通知才能显示
const HOME = process.env.TG_HOME || path.join(app.getPath('appData'), 'com.tiangong.feedback');
fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(HOME, 'electron'));
if (!app.requestSingleInstanceLock()) app.exit(0);

let settings, service, main, panel, tray, blocker = null, quitting = false, booting = true, pendingImport = null, lastNotice = null;
const UI = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;
const asset = (f) => path.join(__dirname, 'assets', f);
const server = (f) => import(pathToFileURL(path.join(__dirname, 'server', 'dist', f)).href);

// ───── 状态 ─────
const snapshot = () => ({ settings: settings.view(), state: service.state, error: service.error, snap: service.snap, version: app.getVersion(), platform: process.platform, word: WORD, home: HOME, hostname: os.hostname().replace(/\.local$/, ''), wantImport: pendingImport && { issues: pendingImport.issues, attachments: pendingImport.attachments, users: pendingImport.users, dir: pendingImport.dataDir } });
const broadcast = () => { if (panel && !panel.isDestroyed()) panel.webContents.send('change', snapshot()); refreshTray(); };
function applySystem() {
  const v = settings.v;
  if (app.isPackaged && !process.env.TG_HOME) app.setLoginItemSettings({ openAtLogin: v.configured && v.autostart, ...(WIN ? { args: ['--hidden'] } : {}) });
  const want = v.configured && v.keepAwake;
  if (want && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
}

// ───── 窗口 ─────
function openPanel(view) {
  if (quitting) return;
  if (!panel || panel.isDestroyed()) {
    panel = new BrowserWindow({ width: 1000, height: 740, minWidth: 820, minHeight: 600, title: NAME, ...(MAC ? { titleBarStyle: 'hiddenInset' } : { icon: asset('icon.ico'), autoHideMenuBar: true }), show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181b' : '#f4f5f7', webPreferences: { preload: path.join(__dirname, 'preload-settings.cjs'), contextIsolation: true, sandbox: true } });
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.webContents.on('will-navigate', (e) => e.preventDefault());
    panel.loadURL(UI);
    panel.once('ready-to-show', () => { panel.show(); if (view) panel.webContents.send('view', view); });
    guardSession(panel);
    panel.on('close', (e) => { if (!quitting) { e.preventDefault(); panel.hide(); hideDock(); } });
  } else { panel.show(); if (view) panel.webContents.send('view', view); }
  app.dock?.show(); panel.focus();
}
/** 两个窗口都收起后只留菜单栏图标。 */
function hideDock() { if (![main, panel].some((w) => w && !w.isDestroyed() && w.isVisible())) app.dock?.hide(); }

/** Windows 关机 / 注销：只能从窗口事件得知。 */
function guardSession(w) { if (WIN) w.on('session-end', () => { quitting = true; service.child?.postMessage({ type: 'stop' }); }); }

async function signIn(origin) {
  const r = await fetch(origin + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'tg' }, body: JSON.stringify({ password: settings.secrets.adminPassword }) });
  const m = /^tg_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`自动登录失败（${r.status}）`);
  await session.fromPartition('persist:main').cookies.set({ url: origin, name: 'tg_session', value: m[1], path: '/', httpOnly: true, sameSite: 'strict', expirationDate: Date.now() / 1000 + 29 * 86400 });
}
async function openMain(hash = '') {
  if (quitting) return;
  if (!settings.v.configured) return openPanel();
  if (service.state !== 'running' || !service.snap) return openPanel('status');
  const origin = service.snap.url;
  try { await signIn(origin); } catch (e) { console.error(e); } // 失败时页面自己会显示登录框
  if (quitting) return;
  if (!main || main.isDestroyed()) {
    main = new BrowserWindow({ width: 1240, height: 820, minWidth: 400, minHeight: 500, title: NAME, ...(MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } } : { icon: asset('icon.ico'), autoHideMenuBar: true }), show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181b' : '#f4f5f7', webPreferences: { preload: path.join(__dirname, 'preload-main.cjs'), partition: 'persist:main', contextIsolation: true, sandbox: true } });
    const wc = main.webContents;
    const local = (u) => { try { return new URL(u).origin === service.snap?.url; } catch { return false; } };
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !local(url)) shell.openExternal(url); return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => { if (!local(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
    wc.session.setPermissionRequestHandler((_w, p, cb) => cb(p === 'clipboard-sanitized-write'));
    main.on('page-title-updated', (e) => e.preventDefault());
    guardSession(main);
    main.on('close', (e) => { if (!quitting) { e.preventDefault(); main.hide(); hideDock(); } });
  }
  const at = main.webContents.getURL();
  if (!at.startsWith(origin + '/') || hash) await main.loadURL(origin + '/' + (hash || '#/feedbacks')).catch((e) => console.error(e));
  if (quitting || main.isDestroyed()) return; // 加载期间可能已经在退出
  app.dock?.show(); main.show(); main.focus();
}

// ───── 菜单 ─────
const BOT = { online: '机器人在线', connecting: '机器人连接中', offline: '机器人离线，自动重连中', blocked: '机器人无法连接', disabled: '未连接 QQ', stopped: '机器人已停止' };
function statusLine() {
  if (!settings.v.configured) return '尚未设置';
  if (service.state === 'running') return `运行中 · ${BOT[service.snap?.bot.state] ?? '正在启动'}`;
  return service.state === 'starting' ? '正在启动…' : service.error?.message ?? '服务已停止';
}
let trayKey = '';
function refreshTray() {
  if (!tray) return;
  const s = service.snap, lan = s?.access.find((a) => a.kind === 'lan') ?? s?.access[0], key = JSON.stringify([statusLine(), s?.todo, lan?.url]);
  if (key === trayKey) return;
  trayKey = key;
  tray.setToolTip(`${NAME} — ${statusLine()}`);
  if (MAC) tray.setTitle(service.state === 'error' ? ' ⚠️' : '');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLine(), enabled: false },
    ...(s ? [{ label: `待处理 ${s.todo} 条 · 今天新增 ${s.today} 条`, enabled: false }] : []),
    { type: 'separator' },
    { label: '打开问题库', enabled: !!s, click: () => openMain() },
    { label: '控制台…', click: () => openPanel('status') },
    { label: '复制手机访问地址', enabled: !!lan, click: () => clipboard.writeText(lan.url) },
    { label: '在浏览器中打开', enabled: !!s, click: () => shell.openExternal(s.url) },
    { type: 'separator' },
    { label: '重启服务', enabled: settings.v.configured, click: () => service.restart(settings.env()) },
    { label: `退出${NAME}`, click: () => app.quit() },
  ]));
}
function buildMenu() {
  if (!MAC) return Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ label: '控制台…', accelerator: 'Ctrl+,', click: () => openPanel('status') }, { label: '问题库', accelerator: 'Ctrl+1', click: () => openMain() }, { type: 'separator' }, { role: 'close', label: '关闭窗口' }, { label: `退出${NAME}`, click: () => app.quit() }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '显示', submenu: [{ label: '重新加载', accelerator: 'Ctrl+R', click: () => { if (main && !main.isDestroyed() && main.isFocused()) main.webContents.reload(); } }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'resetZoom', label: '实际大小' }, { role: 'togglefullscreen', label: '全屏' }] },
  ]));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: NAME, submenu: [{ role: 'about', label: `关于${NAME}` }, { type: 'separator' }, { label: '控制台…', accelerator: 'Cmd+,', click: () => openPanel('status') }, { type: 'separator' }, { role: 'hide', label: `隐藏${NAME}` }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '全部显示' }, { type: 'separator' }, { role: 'quit', label: `退出${NAME}` }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '拷贝' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '显示', submenu: [{ label: '问题库', accelerator: 'Cmd+1', click: () => openMain() }, { label: '重新加载', accelerator: 'Cmd+R', click: () => { if (main && !main.isDestroyed() && main.isFocused()) main.webContents.reload(); } }, { type: 'separator' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'resetZoom', label: '实际大小' }, { role: 'togglefullscreen', label: '全屏' }] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭窗口' }] },
  ]));
}

// ───── 控制台接口 ─────
const within = (p, ms) => Promise.race([p, new Promise((_r, j) => setTimeout(() => j(new Error('超时，请检查网络')), ms))]);
async function qqCheck(appId, secret) {
  const { QQApi } = await server('qq/api.js');
  const api = new QQApi({ appId, secret, base: process.env.QQ_API_BASE || 'https://api.bot.qq.com', timeoutMs: 8000, retryDelayMs: 200 });
  return within((async () => { await api.getToken(); await api.gatewayUrl(); return (await api.me()).username; })(), 20_000);
}
const ops = {
  get: () => snapshot(),
  randomPassword: () => randomPassword(),
  password: () => settings.secrets.adminPassword ?? '',
  copy: (t) => clipboard.writeText(String(t)),
  async testQQ(appId, secret) {
    const id = String(appId ?? '').trim(), sec = String(secret ?? '').trim() || settings.secrets.qqSecret;
    if (!/^\d{5,}$/.test(id)) throw new SettingsError('请填写 AppID（一串数字）', 'qqAppId');
    if (!sec) throw new SettingsError('请填写 AppSecret', 'qqSecret');
    return qqCheck(id, sec);
  },
  async testPublic(raw) {
    const url = normalizeUrl(raw);
    if (!url) throw new SettingsError('请先填写外网地址', 'publicUrl');
    let d;
    try { const r = await fetch(url + '/healthz', { signal: AbortSignal.timeout(10_000), redirect: 'manual' }); d = await r.json(); } catch { throw new Error('连不上，或返回的不是本服务。请确认穿透已指向本机端口'); }
    if (d?.ok !== true || !('bot' in d)) throw new Error('能连上，但返回的不是本服务');
    return url;
  },
  async importPick() {
    const r = await dialog.showOpenDialog(panel, { title: '选择旧版的项目文件夹或 data 文件夹', properties: ['openDirectory', 'showHiddenFiles'], buttonLabel: '选择' });
    if (r.canceled || !r.filePaths[0]) return null;
    if (fs.existsSync(path.join(settings.dataDir, 'feedback.db'))) throw new Error('本机已有数据，为避免覆盖不能再导入');
    pendingImport = importer.inspect(r.filePaths[0]);
    const running = await importer.running(pendingImport);
    const e = pendingImport.env;
    return { ...snapshot().wantImport, running: !!running, oldPid: running?.pid ?? 0, prefill: e && { qqAppId: e.qqAppId, port: e.port, publicUrl: e.publicUrl, qqSecret: e.qqSecret, adminPassword: e.adminPassword } };
  },
  importStop: async (pid) => { if (Number(pid)) await importer.stopOld(Number(pid)); else if (pendingImport && (await importer.running(pendingImport))) throw new Error('旧版还在运行，请先在它的窗口里按 Ctrl+C 或关闭窗口'); },
  /** 引导最后一步：（可选）导入 → 保存 → 启动。 */
  async finish(patch, withImport) {
    settings.save(patch); // 先校验保存，configured 仍是 false
    if (withImport && pendingImport && !fs.existsSync(path.join(settings.dataDir, 'feedback.db'))) {
      if (await importer.running(pendingImport)) throw new Error('旧版服务还在运行，请先停止它，再开始导入');
      importer.copy(pendingImport, settings.dataDir);
    }
    const ok = await service.restart(settings.env()).then(() => service.state === 'running');
    if (!ok) { const e = new Error(service.error?.message ?? '服务启动失败'); if (service.error?.code === 'port') e.field = 'port'; throw e; }
    settings.save({ configured: true });
    pendingImport = null;
    applySystem(); broadcast();
  },
  async save(patch) {
    settings.save(patch); applySystem(); broadcast();
    await service.restart(settings.env());
    if (service.state !== 'running') { const e = new Error(`已保存，但服务没有启动：${service.error?.message ?? ''}`); if (service.error?.code === 'port') e.field = 'port'; throw e; }
    if (main && !main.isDestroyed() && main.isVisible()) { await signIn(service.snap?.url ?? `http://127.0.0.1:${settings.v.port}`).catch(() => {}); await main.loadURL(`http://127.0.0.1:${settings.v.port}/#/feedbacks`).catch(() => {}); }
  },
  restart: async () => { await service.restart(settings.env()); if (service.state !== 'running') throw new Error(service.error?.message ?? '服务没有启动'); },
  /** 端口被占用：返回是谁；kill=true 时结束它（仅限旧版服务）。 */
  async portFix(kill, port) {
    const o = await importer.portOwner(Number(port) || settings.v.port);
    if (!o) return null;
    if (kill) { await importer.stopOld(o.pid); return null; }
    return { pid: o.pid, name: o.name, old: await importer.isOld(o.pid) };
  },
  bindCode: () => service.call('bindCode'),
  unbind: (o) => service.call('unbind', o),
  createToken: (n) => service.call('createToken', n),
  removeToken: (i) => service.call('removeToken', i),
  async openMain(hash) { await openMain(/^#\/[\w/?=&-]*$/.test(hash ?? '') ? hash : ''); if (main?.isVisible()) panel?.hide(); },
  openPath: async (k) => { const p = { data: settings.dataDir, log: service.logFile }[k]; if (!p || !fs.existsSync(p)) throw new Error('还没有生成'); k === 'log' ? shell.showItemInFolder(p) : await shell.openPath(p); },
  openExternal: async (k) => { const u = { qq: 'https://q.qq.com', web: service.snap?.url }[k]; if (u) await shell.openExternal(u); },
  async doctor() {
    const out = [], check = async (name, fn) => { try { out.push({ name, ok: true, text: (await fn()) || '正常' }); } catch (e) { out.push({ name, ok: false, text: e.message }); } };
    await check('服务', () => { if (service.state !== 'running') throw new Error(service.error?.message ?? '没有在运行'); return `端口 ${settings.v.port}`; });
    await check('数据目录', () => { const f = path.join(HOME, '.w'); fs.writeFileSync(f, ''); fs.rmSync(f); const st = fs.statfsSync(HOME), gb = st.bavail * st.bsize / 1e9; if (gb < 1) throw new Error(`磁盘只剩 ${gb.toFixed(1)} GB`); return `可写，磁盘剩余 ${gb.toFixed(0)} GB`; });
    await check('密钥保存', () => { if (settings.secretError) throw new Error(settings.secretError); });
    await check('本机访问', async () => { const r = await fetch(`http://127.0.0.1:${settings.v.port}/healthz`, { signal: AbortSignal.timeout(5000) }); if (!(await r.json()).ok) throw new Error('无响应'); });
    if (settings.v.scope === 'lan') await check('局域网访问', async () => {
      const lan = (service.snap?.access ?? []).filter((a) => a.kind === 'lan');
      if (!lan.length) throw new Error('没有找到局域网地址，请检查 Wi-Fi 或网线');
      for (const a of lan) await fetch(a.url + '/healthz', { signal: AbortSignal.timeout(5000) }).catch(() => { throw new Error(`${a.url} 打不开`); });
      return `${lan.map((a) => a.url).join('、')}（若手机打不开，${WORD.firewall}）`;
    });
    if (settings.v.publicUrl) await check('外网访问', async () => ops.testPublic(settings.v.publicUrl));
    if (!settings.v.skipQQ) {
      await check('QQ 凭据', async () => `机器人「${await qqCheck(settings.v.qqAppId, settings.secrets.qqSecret ?? '')}」`);
      await check('QQ 连接', async () => { for (let i = 0; i < 40 && service.snap?.bot.state === 'connecting'; i++) await new Promise((r) => setTimeout(r, 200)); const b = service.snap?.bot; if (b?.state !== 'online') throw new Error(b?.reason || BOT[b?.state] || '没有连接'); return '在线'; });
    }
    if (settings.v.ocr) await check('截图文字识别', () => { if (service.snap?.ocr !== 'ready') throw new Error('不可用（不影响收录，只是截图无法被搜索）'); });
    await check('附件', () => { const n = service.snap?.failed ?? 0; if (n) throw new Error(`${n} 个附件没能保存，可到问题详情里重试`); });
    return out;
  },
  async reset() {
    const r = await dialog.showMessageBox(panel, { type: 'warning', buttons: ['取消', '清空所有数据'], defaultId: 0, cancelId: 0, message: '清空这台电脑上的全部数据？', detail: '问题、截图、备份、设置和密钥都会移到${WORD.trash}，软件回到刚安装时的状态。' });
    if (r.response !== 1) return false;
    await service.stop();
    if (main && !main.isDestroyed()) { main.destroy(); main = null; }
    const stamp = path.join(HOME, `已清空-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(stamp);
    for (const f of ['data', 'logs', 'config.json', 'secrets.json']) if (fs.existsSync(path.join(HOME, f))) fs.renameSync(path.join(HOME, f), path.join(stamp, f));
    await shell.trashItem(stamp).catch((e) => console.error('移到回收站失败，保留在原处', e));
    await session.fromPartition('persist:main').clearStorageData();
    settings.load(); pendingImport = null; applySystem(); broadcast();
    return true;
  },
};
ipcMain.handle('tg', async (e, op, args) => {
  // 只接受控制台页面的调用
  if (e.sender !== panel?.webContents || !e.senderFrame?.url.startsWith(UI) || !Object.hasOwn(ops, op)) return { ok: false, error: '不允许的调用' };
  try { return { ok: true, value: await ops[op](...args) }; } catch (err) { if (!(err instanceof SettingsError)) console.error(op, err.message); return { ok: false, error: err.message, field: err.field }; }
});
ipcMain.on('open-settings', (e) => { if (e.sender === main?.webContents) openPanel('status'); });

// ───── 启动与退出 ─────
app.whenReady().then(async () => {
  if (quitting) return;
  settings = new Settings(HOME, {
    encrypt: (s) => { if (!safeStorage.isEncryptionAvailable()) throw new Error(`${WORD.vault}不可用`); return safeStorage.encryptString(s); },
    decrypt: (b) => safeStorage.decryptString(b),
  });
  service = new Service(HOME);
  let noticed = '';
  service.on('change', () => {
    const st = service.state, bot = service.snap?.bot.state;
    const bad = settings.v.configured && (st === 'error' ? service.error.message : bot === 'blocked' ? `QQ 机器人无法连接：${service.snap.bot.reason}` : '');
    if (bad && bad !== noticed) notify('需要处理', bad, () => openPanel('status'));
    noticed = bad;
    if (MAC) app.dock.setBadge(service.snap?.todo ? String(service.snap.todo) : '');
    broadcast();
  });
  service.on('new', (m) => { if (settings.v.notify) notify(`新问题 #${m.id}`, m.title, () => openMain(`#/feedbacks/${m.id}`)); });
  buildMenu();
  const img = nativeImage.createFromPath(asset(WIN ? 'icon.ico' : 'trayTemplate.png'));
  if (MAC) img.setTemplateImage(true);
  tray = new Tray(img);
  if (!MAC) tray.on('click', () => openMain()); // Windows 习惯：左键打开，右键菜单
  refreshTray();
  // 关机 / 注销：立即让服务收尾并放行，绝不能拦，否则会打断系统关机（数据库写入是事务，QQ 消息下次补发）
  powerMonitor.on('shutdown', () => { quitting = true; service.child?.postMessage({ type: 'stop' }); });
  app.on('activate', () => { if (!booting) openMain(); });
  app.on('second-instance', () => { if (!booting) openMain(); });
  if (!settings.v.configured) { booting = false; return openPanel(); }
  applySystem();
  if (!settings.secrets.adminPassword) { service.set('error', { code: 'secret', message: settings.secretError || '登录密码丢失，请到设置里重新填写' }); booting = false; return openPanel('status'); }
  const silent = app.getLoginItemSettings().wasOpenedAtLogin || process.argv.includes('--hidden');
  if (silent) app.dock?.hide();
  await service.start(settings.env());
  booting = false;
  if (!silent) await waitSnap().then(() => openMain());
}).catch((e) => { if (quitting) return; dialog.showErrorBox(`${NAME}启动失败`, e.stack ?? String(e)); app.exit(1); });

const waitSnap = () => new Promise((ok) => { const t = setInterval(() => { if (quitting || service.snap || ['error', 'stopped'].includes(service.state)) { clearInterval(t); ok(); } }, 50); });
function notify(title, body, click) { if (quitting) return; lastNotice = { title, body }; if (!Notification.isSupported()) return; const n = new Notification({ title, body, silent: false }); n.on('click', click); n.show(); }
app.on('window-all-closed', () => { /* 常驻菜单栏 */ });
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  (service ? service.stop() : Promise.resolve()).catch(() => {}).finally(() => app.exit(0)); // 不能再调 quit：停得太快时会被忽略，程序退不掉
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => app.quit());
if (process.env.TG_HOME) global.__test = { get notice() { return lastNotice; }, get tray() { return trayKey; }, get pid() { return service.child?.pid; } };
