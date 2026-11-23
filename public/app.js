// 轻量单页应用：无构建、无第三方依赖。所有用户内容都以文本节点写入，不拼接 HTML。
import { category, hue, icon, sevIcon } from './icons.js';

const $app = document.getElementById('app');
let meta = null, sum = null;
// macOS 桌面端没有系统标题栏，侧栏要给红绿灯留位置
if (window.tgDesktop && /Mac/.test(navigator.userAgent)) document.documentElement.classList.add('mac-app');

// ───────── 基础 ─────────
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (['value', 'checked', 'disabled', 'selected'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(9).filter((x) => x !== null && x !== undefined && x !== false));
  return el;
}
let toastTimer;
function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.replaceChildren(icon(bad ? 'warn' : 'check'), h('span', {}, msg)); t.className = bad ? 'on bad' : 'on';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}
async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch('/api' + path, {
    method, headers: { 'x-requested-with': 'tg', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { meta = null; renderLogin(); throw new Error('请先登录'); }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}
/** 包装点击：期间禁用按钮，失败提示。 */
const act = (fn) => async (e) => {
  const b = e?.currentTarget;
  if (b?.tagName === 'BUTTON') b.disabled = true;
  try { await fn(e); } catch (err) { toast(err.message, true); } finally { if (b?.tagName === 'BUTTON') b.disabled = false; }
};
const pad = (n) => String(n).padStart(2, '0');
const time = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const copy = async (t) => { try { await navigator.clipboard.writeText(t); } catch { const a = h('textarea', { style: 'position:fixed;opacity:0' }); a.value = t; document.body.append(a); a.select(); document.execCommand('copy'); a.remove(); } toast('已复制'); };
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
/** 相对时间；悬停看完整时间。 */
function rel(ms) {
  const d = new Date(ms), now = new Date(), m = Math.floor((now - d) / 60000), day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((day0(now) - day0(d)) / 86400000), hm = time(ms).slice(11);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  if (days === 0) return `${Math.floor(m / 60)} 小时前`;
  return days === 1 ? `昨天 ${hm}` : days < 7 ? `${days} 天前` : time(ms).slice(d.getFullYear() === now.getFullYear() ? 5 : 0, 10);
}
const ago = (ms) => h('time', { class: 'nowrap', title: time(ms) }, rel(ms));
const statusEl = (s) => h('span', { class: `st ${s}` }, icon(s), meta.status[s]);
const sevEl = (s) => h('span', { class: `sev sev-${s}` }, sevIcon(s), meta.severity[s]);
const tile = (ic, color, cls = '') => h('span', { class: `tileic hue-${color} ${cls}` }, icon(ic));
const catTile = (name, cls) => tile(...category(name), cls);
const avatar = (name, cls = '') => h('span', { class: `av hue-${hue(name)} ${cls}`, 'aria-hidden': 'true' }, [...name][0] ?? '?');
const person = (name) => h('span', { class: 'person' }, avatar(name), h('span', {}, name));
const ib = (ic, label, props = {}) => h('button', props, icon(ic), label);
const h2 = (ic, text, color, ...more) => h('h2', {}, tile(ic, color, 'sm'), h('span', { class: 'grow' }, text), more);
/** 应用内的确认 / 输入框（桌面端没有浏览器的 prompt）。取消得到 null。 */
function ask({ title, text, value, placeholder = '', input = value !== undefined, ok = '确定', danger = false }) {
  return new Promise((res) => {
    let out = null;
    const inp = input && h('input', { value: value ?? '', placeholder, 'aria-label': title });
    const done = () => { out = inp ? inp.value : true; d.close(); };
    const d = h('dialog', { class: 'ask', onclose: () => { d.remove(); res(out); } }, h('form', { onsubmit: (e) => { e.preventDefault(); done(); } },
      h('div', { class: 'askhead' }, tile(danger ? 'warn' : input ? 'note' : 'help', danger ? 'red' : 'blue'), h('div', {}, h('h2', {}, title), text && h('div', { class: 'muted' }, text))), inp,
      h('div', { class: 'row end' }, h('button', { type: 'button', onclick: () => d.close() }, '取消'), h('button', { class: danger ? 'primary danger' : 'primary' }, ok))));
    document.body.append(d); d.showModal(); if (inp) inp.select();
  });
}
const who = (a) => meta.users.find((u) => u.openid === a)?.nickname || (meta.users.some((u) => u.openid === a) ? 'QQ 用户' : /^[0-9A-F]{16,}$/i.test(a) ? 'QQ 用户' : a);
const opts = (pairs, cur, first) => [first !== undefined && h('option', { value: '' }, first), ...pairs.map(([v, t]) => h('option', { value: v, selected: v === cur }, t))];
const loadMeta = async () => { meta = await api('/meta'); };

// ───────── 路由 ─────────
const NAV = [['feedbacks', '提交记录', 'inbox'], ['topics', '同类问题', 'layers'], ['stats', '统计', 'chart'], ['settings', '设置', 'sliders']];
const BOT = { online: '在线', connecting: '连接中', offline: '离线，自动重连中', blocked: '无法连接', disabled: '未启用', stopped: '已停止' };
const BOT_CLS = { online: 'ok', connecting: 'warn', offline: 'bad', blocked: 'bad', stopped: 'bad' };
const route = () => { const [p, q] = (location.hash.slice(1) || '/feedbacks').split('?'); const [, page, id] = p.split('/'); return { page: page || 'feedbacks', id, query: Object.fromEntries(new URLSearchParams(q)) }; };
const logo = () => h('span', { class: 'logo' }, icon('chat'));
const ymd = (ms) => time(ms).slice(0, 10);
const isView = (q, v) => { const a = Object.entries(q).filter(([k, x]) => k !== 'page' && x), b = Object.entries(v); return a.length === b.length && b.every(([k, x]) => q[k] === x); };
function sidebar(r) {
  const views = [['sun', '今天新增', { from: ymd(Date.now()) }, sum.today, 'amber'], ['flame', '紧急未完结', { status: 'todo', severity: 'urgent' }, sum.urgent, 'red'], ['unlink', '未归并', { topic: 'none' }, sum.ungrouped, 'violet'], ['trash', '回收站', { deleted: '1' }, sum.trash, 'slate']];
  const listOn = r.page === 'feedbacks' && !r.id && views.some((v) => isView(r.query, v[2]));
  return h('header', { class: 'side' },
    h('a', { class: 'brand', href: '#/feedbacks' }, logo(), h('span', {}, h('b', {}, '用户反馈库'), h('small', {}, '收集 · 归类 · 解决'))),
    ib('plus', '新增反馈', { class: 'primary add', onclick: () => addDialog() }),
    h('nav', { 'aria-label': '主导航' }, NAV.map(([k, t, ic]) => h('a', { href: `#/${k}`, class: r.page === k && !(k === 'feedbacks' && listOn) ? 'on' : '', 'aria-current': r.page === k ? 'page' : undefined }, icon(ic), h('span', {}, t), k === 'feedbacks' && sum.open + sum.doing > 0 && h('em', { title: '未完结' }, sum.open + sum.doing)))),
    h('div', { class: 'views' }, h('div', { class: 'cap' }, '快捷视图'), views.map(([ic, t, v, n, color]) => h('a', { href: '#/feedbacks?' + qs(v), class: r.page === 'feedbacks' && !r.id && isView(r.query, v) ? 'on' : '' }, h('span', { class: `vi hue-${color}` }, icon(ic)), h('span', {}, t), n > 0 && h('em', {}, n)))),
    h('div', { class: 'foot' },
      h('a', { class: 'botline', href: '#/settings', title: 'QQ 机器人状态' }, h('i', { class: `dot ${BOT_CLS[sum.bot] ?? ''}` }), h('span', {}, 'QQ 机器人'), h('small', {}, BOT[sum.bot] ?? sum.bot)),
      window.tgDesktop ? ib('console', '控制台', { onclick: () => window.tgDesktop.openSettings() }) : ib('logout', '退出', { onclick: act(async () => { await api('/logout', { method: 'POST' }); meta = null; renderLogin(); }) })));
}
let seq = 0;
async function render() {
  const my = ++seq, r = route();
  try {
    if (!meta) await loadMeta();
    const view = r.page === 'topics' ? (r.id ? topicPage(r.id) : topicsPage(r.query)) : r.page === 'stats' ? statsPage(r.query) : r.page === 'settings' ? settingsPage() : r.id ? feedbackPage(r.id) : listPage(r.query);
    const [el, s] = await Promise.all([view, api('/summary')]);
    if (my !== seq) return;
    sum = s;
    $app.replaceChildren(sidebar(r), h('div', { class: 'dragbar' }), h('main', {}, typeof el === 'function' ? el() : el));
  } catch (e) { if (my === seq && meta) $app.replaceChildren(...[sum && sidebar(r), h('div', { class: 'dragbar' }), h('main', {}, empty('warn', e.message, h('a', { class: 'btn', href: '#/feedbacks' }, icon('back'), '返回列表')))].filter(Boolean)); }
}
// 手机切回页面时刷新记录（主屏幕模式没有刷新按钮）；正在输入时不打断
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && meta && route().page === 'feedbacks' && !route().id && !document.querySelector('dialog') && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) render(); });
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });

