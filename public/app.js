// 轻量单页应用：无构建、无第三方依赖。所有用户内容都以文本节点写入，不拼接 HTML。
const $app = document.getElementById('app');
let meta = null;

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
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
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
  try { await fn(e); } catch (err) { toast(err.message); } finally { if (b?.tagName === 'BUTTON') b.disabled = false; }
};
const pad = (n) => String(n).padStart(2, '0');
const time = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
const statusEl = (s) => h('span', { class: `st ${s}` }, meta.status[s]);
const who = (a) => meta.users.find((u) => u.openid === a)?.nickname || (meta.users.some((u) => u.openid === a) ? 'QQ 用户' : /^[0-9A-F]{16,}$/i.test(a) ? 'QQ 用户' : a);
const opts = (pairs, cur, first) => [first !== undefined && h('option', { value: '' }, first), ...pairs.map(([v, t]) => h('option', { value: v, selected: v === cur }, t))];
const loadMeta = async () => { meta = await api('/meta'); };

// ───────── 路由 ─────────
const NAV = [['feedbacks', '反馈'], ['topics', '同类问题'], ['stats', '统计'], ['settings', '设置']];
const route = () => { const [p, q] = (location.hash.slice(1) || '/feedbacks').split('?'); const [, page, id] = p.split('/'); return { page: page || 'feedbacks', id, query: Object.fromEntries(new URLSearchParams(q)) }; };
let seq = 0;
async function render() {
  const my = ++seq, r = route();
  try {
    if (!meta) await loadMeta();
    const view = r.page === 'topics' ? (r.id ? topicPage(r.id) : topicsPage(r.query)) : r.page === 'stats' ? statsPage(r.query) : r.page === 'settings' ? settingsPage() : r.id ? feedbackPage(r.id) : listPage(r.query);
    const el = await view;
    if (my !== seq) return;
    $app.replaceChildren(
      h('header', {}, h('b', {}, '用户反馈库'), h('nav', {}, NAV.map(([k, t]) => h('a', { href: `#/${k}`, class: r.page === k ? 'on' : '' }, t))),
        h('button', { class: 'primary', onclick: () => addDialog() }, '新增反馈'), h('button', { class: 'link', onclick: act(async () => { await api('/logout', { method: 'POST' }); meta = null; renderLogin(); }) }, '退出')),
      h('main', {}, el));
  } catch (e) { if (my === seq && meta) $app.replaceChildren(h('main', {}, h('div', { class: 'empty' }, e.message, ' ', h('a', { href: '#/feedbacks' }, '返回列表')))); }
}
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });

function renderLogin() {
  seq++;
  const pw = h('input', { type: 'password', placeholder: '密码', autocomplete: 'current-password', 'aria-label': '密码' });
  $app.replaceChildren(h('form', { class: 'login', onsubmit: async (e) => { e.preventDefault(); try { await api('/login', { method: 'POST', body: { password: pw.value } }); render(); } catch (err) { toast(err.message); pw.select(); } } },
    h('h1', {}, '用户反馈库'), pw, h('button', { class: 'primary' }, '登录')));
  pw.focus();
}

