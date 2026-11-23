'use strict';
// 控制台界面。所有动态文字都以文本节点写入。
const tg = Object.fromEntries(Object.entries(window.tgBridge).map(([k, fn]) => [k, k.startsWith('on') ? fn : async (...a) => {
  const r = await fn(...a);
  if (r.ok) return r.value;
  throw Object.assign(new Error(r.error), { field: r.field });
}]));
const $ = (id) => document.getElementById(id);
const F = $('form').elements;
const S = { v: null, guide: false, step: 0, view: 'status', dirty: false, bind: null, imp: null, qqOk: '' };

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'disabled') e.disabled = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.flat(5).filter((x) => x !== null && x !== undefined && x !== false));
  return e;
}
function icon(n) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#i-${n}`); s.append(u); return s; }
let toastT;
function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }
const copyBtn = (text, what) => el('button', { type: 'button', class: 'icon-btn', title: `复制${what}`, 'aria-label': `复制${what}`, onclick: async () => { await tg.copy(text); toast(`已复制${what}`); } }, icon('copy'));
/** 按钮忙时禁用；出错时提示。 */
const busy = (btn, fn, onErr = (e) => toast(e.message)) => async () => { if (btn.disabled) return; btn.disabled = true; try { await fn(); } catch (e) { onErr(e); } finally { btn.disabled = false; } };
const on = (id, fn, onErr) => $(id).addEventListener('click', busy($(id), fn, onErr));
const result = (id, cls, text) => { const r = $(id); r.hidden = !text; r.className = `result ${cls}`; r.replaceChildren(...(cls === 'ok' ? [icon('check')] : cls === 'bad' ? [icon('x')] : []), text ?? ''); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ───────── 导航 ─────────
function show(view) {
  S.view = view;
  $('cover').hidden = true; $('app').hidden = false; $('nav').hidden = S.guide;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('on', b.dataset.view === view);
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
  if (view === 'settings' && !S.guide) { fill(); S.step = 0; drawStep(); }
  if (view === 'doctor') $('dataDir').textContent = S.v.home;
  draw();
}
for (const b of document.querySelectorAll('.nav-item')) b.addEventListener('click', () => show(b.dataset.view));
for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', busy(b, () => tg.openMain(b.dataset.open)));
for (const b of document.querySelectorAll('[data-ext]')) b.addEventListener('click', () => tg.openExternal(b.dataset.ext));
for (const b of document.querySelectorAll('[data-path]')) b.addEventListener('click', busy(b, () => tg.openPath(b.dataset.path)));

// ───────── 运行状态 ─────────
const BOT = { online: ['在线', 'ok'], connecting: ['连接中', 'warn'], offline: ['离线，自动重连中', 'bad'], blocked: ['无法连接', 'bad'], disabled: ['未连接', ''], stopped: ['已停止', 'bad'] };
let drawn = {};
/** 内容没变就不重画，避免闪动和打断点击。 */
function part(id, data, fn) { if (same(drawn[id], data)) return; drawn[id] = data; $(id).replaceChildren(...[fn()].flat().filter(Boolean)); }
function draw() {
  const { v } = S, s = v.snap, st = v.settings;
  $('version').textContent = `版本 ${v.version}`;
  const bot = BOT[s?.bot.state] ?? ['', ''];
  const [t, c, sub] = v.state === 'running' && s ? [s.bot.state === 'blocked' ? 'QQ 机器人需要处理' : '服务运行中', ['blocked', 'offline'].includes(s.bot.state) ? 'warn' : 'ok', `${st.scope === 'lan' ? '局域网可访问' : '仅这台电脑'} · 端口 ${st.port} · ${st.skipQQ ? '未连接 QQ' : `QQ 机器人${bot[0]}`}`]
    : v.state === 'error' ? ['服务出错', 'bad', '问题和数据都还在，处理后重启即可'] : v.state === 'stopped' ? ['服务已停止', 'bad', '点「重启服务」启动'] : ['正在启动…', 'warn', '首次启动要加载文字识别模型，几秒钟'];
  $('heroTitle').textContent = t; $('heroSub').textContent = sub; $('heroDot').className = `dot ${c}`;
  const alert = v.error?.message || (s?.bot.state === 'blocked' && s.bot.reason) || st.secretError || '';
  $('alert').hidden = !alert; $('alertText').textContent = alert;
  $('alertPort').hidden = $('alertFix').hidden = true;
  if (v.error?.code === 'port') { $('alertPort').hidden = false; tg.portFix(false).then((o) => { if (S.v.error?.code !== 'port' || !o) return; $('alertText').textContent = `端口 ${st.port} 被「${o.name}」占用（PID ${o.pid}）${o.old ? '，这是旧版服务' : ''}`; $('alertFix').hidden = !o.old; $('alertFix').textContent = '停止旧版并启动'; }); }
  part('nums', s && [s.total, s.todo, s.today], () => [['全部问题', s?.total, '#/feedbacks'], ['待处理', s?.todo, '#/feedbacks?status=todo'], ['今天新增', s?.today, '#/feedbacks']].map(([k, n, h]) => el('button', { disabled: !s, onclick: () => tg.openMain(h).catch((e) => toast(e.message)) }, el('span', { class: 'sub' }, k), el('b', {}, n ?? '—'))));
  part('phoneCard', [s?.access, st.scope], () => {
    const head = el('h2', {}, icon('phone'), '手机查看');
    if (!s) return [head, el('div', { class: 'sub' }, '服务启动后显示')];
    if (!s.access.length) return [head, el('div', { class: 'sub' }, st.scope === 'lan' ? '没有找到局域网地址，请检查 Wi-Fi 或网线。' : '现在仅这台电脑能打开。'), st.scope !== 'lan' && el('p', {}, el('button', { class: 'link', onclick: () => { show('settings'); goto('access'); } }, '打开局域网访问'))];
    return [head, ...s.access.slice(0, 3).map((a, i) => el('div', { class: 'center' }, i === 0 && el('img', { class: 'qr', src: a.qr, alt: `${a.url} 的二维码` }), el('div', { class: 'url' }, a.url, copyBtn(a.url, '地址')))), el('div', { class: 'sub center' }, s.access[0].kind === 'public' ? '手机扫码打开，用登录密码进入' : '手机连同一 Wi-Fi 扫码，用登录密码进入')];
  });
  part('qqCard', [s?.bot, s?.users, st.skipQQ, S.bind], () => {
    const head = el('h2', {}, icon('chat'), 'QQ 提交', s && el('span', { class: `pill ${bot[1]}` }, bot[0]));
    if (st.skipQQ) return [head, el('div', { class: 'sub' }, '没有连接 QQ 机器人。'), el('button', { class: 'link', onclick: () => { show('settings'); goto('qq'); } }, '去连接')];
    if (!s) return [head];
    return [head, ...s.users.map((u) => el('div', { class: 'line' }, el('span', { class: 'grow' }, u.nickname || 'QQ 用户'), el('button', { class: 'link bad', onclick: async () => { if (confirm(`解绑「${u.nickname || 'QQ 用户'}」？解绑后不能再提交和查询。`)) await tg.unbind(u.openid).catch((e) => toast(e.message)); } }, '解绑'))),
      s.users.length === 0 && el('div', { class: 'sub' }, '还没有绑定 QQ，机器人不会记录任何消息。'),
      S.bind ? el('div', { class: 'line' }, el('span', { class: 'sel' }, '给机器人发：', el('b', {}, `绑定 ${S.bind.code}`)), copyBtn(`绑定 ${S.bind.code}`, '绑定命令')) : null,
      el('button', { class: 'btn small', onclick: async () => { try { S.bind = await tg.bindCode(); draw(); } catch (e) { toast(e.message); } } }, S.bind ? '换一个绑定码' : '绑定新的 QQ'), S.bind && el('div', { class: 'hint' }, '10 分钟内有效，只能用一次'),
      s.users.length > 0 && !S.bind && el('div', { class: 'hint' }, '在 QQ 里发「提交：问题内容」，再接着发截图')];
  });
  part('webCard', [s?.url, s?.tokens?.length, st.port], () => [el('h2', {}, icon('list'), '浏览器与 AI 助手'), s && el('div', { class: 'line' }, el('span', { class: 'grow mono' }, s.url), copyBtn(s.url, '地址'), el('button', { class: 'btn small', onclick: () => tg.openExternal('web') }, '打开')), el('div', { class: 'line' }, el('span', { class: 'grow' }, 'AI 助手（MCP）', el('span', { class: 'hint' }, s?.tokens.length ? ` 已有 ${s.tokens.length} 个令牌` : ' 未接入')), el('button', { class: 'btn small', onclick: () => { show('settings'); goto('ai'); } }, '接入')), el('div', { class: 'line' }, el('span', { class: 'grow' }, '登录密码'), el('button', { class: 'btn small', onclick: async () => { await tg.copy(await tg.password()); toast('已复制登录密码'); } }, '复制'))]);
  if (S.view === 'settings') { drawTokens(); drawBind(); drawHints(); }
}
on('restartBtn', async () => { await tg.restart(); toast('服务已重启'); });
on('alertFix', async () => { await tg.portFix(true); await tg.restart(); toast('已启动'); });
on('alertPort', async () => { show('settings'); goto('access'); F.port.focus(); F.port.select(); });

// ───────── 引导 / 设置 ─────────
const LABEL = { qq: 'QQ 机器人', access: '访问', ai: 'AI 助手', general: '通用', bind: '绑定 QQ' };
const steps = () => (S.guide ? ['qq', 'access', 'general', ...(F.skipQQ.checked ? [] : ['bind'])] : ['qq', 'access', 'ai', 'general']);
const cur = () => steps()[S.step];
function goto(k) { S.step = Math.max(0, steps().indexOf(k)); drawStep(); }
function fill(over = {}) {
  const st = { ...S.v.settings, ...over };
  for (const k of ['qqAppId', 'port', 'publicUrl', 'mergeMinutes']) F[k].value = st[k];
  for (const k of ['skipQQ', 'notify', 'autostart', 'keepAwake', 'ocr']) F[k].checked = st[k];
  for (const r of F.scope) r.checked = r.value === st.scope;
  F.qqSecret.value = over.qqSecret ?? ''; F.adminPassword.value = over.adminPassword ?? '';
  F.qqSecret.placeholder = st.hasSecret ? '已保存，不改就留空' : '加密保存';
  F.adminPassword.placeholder = st.hasPassword ? '已设置，不改就留空' : '至少 8 位';
  $('publicBox').open = !!st.publicUrl;
  $('tokenOut').replaceChildren(); result('qqResult', '', ''); result('pubResult', '', '');
  syncQQ();
}
function collect() {
  return { qqAppId: F.qqAppId.value, qqSecret: F.qqSecret.value, skipQQ: F.skipQQ.checked, adminPassword: F.adminPassword.value, scope: [...F.scope].find((r) => r.checked)?.value ?? 'lan', port: Number(F.port.value), publicUrl: F.publicUrl.value, notify: F.notify.checked, autostart: F.autostart.checked, keepAwake: F.keepAwake.checked, ocr: F.ocr.checked, mergeMinutes: F.mergeMinutes.value === '' ? NaN : Number(F.mergeMinutes.value) };
}
function syncQQ() { for (const k of ['qqAppId', 'qqSecret']) F[k].disabled = F.skipQQ.checked; $('testQQ').disabled = F.skipQQ.checked; }
F.skipQQ.addEventListener('change', () => { syncQQ(); error(null); drawStep(); });
function error(e) {
  for (const x of document.querySelectorAll('.invalid')) x.classList.remove('invalid');
  $('formError').textContent = e?.message ?? ''; $('portFix').hidden = true;
  const at = e?.field && { qqAppId: 'qq', qqSecret: 'qq', adminPassword: 'access', scope: 'access', port: 'access', publicUrl: 'access', mergeMinutes: 'general' }[e.field];
  if (at && cur() !== at) goto(at), ($('formError').textContent = e.message);
  if (e?.field && F[e.field]?.classList) { if (e.field === 'publicUrl') $('publicBox').open = true; F[e.field].classList.add('invalid'); F[e.field].focus(); }
  if (e?.field === 'port') tg.portFix(false, Number(F.port.value)).then((o) => {
    if (!o) return;
    $('portFix').hidden = false;
    $('portFix').replaceChildren(...[el('span', { class: 'sub grow' }, `占用它的是「${o.name}」（PID ${o.pid}）${o.old ? '，旧版服务' : ''}`), o.old && el('button', { type: 'button', class: 'btn small', onclick: async () => { try { await tg.portFix(true, Number(F.port.value)); error(null); toast('旧版已停止，请再点一次'); } catch (x) { toast(x.message); } } }, '停止旧版'), el('button', { type: 'button', class: 'btn small', onclick: () => { F.port.value = Number(F.port.value) + 1; error(null); drawHints(); } }, `改用 ${Number(F.port.value) + 1}`)].filter(Boolean));
  });
}
/** 引导里先在本步检查，真正的校验在保存时由主进程做。 */
function check(k) {
  const c = collect(), st = S.v.settings, bad = (m, f) => { const e = new Error(m); e.field = f; throw e; };
  if (k === 'qq' && !c.skipQQ) { if (!/^\d{5,}$/.test(c.qqAppId.trim())) bad('请填写 AppID（一串数字）；暂时没有可以勾选「暂不连接 QQ」', 'qqAppId'); if (!c.qqSecret.trim() && !st.hasSecret) bad('请填写 AppSecret', 'qqSecret'); }
  if (k === 'access') { if (!(c.adminPassword || st.hasPassword)) bad('请设置登录密码，或点「生成」', 'adminPassword'); if (c.adminPassword && c.adminPassword.length < 8) bad('登录密码至少 8 位', 'adminPassword'); if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) bad('端口须是 1024–65535 的整数', 'port'); }
}
function drawHints() {
  const port = F.port.value || S.v.settings.port, lan = [...F.scope].find((r) => r.checked)?.value === 'lan';
  $('scopeHint').textContent = lan ? `监听 0.0.0.0:${port}，同一 Wi-Fi 的手机、电脑都能打开。局域网是明文传输，请只在可信网络使用` : `只监听 127.0.0.1:${port}，手机打不开`;
  $('pubPort').textContent = `http://127.0.0.1:${port}`;
  $('pwHint').textContent = F.adminPassword.value ? `${F.adminPassword.value.length} 位。稍后可在「运行状态」复制` : '';
}
for (const n of ['input', 'change']) $('form').addEventListener(n, (e) => { drawHints(); $('formError').textContent = ''; e.target.classList.remove('invalid'); });
function drawStep() {
  const list = steps(), k = cur();
  $('wizard').classList.toggle('guide', S.guide);
  $('wzTitle').textContent = S.guide ? '设置天工反馈' : '设置';
  $('wzSub').textContent = S.guide ? `${list.length} 步完成，之后在${S.v.word.tray}常驻` : '保存后服务会自动重启，几秒钟';
  $('stepper').replaceChildren(...list.map((x, i) => el('li', { class: i === S.step ? 'on' : S.guide && i < S.step ? 'done' : '' }, el('button', { type: 'button', disabled: false, onclick: () => { if (!S.guide) { S.step = i; drawStep(); } } }, el('span', { class: 'num' }, S.guide && i < S.step ? icon('check') : String(i + 1)), LABEL[x]))));
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.step !== k;
  $('formError').textContent = ''; $('portFix').hidden = true;
  $('genTitle').textContent = S.guide ? '确认并启动' : '通用';
  $('summary').hidden = !S.guide;
  if (S.guide && k === 'general') { const c = collect(); $('summary').replaceChildren(...[S.imp && ['导入', `${S.imp.issues} 条问题、${S.imp.attachments} 个附件、${S.imp.users} 个已绑定 QQ`], ['QQ 机器人', c.skipQQ ? '暂不连接' : S.qqOk ? `${S.qqOk}（${c.qqAppId}）` : c.qqAppId], ['访问范围', c.scope === 'lan' ? `局域网，端口 ${c.port}` : `仅这台电脑，端口 ${c.port}`], c.publicUrl && ['外网地址', c.publicUrl]].filter(Boolean).map(([a, b]) => el('div', {}, el('span', {}, a), el('span', {}, b)))); }
  const last = S.step === list.length - 1;
  $('backBtn').hidden = !S.guide || k === 'bind';
  $('stepCount').textContent = S.guide ? `第 ${S.step + 1} 步，共 ${list.length} 步` : '';
  $('nextBtn').hidden = !S.guide && k === 'ai';
  $('nextBtn').textContent = !S.guide ? '保存并重启服务' : k === 'bind' ? (S.v.snap?.users.length ? '进入问题库' : '稍后再绑定，进入问题库') : k === 'general' ? (S.imp ? '导入并启动' : '启动') : '下一步';
  drawHints(); drawTokens(); drawBind();
  if (S.guide && !last) $('form').querySelector('.panel:not([hidden]) input:not([type=radio]):not([type=checkbox]):not(:disabled)')?.focus();
}
$('backBtn').addEventListener('click', () => { if (S.step === 0) { S.guide = false; S.imp = null; error(null); $('app').hidden = true; $('cover').hidden = false; } else { S.step--; drawStep(); } });
const submit = busy($('nextBtn'), async () => {
  error(null);
  if (!S.guide) { const c = collect(); await tg.save(c); S.v = await tg.get(); const at = S.step; fill(); S.step = at; drawStep(); toast('已保存，服务已重启'); return; }
  const k = cur();
  if (k === 'bind') return enter();
  check(k);
  if (k !== 'general') { S.step++; return drawStep(); }
  $('nextBtn').textContent = S.imp ? '正在导入…' : '正在启动…';
  try { await tg.finish(collect(), !!S.imp); } catch (e) { $('nextBtn').textContent = S.imp ? '导入并启动' : '启动'; throw e; }
  S.v = await tg.get();
  if (steps().includes('bind')) { S.step = steps().indexOf('bind'); drawStep(); } else await enter();
}, error);
$('form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
async function enter() { S.guide = false; S.imp = null; show('status'); await tg.openMain('').catch((e) => toast(e.message)); }

on('testQQ', async () => { result('qqResult', '', '正在连接 QQ…'); S.qqOk = ''; try { S.qqOk = await tg.testQQ(F.qqAppId.value, F.qqSecret.value); result('qqResult', 'ok', `连接成功，机器人「${S.qqOk}」`); } catch (e) { result('qqResult', 'bad', e.message); } });
on('testPublic', async () => { result('pubResult', '', '正在测试…'); try { result('pubResult', 'ok', `可以访问：${await tg.testPublic(F.publicUrl.value)}`); } catch (e) { result('pubResult', 'bad', e.message); } });
on('genPw', async () => { F.adminPassword.value = await tg.randomPassword(); F.adminPassword.type = 'text'; error(null); drawHints(); });
on('eye', async () => { const i = F.adminPassword; if (i.type === 'password' && !i.value && S.v.settings.hasPassword) i.value = await tg.password(); i.type = i.type === 'password' ? 'text' : 'password'; });

// ───────── AI 助手 ─────────
function drawTokens() {
  const s = S.v.snap;
  $('mkToken').disabled = !s;
  part('tokens', s?.tokens ?? null, () => (s?.tokens ?? []).map((t) => el('div', { class: 'line' }, el('span', { class: 'grow' }, t.name, el('span', { class: 'hint' }, t.last_used_at ? ` 最近使用 ${new Date(t.last_used_at).toLocaleString('zh-CN')}` : ' 未使用过')), el('button', { type: 'button', class: 'link bad', onclick: async () => { if (confirm(`撤销「${t.name}」？使用它的助手将立即无法访问。`)) { await tg.removeToken(t.id).catch((e) => toast(e.message)); $('tokenOut').replaceChildren(); } } }, '撤销'))));
}
$('tokenName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('mkToken').click(); } });
on('mkToken', async () => {
  const { token } = await tg.createToken($('tokenName').value.trim() || 'AI 助手'), url = `${S.v.snap.url}/mcp`;
  $('tokenName').value = '';
  const cmd = (label, text) => [el('div', { class: 'cmdhead' }, el('b', {}, label), el('button', { type: 'button', class: 'link', onclick: async () => { await tg.copy(text); toast('已复制'); } }, '复制')), el('pre', { class: 'cmd' }, text)];
  $('tokenOut').replaceChildren(el('div', { class: 'warnbox' }, '令牌只显示这一次，请立即复制'), ...cmd('Claude Code（终端执行）', `claude mcp add --transport http --scope user tiangong-feedback ${url} --header "Authorization: Bearer ${token}"`), ...cmd('Codex（追加到 ~/.codex/config.toml）', `[mcp_servers.tiangong-feedback]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`));
});

// ───────── 绑定 QQ ─────────
let bindBusy = false;
async function drawBind() {
  if (!S.guide || cur() !== 'bind') return;
  const s = S.v.snap, users = s?.users ?? [];
  $('nextBtn').textContent = users.length ? '进入问题库' : '稍后再绑定，进入问题库';
  if (!users.length && s && !bindBusy && (!S.bind || S.bind.exp < Date.now())) { bindBusy = true; try { S.bind = await tg.bindCode(); } catch (e) { toast(e.message); } finally { bindBusy = false; } }
  part('bindBox', [users, S.bind, s?.bot], () => users.length
    ? [el('div', { class: 'done-ic' }, icon('check')), el('b', {}, `已绑定：${users.map((u) => u.nickname || 'QQ 用户').join('、')}`), el('div', { class: 'sub' }, '现在给机器人发「提交：问题内容」试试，再接着发截图')]
    : [el('div', { class: 'sub' }, '在 QQ 里打开和机器人的聊天，发送这一行'), S.bind && el('div', { class: 'row' }, el('div', { class: 'code' }, `绑定 ${S.bind.code}`), copyBtn(`绑定 ${S.bind.code}`, '绑定命令')), el('div', { class: 'hint' }, '绑定成功后这里会自动变化 · 10 分钟内有效'), el('span', { class: `pill ${BOT[s?.bot.state]?.[1] ?? ''}` }, `机器人${BOT[s?.bot.state]?.[0] ?? '启动中'}${s?.bot.reason ? `：${s.bot.reason}` : ''}`)]);
}

// ───────── 封面与导入 ─────────
function startGuide(over) { S.guide = true; S.step = 0; S.qqOk = ''; $('qqHelp').open = false; F.adminPassword.type = 'password'; fill(over); show('settings'); drawStep(); }
$('startBtn').addEventListener('click', () => { S.imp = null; startGuide(); });
on('importBtn', async () => { const r = await tg.importPick(); if (r) showImport(r); });
function showImport(r) {
  const p = r.prefill;
  const draw2 = () => $('importBody').replaceChildren(el('div', { class: 'summary' }, ...[['位置', r.dir], ['内容', `${r.issues} 条问题、${r.attachments} 个附件、${r.users} 个已绑定 QQ`], ['沿用设置', p ? [p.qqAppId && `QQ 机器人 ${p.qqAppId}`, p.adminPassword && '登录密码', `端口 ${p.port}`].filter(Boolean).join('、') : '没有找到 .env，需要重新填写']].map(([a, b]) => el('div', {}, el('span', {}, a), el('span', { class: 'mono' }, b)))), el('p', { class: 'sub' }, '只复制，不改动旧文件夹。'), r.running ? el('div', { class: 'warnbox row' }, el('span', { class: 'grow' }, `旧版服务正在运行${r.oldPid ? `（PID ${r.oldPid}）` : ''}。同一个机器人不能两边同时用，要先停止它。`), el('button', { class: 'btn small', onclick: async (e) => { e.target.disabled = true; try { await tg.importStop(r.oldPid); r.running = false; draw2(); toast('旧版已停止'); } catch (x) { toast(x.message); e.target.disabled = false; } } }, r.oldPid ? '停止旧版' : '我已关闭它')) : '');
  const ok = () => { $('importOk').disabled = !!r.running; };
  draw2(); ok(); new MutationObserver(ok).observe($('importBody'), { childList: true });
  $('importOk').onclick = () => { $('importDlg').close(); S.imp = r; startGuide(p ? { qqAppId: p.qqAppId, qqSecret: p.qqSecret, adminPassword: p.adminPassword, port: p.port, publicUrl: p.publicUrl, skipQQ: !p.qqAppId } : {}); };
  $('importDlg').showModal();
}
$('importCancel').addEventListener('click', () => $('importDlg').close());

// ───────── 诊断 ─────────
on('doctorBtn', async () => {
  $('checks').replaceChildren(el('div', { class: 'empty' }, '正在检查…'));
  try { const list = await tg.doctor(); $('checks').replaceChildren(...list.map((c) => el('div', { class: 'item' }, el('span', { class: `mark ${c.ok ? 'ok' : 'bad'}` }, icon(c.ok ? 'check' : 'x')), el('div', { class: 'grow sel' }, el('b', {}, c.name), el('div', { class: 'sub' }, c.text))))); } catch (e) { $('checks').replaceChildren(el('div', { class: 'empty' }, e.message)); }
});
on('resetBtn', async () => { if (!(await tg.reset())) return; S.v = await tg.get(); S.bind = S.imp = null; S.guide = false; drawn = {}; $('tokenOut').replaceChildren(); $('app').hidden = true; $('cover').hidden = false; });

// ───────── 启动 ─────────
tg.onChange((v) => { const u = S.v?.snap?.users.length; S.v = v; if (v.snap && u !== undefined && v.snap.users.length > u) { S.bind = null; toast('QQ 绑定成功'); } if (!$('app').hidden) draw(); });
tg.onView((view) => { if (!S.guide && S.v?.settings.configured) show(view); });
tg.get().then((v) => { S.v = v; document.body.classList.add(v.platform === 'darwin' ? 'mac' : 'win'); for (const k of ['tray', 'trash']) for (const x of document.querySelectorAll(`.w-${k}`)) x.textContent = v.word[k]; if (v.settings.configured) show('status'); else $('cover').hidden = false; });