function renderLogin() {
  seq++;
  const pw = h('input', { type: 'password', placeholder: '密码', autocomplete: 'current-password', 'aria-label': '密码' });
  $app.replaceChildren(h('div', { class: 'loginwrap' }, h('form', { class: 'login', onsubmit: async (e) => { e.preventDefault(); try { await api('/login', { method: 'POST', body: { password: pw.value } }); render(); } catch (err) { toast(err.message, true); pw.select(); } } },
    logo(), h('h1', {}, '用户反馈库'), h('p', { class: 'muted' }, '在 QQ 里随手提交，在这里统一处理'), h('div', { class: 'inic' }, icon('lock'), pw), h('button', { class: 'primary' }, '登录'),
    h('div', { class: 'lfeat' }, [['chat', 'QQ 随手记', 'blue'], ['scan', '截图可搜', 'violet'], ['layers', '同类归并', 'green']].map(([ic, t, c]) => h('span', {}, tile(ic, c, 'sm'), t))))));
  pw.focus();
}

// ───────── 列表 ─────────
const empty = (ic, text, ...more) => h('div', { class: 'empty' }, h('div', { class: 'emptyart' }, h('i', {}), h('i', {}), h('span', {}, icon(ic))), h('div', { class: 'etext' }, text), more.length > 0 && h('div', { class: 'row' }, more));
const pageHead = (title, sub, ...actions) => h('div', { class: 'phead' }, h('div', { class: 'grow' }, h('h1', {}, title), h('p', { class: 'muted' }, sub)), actions);
const searchBox = (value, placeholder, go) => h('form', { class: 'inic grow', onsubmit: (e) => { e.preventDefault(); go(e.target.q.value); } }, icon('search'), h('input', { type: 'search', name: 'q', value: value ?? '', placeholder, 'aria-label': '搜索' }));
function filterBar(q, page) {
  const go = (patch) => { location.hash = `#/${page}?` + qs({ ...q, ...patch, page: '' }); };
  const sel = (k, ic, pairs, label) => h('span', { class: `pick ${q[k] ? 'on' : ''}` }, icon(ic), h('select', { 'aria-label': label, onchange: (e) => go({ [k]: e.target.value }) }, opts(pairs, q[k] ?? '', label)));
  const names = (list) => { const v = list.map((c) => c.name); if (v.length && q.category && !v.includes(q.category) && list === meta.categories) v.push(q.category); return v.map((n) => [n, n]); };
  const on = ['status', 'category', 'product', 'severity', 'channel', 'from', 'to'].filter((k) => q[k]).length;
  const more = h('button', { class: 'more', 'aria-expanded': 'false', onclick: () => { const o = box.classList.toggle('open'); more.setAttribute('aria-expanded', String(o)); } }, icon('filter'), on ? `筛选 ${on}` : '筛选');
  const date = (k, label) => h('input', { type: 'date', value: q[k] ?? '', 'aria-label': label, class: q[k] ? '' : 'none', onchange: (e) => go({ [k]: e.target.value }) });
  const box = h('div', { class: 'filters' },
    h('div', { class: 'row top' }, searchBox(q.q, '搜索正文、截图文字、客户、编号…', (v) => go({ q: v })), Object.keys(q).some((k) => k !== 'page' && q[k]) && ib('x', '清除', { class: 'link', onclick: () => { location.hash = `#/${page}`; } }), more),
    h('div', { class: 'row fields' },
      sel('status', 'open', [['todo', '未完结'], ...Object.entries(meta.status)], '全部状态'), sel('category', 'tag', names(meta.categories), '全部分类'),
      meta.products.length > 0 && sel('product', 'box', names(meta.products), '全部产品'), sel('severity', 'flag', Object.entries(meta.severity), '全部优先级'), sel('channel', 'compass', [['qq', 'QQ 提交'], ['web', '网页提交']], '全部来路'),
      h('span', { class: `range ${q.from || q.to ? 'on' : ''}` }, icon('calendar'), date('from', '开始日期'), h('span', { class: 'muted' }, '至'), date('to', '结束日期'))));
  return box;
}
const via = (f) => (f.channel === 'qq' ? `QQ · ${who(f.author)}`.replace('QQ · QQ 用户', 'QQ') : '网页');
const viaEl = (f) => h('span', { class: 'via' }, h('span', { class: `vi hue-${f.channel === 'qq' ? 'blue' : 'teal'}` }, icon(f.channel === 'qq' ? 'chat' : 'globe')), h('span', {}, via(f)));
const counts = (f) => h('span', { class: 'cnts' }, h('span', { title: `${f.message_count} 条消息` }, icon('msg'), f.message_count), f.attachment_count > 0 && h('span', { title: `${f.attachment_count} 个附件` }, icon('clip'), f.attachment_count));
/** 概览卡片：点一下按状态筛选，再点取消。 */
function overview(q) {
  const card = (k, ic, color, label, n, sub) => { const on = isView(q, { status: k }); return h('a', { class: `kpi hue-${color} ${on ? 'on' : ''}`, href: on ? '#/feedbacks' : `#/feedbacks?status=${k}`, 'aria-pressed': String(on) }, tile(ic, color), h('div', {}, h('b', {}, n), h('span', {}, label)), h('small', {}, sub)); };
  const max = Math.max(1, ...sum.days.map((d) => d.count)), diff = sum.week - sum.prevWeek, pct = (n) => (sum.total ? `占 ${Math.round((n / sum.total) * 100)}%` : '');
  const from = sum.days[7].name, weekOn = isView(q, { from });
  return h('div', { class: 'kpis' }, card('open', 'open', 'amber', '待处理', sum.open, pct(sum.open)), card('doing', 'doing', 'blue', '处理中', sum.doing, pct(sum.doing)), card('resolved', 'resolved', 'green', '已解决', sum.resolved, pct(sum.resolved)),
    h('a', { class: `kpi hue-violet trend ${weekOn ? 'on' : ''}`, href: weekOn ? '#/feedbacks' : `#/feedbacks?from=${from}` }, tile('trend', 'violet'), h('div', {}, h('b', {}, sum.week), h('span', {}, '近 7 天')), h('small', {}, diff === 0 ? '与前 7 天持平' : `比前 7 天 ${diff > 0 ? '+' : '−'}${Math.abs(diff)}`),
      h('span', { class: 'spark', role: 'img', 'aria-label': `近 14 天每天新增：${sum.days.map((d) => d.count).join('、')}` }, sum.days.map((d, i) => h('span', { class: i > 6 ? 'now' : '', 'data-tip': `${d.name.slice(5)}　${d.count} 条` }, h('i', { style: `height:${d.count ? Math.max(12, (d.count / max) * 100) : 0}%` }))))));
}
/** 手机端：按提交日期分组的卡片。 */
function cards(items) {
  const today = ymd(Date.now()), yest = ymd(Date.now() - 86400000), out = [];
  let last = '';
  for (const f of items) {
    const d = ymd(f.created_at);
    if (d !== last) { out.push(h('h2', { class: 'day' }, d === today ? '今天' : d === yest ? '昨天' : d)); last = d; }
    const ex = f.excerpt.replace(/\s+/g, ' ').trim();
    out.push(h('a', { class: `rec ${f.status}`, href: `#/feedbacks/${f.id}` }, catTile(f.category),
      h('div', { class: 'grow' }, h('div', { class: 'row small muted' }, h('span', { class: 'grow' }, `#${f.id} · ${time(f.created_at).slice(11)} · `, via(f)), statusEl(f.status)),
        h('div', { class: 'rt' }, f.title), ex && ex !== f.title && h('div', { class: 'rx small' }, ex),
        h('div', { class: 'small muted meta' }, f.severity !== 'normal' && sevEl(f.severity), [f.category, f.product, f.version, f.reporter].filter(Boolean).map((x) => h('span', {}, x)), f.attachment_count > 0 && counts(f))),
      f.thumb && h('img', { src: `/api/attachments/${f.thumb}`, alt: '', loading: 'lazy' })));
  }
  return h('div', { class: 'cards narrow' }, out);
}
/** 记录很少时，告诉新用户怎么用。 */
const tips = () => h('div', { class: 'tips' }, [['chat', 'blue', '在 QQ 里提交', '给机器人发「提交：问题内容」，再接着发截图'], ['scan', 'violet', '截图文字可搜', '截图里的报错会自动识别，直接搜就能找到'], ['layers', 'green', '同类归并', '把相似的归到一起，处理办法下次自动提示']].map(([ic, c, t, d]) => h('div', {}, tile(ic, c), h('div', {}, h('b', {}, t), h('span', { class: 'small muted' }, d)))));
async function listPage(q) {
  const data = await api('/feedbacks?' + qs(q)), page = Number(q.page) || 1, pages = Math.max(1, Math.ceil(data.total / 30));
  const exp = (f) => '/api/export/' + f + '?' + qs({ ...q, page: '' }), plain = !Object.keys(q).length;
  const row = (f) => h('tr', { class: `click ${f.status}`, onclick: (e) => { if (!e.target.closest('a')) location.hash = `#/feedbacks/${f.id}`; } },
    h('td', {}, h('div', { class: 'cell' }, catTile(f.category), h('div', { class: 'grow' }, h('a', { class: 't', href: `#/feedbacks/${f.id}` }, f.title),
      h('div', { class: 'small muted meta' }, h('span', { class: 'num' }, `#${f.id}`), [f.category, f.product, f.version].filter(Boolean).map((x) => h('span', {}, x)),
        f.topic_title && h('a', { class: 'tag topic', href: `#/topics/${f.topic_id}`, title: '同类：' + f.topic_title }, icon('layers'), h('span', {}, f.topic_title)), f.tags.map((t) => h('a', { class: 'tag', href: '#/feedbacks?' + qs({ tag: t }) }, icon('tag'), t)))), f.thumb && h('img', { class: 'thumb', src: `/api/attachments/${f.thumb}`, alt: '', loading: 'lazy' }))),
    h('td', {}, statusEl(f.status)), h('td', { class: 'nowrap' }, sevEl(f.severity)), h('td', { class: 'nowrap' }, f.reporter ? person(f.reporter) : h('span', { class: 'muted' }, '—')), h('td', { class: 'nowrap' }, viaEl(f)), h('td', { class: 'nowrap' }, counts(f)), h('td', { class: 'nowrap muted' }, ago(f.created_at)));
  const ex = (f, ic, t) => h('a', { href: exp(f) }, icon(ic), t);
  return () => h('div', {},
    pageHead(q.deleted ? '回收站' : '提交记录', q.deleted ? '移入回收站的反馈，可以随时恢复' : `共收录 ${sum.total} 条，今天新增 ${sum.today} 条`, h('div', { class: 'export', role: 'group', 'aria-label': '导出当前结果' }, h('span', { class: 'muted small' }, '导出'), ex('csv', 'table', 'Excel(CSV)'), ex('md', 'file', 'Markdown'), ex('json', 'braces', 'JSON'))),
    !q.deleted && overview(q),
    filterBar(q, 'feedbacks'),
    h('div', { class: 'row small muted listmeta' }, h('span', { class: 'grow' }, h('span', { class: 'nowrap' }, `共 ${data.total} 条`),
      q.topic === 'none' ? '（未归并）' : '', q.tag ? `（标签：${q.tag}）` : '', q.reporter ? `（反馈人：${q.reporter}）` : '', q.deleted ? '（回收站）' : ''),
      h('a', { class: 'narrow', href: '#/feedbacks?topic=none' }, '未归并'), h('a', { class: 'narrow', href: '#/feedbacks?deleted=1' }, '回收站')),
    data.items.length === 0 ? h('div', { class: 'card' }, plain ? empty('empty', '还没有反馈。绑定 QQ 后把内容发给机器人，或点「新增反馈」。', ib('plus', '手动记一条', { class: 'primary', onclick: () => addDialog() }), h('a', { class: 'btn', href: '#/settings' }, icon('chat'), '去绑定 QQ')) : empty('search', '没有符合条件的反馈', h('a', { class: 'btn', href: '#/feedbacks' }, '清除条件')))
      : [cards(data.items), h('div', { class: 'tablewrap wide' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['标题', '状态', '优先级', '反馈人', '提交', '素材', '时间'].map((t) => h('th', {}, t)))), h('tbody', {}, data.items.map(row))))],
    plain && data.total <= 5 && tips(),
    pages > 1 && h('div', { class: 'pager' }, ib('back', '上一页', { disabled: page <= 1, onclick: () => { location.hash = '#/feedbacks?' + qs({ ...q, page: page - 1 }); } }), h('span', {}, `${page} / ${pages}`), h('button', { disabled: page >= pages, onclick: () => { location.hash = '#/feedbacks?' + qs({ ...q, page: page + 1 }); } }, '下一页', icon('next'))));
}