// ───────── 列表 ─────────
function filterBar(q, page, extra = []) {
  const go = (patch) => { location.hash = `#/${page}?` + qs({ ...q, ...patch, page: '' }); };
  const sel = (k, pairs, label) => h('select', { 'aria-label': label, onchange: (e) => go({ [k]: e.target.value }) }, opts(pairs, q[k] ?? '', label));
  const names = (list) => { const v = list.map((c) => c.name); if (v.length && q.category && !v.includes(q.category) && list === meta.categories) v.push(q.category); return v.map((n) => [n, n]); };
  return h('div', { class: 'row filters' },
    h('form', { class: 'row grow', onsubmit: (e) => { e.preventDefault(); go({ q: e.target.q.value }); } }, h('input', { type: 'search', name: 'q', value: q.q ?? '', placeholder: '搜索正文、截图文字、客户、编号…', 'aria-label': '搜索' })),
    sel('status', [['todo', '未完结'], ...Object.entries(meta.status)], '全部状态'), sel('category', names(meta.categories), '全部分类'),
    meta.products.length > 0 && sel('product', names(meta.products), '全部产品'), sel('severity', Object.entries(meta.severity), '全部优先级'),
    h('input', { type: 'date', value: q.from ?? '', 'aria-label': '开始日期', onchange: (e) => go({ from: e.target.value }) }), h('input', { type: 'date', value: q.to ?? '', 'aria-label': '结束日期', onchange: (e) => go({ to: e.target.value }) }),
    Object.keys(q).some((k) => k !== 'page' && q[k]) && h('button', { class: 'link', onclick: () => { location.hash = `#/${page}`; } }, '清除'), extra);
}
async function listPage(q) {
  const data = await api('/feedbacks?' + qs(q)), page = Number(q.page) || 1, pages = Math.max(1, Math.ceil(data.total / 30));
  const exp = (f) => '/api/export/' + f + '?' + qs({ ...q, page: '' });
  return h('div', {},
    filterBar(q, 'feedbacks'),
    h('div', { class: 'row small muted', style: 'margin-bottom:8px' }, h('span', { class: 'grow' }, `共 ${data.total} 条`,
      q.topic === 'none' ? '（未归并）' : '', q.tag ? `（标签：${q.tag}）` : '', q.reporter ? `（反馈人：${q.reporter}）` : '', q.deleted ? '（回收站）' : ''),
      h('a', { href: '#/feedbacks?topic=none' }, '未归并'), h('a', { href: '#/feedbacks?deleted=1' }, '回收站'), h('span', {}, '导出当前结果：'), h('a', { href: exp('csv') }, 'Excel(CSV)'), h('a', { href: exp('md') }, 'Markdown'), h('a', { href: exp('json') }, 'JSON')),
    data.items.length === 0 ? h('div', { class: 'card empty' }, Object.keys(q).length ? '没有符合条件的反馈' : '还没有反馈。绑定 QQ 后把内容发给机器人，或点右上角「新增反馈」。')
      : h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['编号', '标题', '状态', '优先级', '分类', '反馈人', '素材', '时间'].map((t) => h('th', {}, t)))),
        h('tbody', {}, data.items.map((f) => h('tr', { class: 'click', onclick: (e) => { if (!e.target.closest('a')) location.hash = `#/feedbacks/${f.id}`; } },
          h('td', { class: 'nowrap muted' }, h('a', { href: `#/feedbacks/${f.id}` }, `#${f.id}`)),
          h('td', {}, h('div', { class: 't' }, f.title), f.topic_title && h('a', { class: 'tag', href: `#/topics/${f.topic_id}` }, '同类：' + f.topic_title), f.tags.map((t) => h('a', { class: 'tag', href: '#/feedbacks?' + qs({ tag: t }) }, t))),
          h('td', {}, statusEl(f.status)), h('td', { class: `nowrap sev-${f.severity}` }, meta.severity[f.severity]),
          h('td', { class: 'nowrap' }, f.category, (f.product || f.version) && h('div', { class: 'small muted' }, [f.product, f.version].filter(Boolean).join(' '))),
          h('td', { class: 'nowrap' }, f.reporter), h('td', { class: 'nowrap muted' }, `${f.message_count} 条`, f.attachment_count ? ` / ${f.attachment_count} 附件` : ''), h('td', { class: 'nowrap muted' }, time(f.created_at))))))),
    pages > 1 && h('div', { class: 'pager' }, h('button', { disabled: page <= 1, onclick: () => { location.hash = '#/feedbacks?' + qs({ ...q, page: page - 1 }); } }, '上一页'), `${page} / ${pages}`, h('button', { disabled: page >= pages, onclick: () => { location.hash = '#/feedbacks?' + qs({ ...q, page: page + 1 }); } }, '下一页')));
}