// ───────── 详情 ─────────
function attachment(a) {
  const url = `/api/attachments/${a.id}`, name = a.filename || { image: '图片', voice: '语音', video: '视频', file: '文件' }[a.kind];
  const retry = h('button', { class: 'link', onclick: act(async () => { await api(url.slice(4) + '/retry', { method: 'POST' }); toast('已重新加入队列'); setTimeout(render, 1500); }) }, '重试');
  const [ic, c] = { image: ['image', 'violet'], voice: ['voice', 'teal'], video: ['video', 'pink'] }[a.kind] ?? ['file', 'blue'];
  return h('div', { class: `att ${a.status}` },
    a.status === 'pending' ? h('span', { class: 'muted' }, `${name} 下载中…`, a.error && `（${a.error}，将自动重试）`)
      : a.status === 'failed' ? h('span', {}, h('span', { class: 'sev-urgent' }, `⚠ ${name} 保存失败`), `：${a.error ?? ''} `, retry)
      : a.kind === 'image' && /^image\//.test(a.mime) ? h('img', { src: url, alt: name, loading: 'lazy', onclick: () => { const d = h('dialog', { class: 'img', onclick: () => d.close(), onclose: () => d.remove() }, h('img', { src: url, alt: name })); document.body.append(d); d.showModal(); } })
      : /^audio\//.test(a.mime) ? h('audio', { src: url, controls: true, preload: 'none' }) : /^video\/mp4/.test(a.mime) ? h('video', { src: url, controls: true, preload: 'metadata' }) : null,
    a.status === 'done' && h('a', { class: 'attname', href: url + '?dl=1', title: '下载' }, tile(ic, c, 'sm'), h('span', { class: 'grow' }, h('span', { class: 'fn' }, name), h('small', { class: 'muted' }, size(a.size))), icon('download')),
    a.ocr_status === 'failed' && h('div', { class: 'small muted' }, '文字识别失败 ', retry), a.status === 'done' && a.ocr_status === 'pending' && h('div', { class: 'small muted' }, '等待文字识别'),
    a.text && h('details', { open: a.text.length < 120 }, h('summary', { class: 'small muted' }, icon(a.kind === 'voice' ? 'voice' : 'scan'), a.kind === 'voice' ? '语音转写' : '识别文字'), h('pre', {}, a.text)));
}
function composer({ onSend, label, placeholder, noteToggle }) {
  const files = [];
  const list = h('div', { class: 'picked' });
  const urls = new Map(), src = (f) => { if (!urls.has(f)) urls.set(f, URL.createObjectURL(f)); return urls.get(f); };
  const drop = (f) => { if (urls.has(f)) { URL.revokeObjectURL(urls.get(f)); urls.delete(f); } };
  const draw = () => list.replaceChildren(...files.map((f, i) => h('div', { class: 'pickf' }, /^image\//.test(f.type) ? h('img', { src: src(f), alt: '' }) : tile('file', 'blue', 'sm'), h('span', { class: 'grow' }, h('span', { class: 'fn' }, f.name), h('small', { class: 'muted' }, size(f.size))), h('button', { type: 'button', class: 'iconbtn', title: '移除', 'aria-label': `移除 ${f.name}`, onclick: () => { drop(f); files.splice(i, 1); draw(); } }, icon('x')))));
  const add = (fl) => { for (const f of fl) files.push(f); draw(); };
  const ta = h('textarea', { placeholder, 'aria-label': placeholder, onpaste: (e) => { if (e.clipboardData.files.length) { e.preventDefault(); add(e.clipboardData.files); } } });
  const note = noteToggle && h('input', { type: 'checkbox', onchange: () => box.classList.toggle('note', note.checked) });
  const pick = h('input', { type: 'file', multiple: true, class: 'vh', onchange: (e) => { add(e.target.files); e.target.value = ''; } });
  const box = h('div', { class: 'composer', ondragover: (e) => { e.preventDefault(); box.classList.add('over'); }, ondragleave: () => box.classList.remove('over'), ondrop: (e) => { e.preventDefault(); box.classList.remove('over'); add(e.dataTransfer.files); } },
    ta,
    list, h('div', { class: 'row cbar' }, h('label', { class: 'btn ghost' }, pick, icon('clip'), '添加附件'), h('span', { class: 'small muted grow wide' }, '可直接粘贴截图或拖入文件'), !noteToggle && h('span', { class: 'grow' }), note && h('label', { class: 'small chk' }, note, ' 仅作内部备注'),
      h('button', { class: 'primary', onclick: act(async () => { const fd = new FormData(); fd.set('text', ta.value); if (note?.checked) fd.set('kind', 'note'); await onSend(fd, files); for (const f of files) drop(f); }) }, label)));
  return box;
}
async function feedbackPage(id) {
  const f = await api(`/feedbacks/${id}`);
  const save = (patch, msg = '已保存') => act(async () => { await api(`/feedbacks/${id}`, { method: 'PATCH', body: patch }); await loadMeta(); toast(msg); render(); })();
  const field = (k, ic, label, el) => h('label', {}, h('span', {}, icon(ic), label, f[k + '_auto'] === 1 && f[k] && h('em', { class: 'auto', title: '自动识别，改动后以你的为准' }, '自动')), el);
  const text = (k, list) => h('input', { value: f[k] ?? '', list, placeholder: '未填写', onchange: (e) => save({ [k]: e.target.value }) });
  const sel = (k, pairs, first) => h('select', { onchange: (e) => save({ [k]: e.target.value }) }, opts(pairs, f[k] ?? '', first));
  const cats = [...new Set([...meta.categories.map((c) => c.name), f.category].filter(Boolean))].map((n) => [n, n]);
  const res = h('textarea', { 'aria-label': '处理结果', placeholder: '原因、处理办法、给客户的答复…以后遇到同类问题会直接提示' }); res.value = f.resolution;
  const moveMsg = (m) => act(async () => {
    const v = await ask({ title: '移动或拆分这条素材', text: '填要移到的反馈编号；留空则拆成一条新反馈', value: '', placeholder: '反馈编号，如 12' }); if (v === null) return;
    const to = v.trim() === '' ? null : Number(v.replace('#', '')); if (to !== null && !Number.isInteger(to)) throw new Error('编号无效');
    const r = await api(`/messages/${m.id}/move`, { method: 'POST', body: { to } }); toast(`已移到 #${r.id}`); location.hash = `#/feedbacks/${r.id}`;
  });
  return h('div', {},
    h('div', { class: 'row crumbs' }, h('a', { href: '#/feedbacks' }, icon('back'), '反馈列表'), h('span', { class: 'grow' }), f.deleted_at
      ? ib('history', '恢复', { onclick: act(async () => { await api(`/feedbacks/${id}/restore`, { method: 'POST' }); toast('已恢复'); render(); }) })
      : ib('trash', '删除', { class: 'danger', onclick: act(async () => { if (!(await ask({ title: '移入回收站？', text: `#${f.id} ${f.title}`, ok: '移入回收站', danger: true }))) return; await api(`/feedbacks/${id}`, { method: 'DELETE' }); toast('已移入回收站'); location.hash = '#/feedbacks'; }) })),
    h('div', { class: 'dhead' }, catTile(f.category, 'lg'), h('div', { class: 'grow' },
      h('h1', {}, h('span', { class: 'hid' }, `#${f.id}`), ` ${f.title}`, f.deleted_at && h('span', { class: 'sev-urgent' }, '（已删除）')),
      h('div', { class: 'row small muted dmeta' }, statusEl(f.status), sevEl(f.severity), f.reporter && person(f.reporter), [[f.category, 'tag'], [f.product, 'box'], [f.version, 'branch'], [time(f.created_at), 'clock']].filter(([x]) => x).map(([x, ic]) => h('span', { class: 'mi' }, icon(ic), x))))),
    h('div', { class: 'two' },
      h('div', {},
        h('div', { class: 'card' }, h2('chat', '反馈内容', 'blue', h('span', { class: 'cnt' }, f.messages.length)),
          h('div', { class: 'thread' }, f.messages.map((m) => h('div', { class: `msg ${m.kind}` }, avatar(who(m.author)), h('div', { class: 'grow' }, h('div', { class: 'small muted mh' }, h('b', {}, who(m.author)), h('span', { class: `src ${m.kind === 'note' ? 'n' : m.channel}` }, icon(m.kind === 'note' ? 'note' : m.channel === 'qq' ? 'chat' : 'globe'), m.kind === 'note' ? '备注' : m.channel === 'qq' ? 'QQ' : '网页'), h('span', { class: 'grow' }, time(m.sent_at)), m.kind === 'report' && h('button', { class: 'link', onclick: moveMsg(m) }, '移动/拆分')),
            m.text && h('div', { class: 'body' }, m.text), m.attachments.length > 0 && h('div', { class: 'atts' }, m.attachments.map(attachment)))))),
          composer({ label: '追加', placeholder: '追加内容或备注…', noteToggle: true, onSend: async (fd, files) => { for (const x of files) fd.append('files', x); await api(`/feedbacks/${id}/messages`, { method: 'POST', form: fd }); toast('已追加'); render(); } })),
        h('div', { class: 'card' }, h2('resolved', '处理结果', 'green'), res, h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { onclick: () => save({ resolution: res.value }) }, '保存'), f.status !== 'resolved' && ib('check', '保存并标为已解决', { class: 'primary good', onclick: () => save({ resolution: res.value, status: 'resolved' }, '已标为解决') }))),
        h('div', { class: 'card' }, h2('layers', '同类问题', 'violet'),
          f.topic && h('div', { class: 'topicbox' }, h('div', { class: 'row' }, icon('layers'), h('a', { class: 'grow', href: `#/topics/${f.topic.id}` }, f.topic.title), h('button', { class: 'link', onclick: () => save({ topic_id: null }, '已移出') }, '移出')), f.topic.solution && h('div', { class: 'small', style: 'white-space:pre-wrap' }, '方案：' + f.topic.solution)),
          f.similar.length ? f.similar.map((s) => { const p = Math.round(s.score * 100); return h('div', { class: 'sim' }, h('div', { class: 'row' }, h('a', { class: 'grow', href: `#/feedbacks/${s.id}` }, h('span', { class: 'hid' }, `#${s.id}`), ` ${s.title}`), h('span', { class: 'score muted small' }, h('span', { class: 'meter' }, h('i', { style: `width:${p}%` })), `相似 ${p}%`), statusEl(s.status),
            !(f.topic_id && s.topic_id === f.topic_id) && h('button', { class: 'sm', onclick: act(async () => { const g = await api(`/feedbacks/${id}/group`, { method: 'POST', body: { with: s.id } }); await loadMeta(); toast(`已归入「${g.title}」，共 ${g.count} 条`); render(); }) }, '归为同类')),
            (s.resolution || s.topic_solution) && h('div', { class: 'small hintline' }, icon('bulb'), h('span', {}, '办法：' + (s.resolution || s.topic_solution)))); }) : h('div', { class: 'muted' }, '没有找到相似的反馈'),
          h('div', { class: 'row', style: 'margin-top:12px' }, h('select', { class: 'grow', 'aria-label': '归入已有问题', onchange: (e) => e.target.value && save({ topic_id: Number(e.target.value) }, '已归入') }, opts(meta.topics.filter((t) => t.id !== f.topic_id).map((t) => [String(t.id), `${t.title}（${t.count}）`]), '', '归入已有问题…')),
            ib('plus', '新建问题', { onclick: act(async () => { const t = await ask({ title: '新建同类问题', text: '给这一类问题起个标题', value: f.title, ok: '新建' }); if (!t) return; const r = await api('/topics', { method: 'POST', body: { title: t } }); await api(`/feedbacks/${id}`, { method: 'PATCH', body: { topic_id: r.id } }); await loadMeta(); toast('已新建'); render(); }) })))),
      h('div', { class: 'aside' },
        h('div', { class: 'card form props' }, h2('sliders', '属性', 'indigo'),
          h('div', { class: 'seg', role: 'group', 'aria-label': '状态' }, Object.entries(meta.status).map(([k, t]) => h('button', { class: `${k} ${f.status === k ? 'on' : ''}`, 'aria-pressed': String(f.status === k), onclick: () => f.status !== k && save({ status: k }) }, icon(k), t))),
          field('title', 'title', '标题', text('title')), field('severity', 'flag', '优先级', sel('severity', Object.entries(meta.severity))), field('category', 'tag', '分类', sel('category', cats, '（自动识别）')),
          field('product', 'box', '产品', text('product', 'dl-product')), field('version', 'branch', '版本', text('version')), field('reporter', 'user', '反馈人 / 客户', text('reporter', 'dl-reporter')), field('source', 'compass', '来源', text('source')),
          field('tags', 'tag', '标签（逗号分隔）', h('input', { value: f.tags.join('，'), placeholder: '未填写', onchange: (e) => save({ tags: e.target.value.split(/[,，、\s]+/).filter(Boolean) }) })),
          h('datalist', { id: 'dl-product' }, meta.products.map((p) => h('option', { value: p.name }))), h('datalist', { id: 'dl-reporter' }, meta.reporters.map((v) => h('option', { value: v }))),
          h('div', { class: 'small muted stamp' }, h('div', {}, icon('plus'), `创建 ${time(f.created_at)}`), f.resolved_at && h('div', {}, icon('check'), `解决 ${time(f.resolved_at)}`))),
        h('div', { class: 'card' }, h('details', { class: 'log' }, h('summary', {}, icon('history'), `操作记录（${f.events.length}）`), h('div', { class: 'tl' }, f.events.map((e) => h('div', { class: 'small' }, h('div', {}, `${e.action} ${e.detail}`), h('div', { class: 'muted' }, `${time(e.at)} ${who(e.actor)}`)))))))));
}
function addDialog() {
  const inp = (n, label, list) => h('label', {}, h('span', {}, label), h('input', { name: n, list }));
  const form = h('form', { class: 'form', onsubmit: (e) => e.preventDefault() }, h('div', { class: 'grid3' }, inp('reporter', '反馈人 / 客户', 'ad-rep'), inp('product', '产品', 'ad-prod'), h('label', {}, h('span', {}, '优先级'), h('select', { name: 'severity' }, opts(Object.entries(meta.severity), 'normal')))),
    h('datalist', { id: 'ad-rep' }, meta.reporters.map((v) => h('option', { value: v }))), h('datalist', { id: 'ad-prod' }, meta.products.map((p) => h('option', { value: p.name }))));
  const d = h('dialog', { onclose: () => d.remove() }, h('div', { class: 'dlghead' }, tile('plus', 'blue'), h('div', { class: 'grow' }, h('h2', {}, '新增反馈'), h('div', { class: 'small muted' }, '标题、分类、版本会自动识别，不用填')), h('button', { class: 'iconbtn', 'aria-label': '关闭', title: '关闭', onclick: () => d.close() }, icon('x'))), form,
    composer({ label: '保存', placeholder: '粘贴微信里的文字或截图…', onSend: async (fd, files) => { for (const [k, v] of new FormData(form)) if (v) fd.set(k, v); for (const x of files) fd.append('files', x); const r = await api('/feedbacks', { method: 'POST', form: fd }); d.close(); await loadMeta(); toast(`已记录 #${r.id}`); location.hash = `#/feedbacks/${r.id}`; } }));
  document.body.append(d); d.showModal(); d.querySelector('textarea').focus();
}

// ───────── 同类问题 ─────────
async function topicsPage(q) {
  const list = await api('/topics?' + qs(q));
  const row = (t) => { const todo = t.todo ?? 0, done = t.count - todo, cat = (t.categories ?? '').split(',')[0]; return h('tr', { class: 'click', onclick: (e) => { if (!e.target.closest('a')) location.hash = `#/topics/${t.id}`; } },
    h('td', {}, h('div', { class: 'cell' }, cat ? catTile(cat) : tile('layers', 'violet'), h('div', { class: 'grow' }, h('a', { class: 't', href: `#/topics/${t.id}` }, t.title), h('div', { class: 'small muted meta' }, t.solution ? h('span', { class: 'hintline' }, icon('bulb'), h('span', {}, '方案：' + t.solution.slice(0, 80))) : h('span', {}, '还没有方案'))))),
    h('td', { class: 'num' }, h('b', {}, t.count)),
    h('td', { class: 'wide' }, h('div', { class: 'prog', title: `已完结 ${done}，未完结 ${todo}` }, h('span', { class: 'meter good' }, h('i', { style: `width:${t.count ? (done / t.count) * 100 : 0}%` })), h('span', { class: 'small muted' }, `${done}/${t.count}`))),
    h('td', { class: 'num wide' }, t.reporters), h('td', { class: 'nowrap muted wide' }, t.first_at ? ymd(t.first_at) : '—'), h('td', { class: 'nowrap muted wide' }, t.last_at ? ago(t.last_at) : '—'), h('td', {}, statusEl(t.status))); };
  return h('div', {}, pageHead('同类问题', '把相似的反馈归到一起，沉淀原因和方案'),
    h('div', { class: 'filters' }, h('div', { class: 'row top' }, searchBox(q.q, '搜索问题、原因、方案…', (v) => { location.hash = '#/topics?' + qs({ q: v }); }),
      ib('plus', '新建问题', { onclick: act(async () => { const t = await ask({ title: '新建同类问题', value: '', placeholder: '问题标题', ok: '新建' }); if (!t) return; const r = await api('/topics', { method: 'POST', body: { title: t } }); await loadMeta(); location.hash = `#/topics/${r.id}`; }) }))),
    list.length === 0 ? h('div', { class: 'card' }, q.q ? empty('search', '没有找到', h('a', { class: 'btn', href: '#/topics' }, '清除条件')) : empty('layers', '还没有同类问题。在反馈详情里点「归为同类」，或在 QQ 里回复「同类 编号」。'))
      : h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '问题'), h('th', { class: 'num' }, '反馈数'), h('th', { class: 'wide' }, '完结进度'), h('th', { class: 'num wide' }, '客户数'), h('th', { class: 'wide' }, '首次'), h('th', { class: 'wide' }, '最近'), h('th', {}, '状态'))), h('tbody', {}, list.map(row)))));
}
async function topicPage(id) {
  const t = await api(`/topics/${id}`);
  const area = (k, ic, label, ph) => { const el = h('textarea', { placeholder: ph }); el.value = t[k]; return [k, el, h('label', {}, h('span', {}, icon(ic), label), el)]; };
  const title = h('input', { value: t.title }); const fs = [area('root_cause', 'search', '原因分析', '根本原因、触发条件、影响版本…'), area('solution', 'bulb', '解决方案', '修复版本、临时办法、给客户的答复…')];
  const put = (extra = {}) => act(async () => { await api(`/topics/${id}`, { method: 'PATCH', body: { title: title.value, ...Object.fromEntries(fs.map(([k, el]) => [k, el.value])), ...extra } }); await loadMeta(); toast('已保存'); render(); });
  const todo = t.feedbacks.filter((f) => ['open', 'doing'].includes(f.status)).length, n = t.feedbacks.length, people = new Set(t.feedbacks.map((f) => f.reporter).filter(Boolean)).size;
  return h('div', {}, h('div', { class: 'row crumbs' }, h('a', { href: '#/topics' }, icon('back'), '同类问题'), h('span', { class: 'grow' }), h('a', { class: 'btn', href: `/api/export/md?topic=${id}` }, icon('file'), '导出 Markdown'), h('a', { class: 'btn', href: `/api/export/csv?topic=${id}` }, icon('table'), '导出 CSV'), ib('trash', '删除', { class: 'danger', onclick: act(async () => { if (!(await ask({ title: '删除这个问题？', text: '其下的反馈不会删除。', ok: '删除', danger: true }))) return; await api(`/topics/${id}`, { method: 'DELETE' }); await loadMeta(); location.hash = '#/topics'; }) })),
    h('div', { class: 'dhead' }, tile('layers', 'violet', 'lg'), h('div', { class: 'grow' }, h('h1', {}, t.title), h('div', { class: 'row small muted dmeta' }, statusEl(t.status), h('span', { class: 'mi' }, icon('inbox'), `${n} 条反馈`), people > 0 && h('span', { class: 'mi' }, icon('users'), `${people} 位客户`), n > 0 && h('span', { class: 'prog' }, h('span', { class: 'meter good' }, h('i', { style: `width:${((n - todo) / n) * 100}%` })), `完结 ${n - todo}/${n}`)))),
    h('div', { class: 'card form' }, h('label', {}, h('span', {}, icon('title'), '标题'), title), h('div', { class: 'grid2' }, fs.map((x) => x[2])), h('div', { class: 'row' }, h('button', { class: 'primary', onclick: put() }, '保存'),
      t.status === 'open' ? ib('check', todo ? `标为已解决（含 ${todo} 条未完结反馈）` : '标为已解决', { onclick: put({ status: 'resolved', cascade: todo > 0 }) }) : h('button', { onclick: put({ status: 'open' }) }, '重新打开'))),
    h('div', { class: 'card' }, h2('inbox', `相关反馈（${n}）`, 'blue'), t.feedbacks.map((f) => h('a', { class: 'sim row lk', href: `#/feedbacks/${f.id}` }, catTile(f.category, 'sm'), h('span', { class: 'grow' }, h('span', { class: 'hid' }, `#${f.id}`), ` ${f.title}`), f.reporter && person(f.reporter), h('span', { class: 'muted small' }, [f.version, time(f.created_at)].filter(Boolean).join(' · ')), statusEl(f.status))), n === 0 && h('div', { class: 'muted' }, '暂无')));
}

// ───────── 统计 ─────────
function bars(ic, color, title, rows, { link, label = (r) => r.name, empty: none = '未填写', mark } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.count)), total = rows.reduce((s, r) => s + r.count, 0);
  return h('div', { class: 'card' }, h2(ic, title, color), rows.length === 0 && h('div', { class: 'muted nodata' }, icon(ic), '暂无数据'), rows.map((r) => {
    const n = label(r) || none, tip = `${n}：${r.count} 条（${Math.round((r.count / total) * 100)}%）${r.todo ? `，未完结 ${r.todo}` : ''}`;
    return h('a', { class: 'bar', href: link && r.name !== '' ? link(r) : undefined, tabindex: 0, 'aria-label': tip }, h('span', { class: 'n' }, mark?.(r), h('span', {}, n)), h('span', { class: 'tr' }, h('i', { style: `width:${(r.count / max) * 100}%` })), h('span', { class: 'v' }, r.count), h('span', { class: 'tip' }, tip));
  }));
}
/** 按状态：一条分段条 + 图例。颜色之外都有图标和文字。 */
function statusSplit(s, link) {
  const rows = Object.keys(meta.status).map((k) => ({ name: k, count: s.byStatus.find((r) => r.name === k)?.count ?? 0 }));
  return h('div', { class: 'card' }, h2('compass', '按状态', 'green'), s.total === 0 ? h('div', { class: 'muted nodata' }, icon('compass'), '暂无数据') : [
    h('div', { class: 'split' }, rows.filter((r) => r.count).map((r) => { const tip = `${meta.status[r.name]}：${r.count} 条（${Math.round((r.count / s.total) * 100)}%）`; return h('a', { class: r.name, href: link(r), style: `flex-grow:${r.count}`, 'aria-label': tip, 'data-tip': tip }); })),
    h('div', { class: 'legend' }, rows.map((r) => h('a', { href: link(r) }, statusEl(r.name), h('b', {}, r.count), h('span', { class: 'muted small' }, `${Math.round((r.count / s.total) * 100)}%`))))]);
}
/** 每月：柱状图，柱顶标数。补齐没有反馈的月份。 */
function months(rows) {
  const full = [];
  if (rows.length) { let [y, m] = rows[0].name.split('-').map(Number); const end = rows.at(-1).name; for (;;) { const name = `${y}-${pad(m)}`; full.push({ name, count: rows.find((r) => r.name === name)?.count ?? 0 }); if (name >= end) break; if (++m > 12) { m = 1; y++; } } }
  const show = full.slice(-12);
  while (show.length && show.length < 6) { let [y, m] = show[0].name.split('-').map(Number); if (--m < 1) { m = 12; y--; } show.unshift({ name: `${y}-${pad(m)}`, count: 0 }); }
  const max = Math.max(1, ...show.map((r) => r.count));
  return h('div', { class: 'card' }, h2('calendar', '每月反馈数', 'cyan'), !show.length ? h('div', { class: 'muted nodata' }, icon('calendar'), '暂无数据') : h('div', { class: 'cols' }, show.map((r) => h('div', { class: 'col', 'data-tip': `${r.name}　${r.count} 条` }, h('span', { class: 'v' }, r.count || ''), h('i', { style: `height:${(r.count / max) * 100}%` }), h('span', { class: 'x' }, `${Number(r.name.slice(5))} 月`)))));
}
async function statsPage(q) {
  const s = await api('/stats?' + qs(q)), to = (k) => (r) => '#/feedbacks?' + qs({ ...q, [k]: r.name });
  const days = s.avg_resolve_ms ? s.avg_resolve_ms / 86400000 : null, took = days === null ? '—' : days * 24 < 1 ? `${Math.max(1, Math.round(days * 1440))} 分钟` : days < 1 ? `${(days * 24).toFixed(1)} 小时` : `${days.toFixed(1)} 天`;
  const pct = (n) => (s.total ? `占 ${Math.round((n / s.total) * 100)}%` : '');
  return h('div', {}, pageHead('统计', '哪类问题最多、处理得怎么样；点任意一条可查看对应反馈'), filterBar(q, 'stats'),
    h('div', { class: 'kpis' }, [['inbox', 'blue', '反馈总数', s.total, ''], ['open', 'amber', '未完结', s.todo, pct(s.todo)], ['resolved', 'green', '已解决', s.resolved, pct(s.resolved)], ['clock', 'violet', '平均解决用时', took, '']].map(([ic, c, k, v, sub]) => h('div', { class: `kpi hue-${c}` }, tile(ic, c), h('div', {}, h('b', {}, v), h('span', {}, k)), sub && h('small', {}, sub)))),
    h('div', { class: 'charts' },
      h('div', { class: 'stack' }, bars('tag', 'blue', '按分类', s.byCategory, { link: to('category'), mark: (r) => catTile(r.name, 'sm') }),
        bars('layers', 'violet', '高频同类问题（全部）', s.topTopics.map((t) => ({ name: t.title, count: t.count, todo: t.todo, id: t.id })), { link: (r) => `#/topics/${r.id}` }),
        bars('users', 'orange', '按反馈人', s.byReporter, { link: to('reporter'), mark: (r) => avatar(r.name) })),
      h('div', { class: 'stack' }, statusSplit(s, to('status')), months(s.byMonth), bars('flag', 'red', '按优先级', s.bySeverity, { link: to('severity'), label: (r) => meta.severity[r.name], mark: (r) => sevIcon(r.name) }),
        bars('box', 'teal', '按产品', s.byProduct, { link: to('product') }), bars('branch', 'indigo', '按版本', s.byVersion), bars('tag', 'pink', '按标签', s.byTag, { link: to('tag') }))));
}