// ───────── 详情 ─────────
function attachment(a) {
  const url = `/api/attachments/${a.id}`, name = a.filename || { image: '图片', voice: '语音', video: '视频', file: '文件' }[a.kind];
  const retry = h('button', { class: 'link', onclick: act(async () => { await api(url.slice(4) + '/retry', { method: 'POST' }); toast('已重新加入队列'); setTimeout(render, 1500); }) }, '重试');
  return h('div', { class: 'att' },
    a.status === 'pending' ? h('span', { class: 'muted' }, `${name} 下载中…`, a.error && `（${a.error}，将自动重试）`)
      : a.status === 'failed' ? h('span', {}, h('span', { class: 'sev-urgent' }, `⚠ ${name} 保存失败`), `：${a.error ?? ''} `, retry)
      : a.kind === 'image' && /^image\//.test(a.mime) ? h('img', { src: url, alt: name, loading: 'lazy', onclick: () => { const d = h('dialog', { class: 'img', onclick: () => d.close(), onclose: () => d.remove() }, h('img', { src: url, alt: name })); document.body.append(d); d.showModal(); } })
      : /^audio\//.test(a.mime) ? h('audio', { src: url, controls: true, preload: 'none' }) : /^video\/mp4/.test(a.mime) ? h('video', { src: url, controls: true, preload: 'metadata' }) : null,
    a.status === 'done' && h('div', { class: 'small' }, h('a', { href: url + '?dl=1' }, name), ' ', h('span', { class: 'muted' }, size(a.size))),
    a.ocr_status === 'failed' && h('div', { class: 'small muted' }, '文字识别失败 ', retry), a.status === 'done' && a.ocr_status === 'pending' && h('div', { class: 'small muted' }, '等待文字识别'),
    a.text && h('details', { open: a.text.length < 120 }, h('summary', { class: 'small muted' }, a.kind === 'voice' ? '语音转写' : '识别文字'), h('pre', {}, a.text)));
}
function composer({ onSend, label, placeholder, noteToggle }) {
  const files = [];
  const list = h('div', { class: 'small' });
  const draw = () => list.replaceChildren(...files.map((f, i) => h('div', {}, `${f.name} ${size(f.size)} `, h('button', { type: 'button', class: 'link', onclick: () => { files.splice(i, 1); draw(); } }, '移除'))));
  const add = (fl) => { for (const f of fl) files.push(f); draw(); };
  const ta = h('textarea', { placeholder, 'aria-label': placeholder, onpaste: (e) => { if (e.clipboardData.files.length) { e.preventDefault(); add(e.clipboardData.files); } } });
  const note = noteToggle && h('input', { type: 'checkbox' });
  const pick = h('input', { type: 'file', multiple: true, onchange: (e) => { add(e.target.files); e.target.value = ''; } });
  const box = h('div', { class: 'composer', ondragover: (e) => { e.preventDefault(); box.classList.add('over'); }, ondragleave: () => box.classList.remove('over'), ondrop: (e) => { e.preventDefault(); box.classList.remove('over'); add(e.dataTransfer.files); } },
    ta,
    list, h('div', { class: 'row' }, h('label', { class: 'small muted grow' }, '附件（可直接粘贴截图或拖入）：', pick), note && h('label', { class: 'small' }, note, ' 仅作内部备注'),
      h('button', { class: 'primary', onclick: act(async () => { const fd = new FormData(); fd.set('text', ta.value); if (note?.checked) fd.set('kind', 'note'); await onSend(fd, files); }) }, label)));
  return box;
}
async function feedbackPage(id) {
  const f = await api(`/feedbacks/${id}`);
  const save = (patch, msg = '已保存') => act(async () => { await api(`/feedbacks/${id}`, { method: 'PATCH', body: patch }); await loadMeta(); toast(msg); render(); })();
  const field = (k, label, el) => h('label', {}, h('span', {}, label, f[k + '_auto'] === 1 && f[k] && '（自动识别）'), el);
  const text = (k, list) => h('input', { value: f[k] ?? '', list, onchange: (e) => save({ [k]: e.target.value }) });
  const sel = (k, pairs, first) => h('select', { onchange: (e) => save({ [k]: e.target.value }) }, opts(pairs, f[k] ?? '', first));
  const cats = [...new Set([...meta.categories.map((c) => c.name), f.category].filter(Boolean))].map((n) => [n, n]);
  const res = h('textarea', { 'aria-label': '处理结果', placeholder: '原因、处理办法、给客户的答复…以后遇到同类问题会直接提示' }); res.value = f.resolution;
  const moveMsg = (m) => act(async () => {
    const v = prompt('移到哪条反馈？填编号；留空则拆成新反馈', ''); if (v === null) return;
    const to = v.trim() === '' ? null : Number(v.replace('#', '')); if (to !== null && !Number.isInteger(to)) throw new Error('编号无效');
    const r = await api(`/messages/${m.id}/move`, { method: 'POST', body: { to } }); toast(`已移到 #${r.id}`); location.hash = `#/feedbacks/${r.id}`;
  });
  return h('div', {},
    h('div', { class: 'row' }, h('a', { href: '#/feedbacks' }, '← 反馈列表'), h('span', { class: 'grow' }), f.deleted_at
      ? h('button', { onclick: act(async () => { await api(`/feedbacks/${id}/restore`, { method: 'POST' }); toast('已恢复'); render(); }) }, '恢复')
      : h('button', { class: 'danger', onclick: act(async () => { if (!confirm('移入回收站？')) return; await api(`/feedbacks/${id}`, { method: 'DELETE' }); toast('已移入回收站'); location.hash = '#/feedbacks'; }) }, '删除')),
    h('h1', { style: 'margin-top:8px;overflow-wrap:anywhere' }, `#${f.id} ${f.title}`, f.deleted_at && h('span', { class: 'sev-urgent' }, '（已删除）')),
    h('div', { class: 'two' },
      h('div', {},
        h('div', { class: 'card' }, h('h2', {}, '反馈内容'),
          f.messages.map((m) => h('div', { class: `msg ${m.kind}` }, h('div', { class: 'small muted' }, `${time(m.sent_at)} · ${m.kind === 'note' ? '备注' : m.channel === 'qq' ? 'QQ' : '网页'} · ${who(m.author)} `, m.kind === 'report' && h('button', { class: 'link', onclick: moveMsg(m) }, '移动/拆分')),
            m.text && h('div', { class: 'body' }, m.text), m.attachments.length > 0 && h('div', { class: 'atts' }, m.attachments.map(attachment)))),
          composer({ label: '追加', placeholder: '追加内容或备注…', noteToggle: true, onSend: async (fd, files) => { for (const x of files) fd.append('files', x); await api(`/feedbacks/${id}/messages`, { method: 'POST', form: fd }); toast('已追加'); render(); } })),
        h('div', { class: 'card' }, h('h2', {}, '处理结果'), res, h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { onclick: () => save({ resolution: res.value }) }, '保存'), f.status !== 'resolved' && h('button', { class: 'primary', onclick: () => save({ resolution: res.value, status: 'resolved' }, '已标为解决') }, '保存并标为已解决'))),
        h('div', { class: 'card' }, h('h2', {}, '同类问题'),
          f.topic && h('div', { style: 'margin-bottom:10px' }, h('a', { href: `#/topics/${f.topic.id}` }, f.topic.title), ' ', h('button', { class: 'link', onclick: () => save({ topic_id: null }, '已移出') }, '移出'), f.topic.solution && h('div', { class: 'body small', style: 'white-space:pre-wrap' }, '方案：' + f.topic.solution)),
          f.similar.length ? f.similar.map((s) => h('div', { class: 'sim' }, h('div', { class: 'row' }, h('a', { class: 'grow', href: `#/feedbacks/${s.id}` }, `#${s.id} ${s.title}`), h('span', { class: 'muted small' }, `相似 ${Math.round(s.score * 100)}%`), statusEl(s.status),
            !(f.topic_id && s.topic_id === f.topic_id) && h('button', { onclick: act(async () => { const g = await api(`/feedbacks/${id}/group`, { method: 'POST', body: { with: s.id } }); await loadMeta(); toast(`已归入「${g.title}」，共 ${g.count} 条`); render(); }) }, '归为同类')),
            (s.resolution || s.topic_solution) && h('div', { class: 'small muted' }, '办法：' + (s.resolution || s.topic_solution)))) : h('div', { class: 'muted' }, '没有找到相似的反馈'),
          h('div', { class: 'row', style: 'margin-top:10px' }, h('select', { 'aria-label': '归入已有问题', onchange: (e) => e.target.value && save({ topic_id: Number(e.target.value) }, '已归入') }, opts(meta.topics.filter((t) => t.id !== f.topic_id).map((t) => [String(t.id), `${t.title}（${t.count}）`]), '', '归入已有问题…')),
            h('button', { onclick: act(async () => { const t = prompt('新问题标题', f.title); if (!t) return; const r = await api('/topics', { method: 'POST', body: { title: t } }); await api(`/feedbacks/${id}`, { method: 'PATCH', body: { topic_id: r.id } }); await loadMeta(); toast('已新建'); render(); }) }, '新建问题')))),
      h('div', {},
        h('div', { class: 'card form' },
          field('title', '标题', text('title')), field('status', '状态', sel('status', Object.entries(meta.status))), field('severity', '优先级', sel('severity', Object.entries(meta.severity))), field('category', '分类', sel('category', cats, '（自动识别）')),
          field('product', '产品', text('product', 'dl-product')), field('version', '版本', text('version')), field('reporter', '反馈人 / 客户', text('reporter', 'dl-reporter')), field('source', '来源', text('source')),
          field('tags', '标签（逗号分隔）', h('input', { value: f.tags.join('，'), onchange: (e) => save({ tags: e.target.value.split(/[,，、\s]+/).filter(Boolean) }) })),
          h('datalist', { id: 'dl-product' }, meta.products.map((p) => h('option', { value: p.name }))), h('datalist', { id: 'dl-reporter' }, meta.reporters.map((v) => h('option', { value: v }))),
          h('div', { class: 'small muted' }, `创建 ${time(f.created_at)}`, f.resolved_at && ` · 解决 ${time(f.resolved_at)}`)),
        h('div', { class: 'card' }, h('details', {}, h('summary', {}, `操作记录（${f.events.length}）`), f.events.map((e) => h('div', { class: 'small', style: 'margin-top:6px;overflow-wrap:anywhere' }, h('span', { class: 'muted' }, `${time(e.at)} ${who(e.actor)} `), `${e.action} ${e.detail}`)))))));
}
function addDialog() {
  const inp = (n, label, list) => h('label', {}, h('span', {}, label), h('input', { name: n, list }));
  const form = h('form', { class: 'form', onsubmit: (e) => e.preventDefault() }, h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0 12px' }, inp('reporter', '反馈人 / 客户', 'ad-rep'), inp('product', '产品', 'ad-prod'), h('label', {}, h('span', {}, '优先级'), h('select', { name: 'severity' }, opts(Object.entries(meta.severity), 'normal')))),
    h('datalist', { id: 'ad-rep' }, meta.reporters.map((v) => h('option', { value: v }))), h('datalist', { id: 'ad-prod' }, meta.products.map((p) => h('option', { value: p.name }))));
  const d = h('dialog', { onclose: () => d.remove() }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, '新增反馈'), h('button', { class: 'link', onclick: () => d.close() }, '关闭')), form,
    composer({ label: '保存', placeholder: '粘贴微信里的文字或截图…', onSend: async (fd, files) => { for (const [k, v] of new FormData(form)) if (v) fd.set(k, v); for (const x of files) fd.append('files', x); const r = await api('/feedbacks', { method: 'POST', form: fd }); d.close(); await loadMeta(); toast(`已记录 #${r.id}`); location.hash = `#/feedbacks/${r.id}`; } }));
  document.body.append(d); d.showModal();
}

// ───────── 同类问题 ─────────
async function topicsPage(q) {
  const list = await api('/topics?' + qs(q));
  return h('div', {}, h('div', { class: 'row filters' }, h('form', { class: 'row grow', onsubmit: (e) => { e.preventDefault(); location.hash = '#/topics?' + qs({ q: e.target.q.value }); } }, h('input', { type: 'search', name: 'q', value: q.q ?? '', placeholder: '搜索问题、原因、方案…', 'aria-label': '搜索' })),
    h('button', { onclick: act(async () => { const t = prompt('问题标题'); if (!t) return; const r = await api('/topics', { method: 'POST', body: { title: t } }); await loadMeta(); location.hash = `#/topics/${r.id}`; }) }, '新建问题')),
    list.length === 0 ? h('div', { class: 'card empty' }, '还没有同类问题。在反馈详情里点「归为同类」，或在 QQ 里回复「同类 编号」。')
      : h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '问题'), h('th', { class: 'num' }, '反馈数'), h('th', { class: 'num' }, '未完结'), h('th', { class: 'num' }, '客户数'), h('th', {}, '首次'), h('th', {}, '最近'), h('th', {}, '状态'))),
        h('tbody', {}, list.map((t) => h('tr', { class: 'click', onclick: () => { location.hash = `#/topics/${t.id}`; } }, h('td', {}, h('a', { class: 't', href: `#/topics/${t.id}` }, t.title), t.solution && h('div', { class: 'small muted' }, '方案：' + t.solution.slice(0, 80))), h('td', { class: 'num' }, t.count), h('td', { class: 'num' }, t.todo ?? 0), h('td', { class: 'num' }, t.reporters), h('td', { class: 'nowrap muted' }, time(t.first_at).slice(0, 10)), h('td', { class: 'nowrap muted' }, time(t.last_at).slice(0, 10)), h('td', {}, statusEl(t.status))))))));
}
async function topicPage(id) {
  const t = await api(`/topics/${id}`);
  const area = (k, label, ph) => { const el = h('textarea', { placeholder: ph }); el.value = t[k]; return [k, el, h('label', {}, h('span', {}, label), el)]; };
  const title = h('input', { value: t.title }); const fs = [area('root_cause', '原因分析', '根本原因、触发条件、影响版本…'), area('solution', '解决方案', '修复版本、临时办法、给客户的答复…')];
  const put = (extra = {}) => act(async () => { await api(`/topics/${id}`, { method: 'PATCH', body: { title: title.value, ...Object.fromEntries(fs.map(([k, el]) => [k, el.value])), ...extra } }); await loadMeta(); toast('已保存'); render(); });
  const todo = t.feedbacks.filter((f) => ['open', 'doing'].includes(f.status)).length;
  return h('div', {}, h('div', { class: 'row' }, h('a', { href: '#/topics' }, '← 同类问题'), h('span', { class: 'grow' }), h('a', { href: `/api/export/md?topic=${id}` }, '导出 Markdown'), h('a', { href: `/api/export/csv?topic=${id}` }, '导出 CSV'), h('button', { class: 'danger', onclick: act(async () => { if (!confirm('删除这个问题？其下的反馈不会删除。')) return; await api(`/topics/${id}`, { method: 'DELETE' }); await loadMeta(); location.hash = '#/topics'; }) }, '删除')),
    h('h1', { style: 'margin-top:8px' }, t.title, ' ', statusEl(t.status)),
    h('div', { class: 'card form' }, h('label', {}, h('span', {}, '标题'), title), fs.map((x) => x[2]), h('div', { class: 'row' }, h('button', { class: 'primary', onclick: put() }, '保存'),
      t.status === 'open' ? h('button', { onclick: put({ status: 'resolved', cascade: todo > 0 }) }, todo ? `标为已解决（含 ${todo} 条未完结反馈）` : '标为已解决') : h('button', { onclick: put({ status: 'open' }) }, '重新打开'))),
    h('div', { class: 'card' }, h('h2', {}, `相关反馈（${t.feedbacks.length}）`), t.feedbacks.map((f) => h('div', { class: 'sim row' }, h('a', { class: 'grow', href: `#/feedbacks/${f.id}` }, `#${f.id} ${f.title}`), h('span', { class: 'muted small' }, [f.reporter, f.version, time(f.created_at)].filter(Boolean).join(' · ')), statusEl(f.status))), t.feedbacks.length === 0 && h('div', { class: 'muted' }, '暂无')));
}