// ───────── 设置 ─────────
function phoneCard(s) {
  return h('div', { class: 'card' }, h2('phone', '手机查看', 'green'),
    s.access.length === 0 ? h('div', { class: 'muted' }, window.tgDesktop ? '现在只有本机能打开。到「控制台 → 设置 → 访问」打开局域网访问。' : '现在只有本机能打开。在 .env 里设 HOST=0.0.0.0（同一 Wi-Fi 可用）或填写 PUBLIC_URL（外网可用），然后重启。')
      : [h('div', { class: 'small muted', style: 'margin-bottom:12px' }, s.publicUrl ? '手机扫码打开，用登录密码进入。可「添加到主屏幕」当 App 用。' : '手机连同一 Wi-Fi 后扫码打开，用登录密码进入。可「添加到主屏幕」当 App 用。在外面用需要先配置外网地址。'),
        h('div', { class: 'row qrs' }, s.access.map((a) => h('div', { class: 'qrbox' }, h('img', { class: 'qr', src: a.qr, alt: `${a.url} 的二维码` }), h('div', { class: 'small' }, h('b', {}, a.kind === 'public' ? '外网 ' : '局域网 '), a.url))))]);
}
function mcpCard(s) {
  const url = `${location.origin}/mcp`, out = h('div', {});
  const name = h('input', { placeholder: '名称，如 我的 Claude', 'aria-label': '令牌名称' });
  const block = (label, text) => h('div', { style: 'margin-top:10px' }, h('div', { class: 'row small' }, h('b', { class: 'grow' }, label), h('button', { type: 'button', class: 'link', onclick: () => copy(text) }, '复制')), h('pre', { class: 'cmd' }, text));
  const create = act(async () => {
    const { token } = await api('/mcp-tokens', { method: 'POST', body: { name: name.value || 'AI 助手' } });
    await render();
    document.getElementById('mcp-out').replaceChildren(h('div', { class: 'sev-high', style: 'margin-top:10px' }, '令牌只显示这一次，请立即复制：'),
      block('Claude Code（终端执行）', `claude mcp add --transport http --scope user tiangong-feedback ${url} --header "Authorization: Bearer ${token}"`),
      block('Codex（追加到 ~/.codex/config.toml）', `[mcp_servers.tiangong-feedback]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`),
      block('其他支持 MCP 的工具（JSON）', JSON.stringify({ mcpServers: { 'tiangong-feedback': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)));
  });
  out.id = 'mcp-out';
  const issueNo = h('input', { inputmode: 'numeric', placeholder: '问题编号，如 12', 'aria-label': '单问题编号' });
  const authOut = h('div', {}); authOut.id = 'mcp-auth-out';
  const authBlock = (scope) => act(async () => {
    const body = scope === 'issue' ? { scope, issue_id: Number(issueNo.value) } : { scope };
    const r = await api('/mcp-authorizations', { method: 'POST', body });
    await render();
    document.getElementById('mcp-auth-out')?.replaceChildren(h('div', { class: 'sev-high', style: 'margin-top:10px' }, '授权码只显示这一次，请立即复制并交给 MCP：'),
      h('div', { class: 'row sim' }, h('code', { class: 'grow' }, r.code), h('button', { class: 'link', onclick: () => copy(r.code) }, '复制')),
      h('div', { class: 'small muted' }, `作用范围：${r.authorization.scope === 'all' ? '全部问题及同类问题' : `问题 #${r.authorization.issueId}`} · 到期：${time(r.authorization.expiresAt)}`));
  });
  const authRows = (s.authorizations ?? []).map((a) => h('div', { class: 'row sim' }, tile(a.scope === 'all' ? 'layers' : 'key', a.active ? 'green' : 'slate', 'sm'), h('span', { class: 'grow' }, a.scope === 'all' ? '全部问题及同类问题' : `问题 #${a.issue_id}`, h('div', { class: 'muted small' }, `授权人 ${a.issuer} · 到期 ${time(a.expires_at)}${a.active ? '' : ' · 已失效'}`)), a.active && h('button', { class: 'link danger', onclick: act(async () => { await api(`/mcp-authorizations/${a.id}`, { method: 'DELETE' }); await render(); }) }, '撤销')));
  const auditRows = (s.mcpAudit ?? []).slice(0, 20).map((a) => h('div', { class: 'small sim' }, h('span', { class: a.success ? 'sev-resolved' : 'sev-urgent' }, a.success ? '成功' : '拒绝'), ` ${time(a.at)} · ${a.operation} · ${a.issue_id ? `问题 #${a.issue_id}` : a.topic_id ? `同类问题 #${a.topic_id}` : '—'} · 授权人 ${a.issuer || '未知'} · MCP ${a.token_name || '未知'}`));
  return h('div', { class: 'card' }, h2('ai', 'AI 助手（MCP）', 'orange'), h('div', { class: 'small muted' }, `让 Claude Code、Codex 等查询问题库；写入必须使用这里签发的短期授权码。地址 ${url}`),
    s.tokens.map((t) => h('div', { class: 'row sim' }, tile('key', 'slate', 'sm'), h('span', { class: 'grow' }, t.name, h('span', { class: 'muted small' }, ` 创建于 ${time(t.created_at)} · ${t.last_used_at ? `最近使用 ${time(t.last_used_at)}` : '未使用过'}`)), h('button', { class: 'link danger', onclick: act(async () => { if (!(await ask({ title: `撤销「${t.name}」？`, text: '使用它的助手将立即无法访问。', ok: '撤销', danger: true }))) return; await api(`/mcp-tokens/${t.id}`, { method: 'DELETE' }); render(); }) }, '撤销'))),
    h('div', { class: 'row', style: 'margin-top:12px' }, name, ib('key', '生成访问令牌', { onclick: create })), out,
    h('div', { class: 'subcard', style: 'margin-top:16px' }, h('b', {}, '临时写入授权'), h('div', { class: 'small muted', style: 'margin:6px 0 10px' }, '授权码最长 15 分钟。单问题码只允许修改指定问题，全部问题码还可修改同类问题。服务端会记录真实授权人和 MCP 来源。'),
      h('div', { class: 'row' }, issueNo, ib('key', '签发单问题码', { onclick: authBlock('issue') }), ib('layers', '签发全部问题码', { onclick: authBlock('all') })), authOut, authRows,
      auditRows.length > 0 && h('details', { class: 'log', style: 'margin-top:12px' }, h('summary', {}, icon('history'), 'MCP 写入审计'), auditRows)));
}
async function settingsPage() {
  const s = await api('/system');
  const codeBox = h('div', {});
  const tax = (kind, ic, color, title, hint) => {
    const rows = kind === 'category' ? meta.categories : meta.products;
    const save = (o, msg) => act(async () => { await api(`/taxonomy/${kind}`, { method: 'POST', body: o() }); await loadMeta(); toast(msg); render(); });
    const line = (c) => { const n = h('input', { value: c?.name ?? '', placeholder: '名称', 'aria-label': '名称', style: 'width:140px' }), k = h('input', { value: c?.keywords ?? '', placeholder: '关键词，逗号分隔', 'aria-label': '关键词', class: 'grow' });
      return h('div', { class: `row taxline ${c ? '' : 'new'}` }, kind === 'category' && c ? catTile(c.name, 'sm') : tile(c ? 'box' : 'plus', c ? 'teal' : 'slate', 'sm'), n, k, h('button', { onclick: save(() => ({ id: c?.id, name: n.value, keywords: k.value }), '已保存，自动归类的反馈已重新识别') }, c ? '保存' : '添加'), c && h('button', { class: 'link danger', onclick: act(async () => { if (!(await ask({ title: `删除「${c.name}」？`, ok: '删除', danger: true }))) return; await api(`/taxonomy/${kind}/${c.id}`, { method: 'DELETE' }); await loadMeta(); render(); }) }, '删除')); };
    return h('div', { class: 'card' }, h2(ic, title, color, h('span', { class: 'cnt' }, rows.length)), h('div', { class: 'small muted', style: 'margin-bottom:12px' }, hint), rows.map(line), line(null));
  };
  const stat = (ic, color, label, value, sub, cls) => h('div', { class: 'stat' }, tile(ic, color), h('div', {}, h('span', { class: 'small muted' }, label), h('b', {}, cls !== undefined && h('i', { class: `dot ${cls}` }), value), sub && h('div', { class: 'small muted' }, sub)));
  const q = s.queue, busy = q.downloading + q.recognizing;
  return h('div', {}, pageHead('设置', '机器人、访问方式、AI 助手和自动归类'),
    h('div', { class: 'card' }, h2('pulse', '运行状态', 'blue'),
      h('div', { class: 'stats' }, stat('chat', 'blue', '机器人', BOT[s.bot.state] ?? s.bot.state, s.bot.reason || (s.bot.lastEventAt ? `最近事件 ${time(s.bot.lastEventAt)}` : ''), BOT_CLS[s.bot.state] ?? ''), stat('scan', 'violet', '截图文字识别', { ready: '正常', unavailable: '不可用', disabled: '已关闭' }[s.ocr], '本机离线识别', { ready: 'ok', unavailable: 'bad', disabled: '' }[s.ocr]), stat('clip', q.failed ? 'red' : 'teal', '附件', q.failed ? `${q.failed} 个失败` : busy ? `${busy} 个处理中` : '全部就绪', `待下载 ${q.downloading}，待识别 ${q.recognizing}，失败 ${q.failed}`), stat('clock', 'orange', '连续消息合并', `${s.mergeWindowMinutes} 分钟`, `启动于 ${time(s.startedAt)}`)),
      h('div', { class: 'small muted datadir' }, icon('db'), `数据目录 ${s.dataDir}`)),
    h('div', { class: 'two even' },
      h('div', { class: 'card' }, h2('chat', 'QQ 账号', 'cyan', h('span', { class: 'cnt' }, s.users.length)), h('div', { class: 'small muted' }, '只有绑定过的 QQ 才能向机器人记录和查询反馈。'), s.users.map((u) => h('div', { class: 'row sim' }, avatar(u.nickname || 'QQ'), h('span', { class: 'grow' }, u.nickname || 'QQ 用户', h('div', { class: 'muted small' }, `${u.openid.slice(0, 8)}… 绑定于 ${time(u.bound_at)}`)), h('button', { class: 'link danger', onclick: act(async () => { if (!(await ask({ title: '解除绑定？', text: `${u.nickname || 'QQ 用户'} 解绑后不能再提交和查询。`, ok: '解绑', danger: true }))) return; await api(`/qq-users/${encodeURIComponent(u.openid)}`, { method: 'DELETE' }); await loadMeta(); render(); }) }, '解绑'))), codeBox,
        ib('link', '生成绑定码', { style: 'margin-top:12px', onclick: act(async () => { const r = await api('/bind-code', { method: 'POST' }); codeBox.replaceChildren(h('div', { class: 'code' }, `绑定 ${r.code}`), h('div', { class: 'small muted' }, `在 QQ 里把上面这行发给机器人，${time(r.exp).slice(11)} 前有效，仅可用一次`)); }) })),
      phoneCard(s)),
    mcpCard(s),
    tax('product', 'box', 'teal', '产品', '名称和关键词出现在反馈里时自动标注产品。'), tax('category', 'tag', 'pink', '分类', '按关键词自动归类；人工改过分类的反馈不受影响。'));
}

render();