// ───────── 统计 ─────────
function bars(title, rows, { link, label = (r) => r.name, empty = '未填写' } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.count)), sum = rows.reduce((s, r) => s + r.count, 0);
  return h('div', { class: 'card' }, h('h2', {}, title), rows.length === 0 && h('div', { class: 'muted' }, '暂无数据'), rows.map((r) => {
    const n = label(r) || empty, tip = `${n}：${r.count} 条（${Math.round((r.count / sum) * 100)}%）${r.todo ? `，未完结 ${r.todo}` : ''}`;
    return h('a', { class: 'bar', href: link && r.name !== '' ? link(r) : undefined, tabindex: 0, 'aria-label': tip }, h('span', { class: 'n' }, n), h('span', { class: 'tr' }, h('i', { style: `width:${(r.count / max) * 82}%` }), h('span', { class: 'v' }, r.count)), h('span', { class: 'tip' }, tip));
  }));
}
async function statsPage(q) {
  const s = await api('/stats?' + qs(q)), to = (k) => (r) => '#/feedbacks?' + qs({ ...q, [k]: r.name });
  const days = s.avg_resolve_ms ? s.avg_resolve_ms / 86400000 : null;
  return h('div', {}, filterBar(q, 'stats'),
    h('div', { class: 'tiles' }, [['反馈总数', s.total], ['未完结', s.todo], ['已解决', s.resolved], ['平均解决用时', days === null ? '—' : days * 24 < 1 ? `${Math.max(1, Math.round(days * 1440))} 分钟` : days < 1 ? `${(days * 24).toFixed(1)} 小时` : `${days.toFixed(1)} 天`]].map(([k, v]) => h('div', { class: 'tile' }, h('span', { class: 'muted small' }, k), h('b', {}, v)))),
    h('div', { class: 'charts' }, bars('按分类', s.byCategory, { link: to('category') }), bars('每月反馈数', s.byMonth), bars('高频同类问题（全部）', s.topTopics.map((t) => ({ name: t.title, count: t.count, todo: t.todo, id: t.id })), { link: (r) => `#/topics/${r.id}` }), bars('按产品', s.byProduct, { link: to('product') }), bars('按版本', s.byVersion), bars('按状态', s.byStatus, { link: to('status'), label: (r) => meta.status[r.name] }), bars('按优先级', s.bySeverity, { link: to('severity'), label: (r) => meta.severity[r.name] }), bars('按反馈人', s.byReporter, { link: to('reporter') }), bars('按标签', s.byTag, { link: to('tag') })));
}

// ───────── 设置 ─────────
const BOT = { online: '在线', connecting: '连接中', offline: '离线，自动重连中', blocked: '无法连接', disabled: '未启用', stopped: '已停止' };
async function settingsPage() {
  const s = await api('/system');
  const codeBox = h('div', {});
  const tax = (kind, title, hint) => {
    const rows = kind === 'category' ? meta.categories : meta.products;
    const save = (o, msg) => act(async () => { await api(`/taxonomy/${kind}`, { method: 'POST', body: o() }); await loadMeta(); toast(msg); render(); });
    const line = (c) => { const n = h('input', { value: c?.name ?? '', placeholder: '名称', 'aria-label': '名称', style: 'width:140px' }), k = h('input', { value: c?.keywords ?? '', placeholder: '关键词，逗号分隔', 'aria-label': '关键词', class: 'grow' });
      return h('div', { class: 'row', style: 'margin-bottom:6px' }, n, k, h('button', { onclick: save(() => ({ id: c?.id, name: n.value, keywords: k.value }), '已保存，自动归类的反馈已重新识别') }, c ? '保存' : '添加'), c && h('button', { class: 'link danger', onclick: act(async () => { if (!confirm(`删除「${c.name}」？`)) return; await api(`/taxonomy/${kind}/${c.id}`, { method: 'DELETE' }); await loadMeta(); render(); }) }, '删除')); };
    return h('div', { class: 'card' }, h('h2', {}, title), h('div', { class: 'small muted', style: 'margin-bottom:10px' }, hint), rows.map(line), line(null));
  };
  return h('div', {},
    h('div', { class: 'card' }, h('h2', {}, '运行状态'), h('div', {}, '机器人：', h('b', {}, BOT[s.bot.state] ?? s.bot.state), s.bot.reason && `（${s.bot.reason}）`, s.bot.lastEventAt ? h('span', { class: 'muted' }, ` 最近事件 ${time(s.bot.lastEventAt)}`) : null), h('div', {}, '截图文字识别：', { ready: '正常', unavailable: '不可用', disabled: '已关闭' }[s.ocr]), h('div', {}, `附件：待下载 ${s.queue.downloading}，待识别 ${s.queue.recognizing}，失败 ${s.queue.failed}`), h('div', { class: 'small muted' }, `连续消息合并窗口 ${s.mergeWindowMinutes} 分钟 · 数据目录 ${s.dataDir} · 启动于 ${time(s.startedAt)}`)),
    h('div', { class: 'card' }, h('h2', {}, 'QQ 账号'), h('div', { class: 'small muted' }, '只有绑定过的 QQ 才能向机器人记录和查询反馈。'), s.users.map((u) => h('div', { class: 'row sim' }, h('span', { class: 'grow' }, u.nickname || 'QQ 用户', h('span', { class: 'muted small' }, ` ${u.openid.slice(0, 8)}… 绑定于 ${time(u.bound_at)}`)), h('button', { class: 'link danger', onclick: act(async () => { if (!confirm('解除绑定？')) return; await api(`/qq-users/${encodeURIComponent(u.openid)}`, { method: 'DELETE' }); await loadMeta(); render(); }) }, '解绑'))), codeBox,
      h('button', { style: 'margin-top:10px', onclick: act(async () => { const r = await api('/bind-code', { method: 'POST' }); codeBox.replaceChildren(h('div', { class: 'code' }, `绑定 ${r.code}`), h('div', { class: 'small muted' }, `在 QQ 里把上面这行发给机器人，${time(r.exp).slice(11)} 前有效，仅可用一次`)); }) }, '生成绑定码')),
    tax('product', '产品', '名称和关键词出现在反馈里时自动标注产品。'), tax('category', '分类', '按关键词自动归类；人工改过分类的反馈不受影响。'));
}

render();
