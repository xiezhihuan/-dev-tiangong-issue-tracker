import crypto from 'node:crypto';
import type { Db, Row } from './db.js';
import { classify, classifyProduct, clip, detectVersion, likeEscape, makeTitle, parseMeta, SimilarityIndex, splitTags, type TaxItem } from './text.js';

export const STATUS: Record<string, string> = { open: '待处理', doing: '处理中', resolved: '已解决', closed: '已关闭' };
export const SEVERITY: Record<string, string> = { urgent: '紧急', high: '高', normal: '普通', low: '低' };

/** 接受中文名或内部代码。 */
export function codeOf(map: Record<string, string>, input: string): string | undefined {
  const s = input.trim();
  return Object.keys(map).find((k) => k === s || map[k] === s);
}

export class UserError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface NewAttachment { kind: 'image' | 'voice' | 'video' | 'file'; filename?: string; mime?: string; size?: number; url?: string; text?: string; path?: string; sha256?: string }
export interface NewMessage { channel: 'qq' | 'web'; dedupeKey?: string; author: string; kind: 'report' | 'note'; text: string; raw?: unknown; sentAt: number; attachments: NewAttachment[] }
export interface Filter {
  q?: string; status?: string; category?: string; product?: string; severity?: string; topic?: string; reporter?: string; tag?: string; channel?: string;
  from?: number; to?: number; deleted?: boolean; sort?: string; page?: number; pageSize?: number;
}

/** 可人工编辑的字段 → 中文名。 */
const FIELDS: Record<string, string> = {
  title: '标题', status: '状态', severity: '优先级', category: '分类', product: '产品', version: '版本',
  reporter: '反馈人', source: '来源', resolution: '处理结果', topic_id: '同类问题', tags: '标签',
};
const AUTO_FIELDS = new Set(['title', 'category', 'product', 'version']);
const MAX_LEN: Record<string, number> = { title: 200, category: 50, product: 50, version: 50, reporter: 100, source: 50, resolution: 20_000 };

export class Store {
  private sim = new SimilarityIndex();
  constructor(readonly db: Db, readonly now: () => number = Date.now) {}

  // ───────── 写入 ─────────

  createFeedback(actor: string, at = this.now()): number {
    const { id } = this.db.run('INSERT INTO feedbacks(created_at,updated_at) VALUES(?,?)', at, this.now());
    this.event(id, actor, '创建');
    return id;
  }

  /** 追加一条素材（事务内提交；重复投递返回 null）。 */
  addMessage(feedbackId: number, m: NewMessage): number | null {
    return this.db.tx(() => {
      if (m.dedupeKey && this.db.get('SELECT 1 FROM messages WHERE dedupe_key=?', m.dedupeKey)) return null;
      const { id } = this.db.run(
        'INSERT INTO messages(feedback_id,channel,dedupe_key,author,kind,text,raw,sent_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        feedbackId, m.channel, m.dedupeKey ?? null, m.author, m.kind, m.text, m.raw === undefined ? null : JSON.stringify(m.raw), m.sentAt, this.now());
      for (const a of m.attachments) {
        this.db.run(
          `INSERT INTO attachments(message_id,kind,filename,mime,size,url,path,sha256,status,ocr_status,text,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, a.kind, clip(a.filename ?? '', 200), a.mime ?? '', a.size ?? 0, a.url ?? null, a.path ?? null, a.sha256 ?? null,
          a.path ? 'done' : a.url ? 'pending' : 'failed', a.kind === 'image' ? 'pending' : 'none', a.text ?? '', a.path || a.url ? null : '平台未提供下载地址');
      }
      // 「客户：张三」这类元信息行只填空白字段或自动字段，不覆盖人工修改
      if (m.kind === 'report') this.applyMeta(feedbackId, m.text);
      this.refresh(feedbackId);
      return id;
    });
  }

  /** 记录已处理的指令消息，用于去重（重连补发时不会重复执行）。 */
  markCommand(dedupeKey: string, author: string, text: string, sentAt: number): boolean {
    const r = this.db.run(`INSERT OR IGNORE INTO messages(channel,dedupe_key,author,kind,text,sent_at,created_at) VALUES('qq',?,?,'command',?,?,?)`, dedupeKey, author, text, sentAt, this.now());
    return r.changes > 0;
  }
  seen(dedupeKey: string): boolean { return !!this.db.get('SELECT 1 FROM messages WHERE dedupe_key=?', dedupeKey); }

  private applyMeta(id: number, text: string): void {
    const meta = parseMeta(text);
    const f = this.require(id);
    const set = (col: string, v: string | undefined, autoCol?: string) => {
      if (v && (autoCol ? f[autoCol] : !f[col])) this.db.run(`UPDATE feedbacks SET ${col}=?${autoCol ? `, ${autoCol}=0` : ''} WHERE id=?`, v, id);
    };
    set('title', meta.title, 'title_auto');
    set('product', meta.product, 'product_auto');
    set('version', meta.version, 'version_auto');
    set('reporter', meta.reporter);
    if (meta.category) set('category', this.matchCategory(meta.category), 'category_auto');
    if (meta.source && f.source === '微信') this.db.run('UPDATE feedbacks SET source=? WHERE id=?', meta.source, id);
    const sev = meta.severity && codeOf(SEVERITY, meta.severity);
    if (sev && f.severity === 'normal') this.db.run('UPDATE feedbacks SET severity=? WHERE id=?', sev, id);
    for (const t of meta.tags ?? []) this.db.run('INSERT OR IGNORE INTO feedback_tags(feedback_id,tag) VALUES(?,?)', id, t);
  }

  /** 「打印」→ 精确名优先，其次唯一包含匹配，否则原样。 */
  matchCategory(input: string): string {
    const s = input.trim();
    const names = this.taxonomy('category').map((c) => c.name);
    if (names.includes(s)) return s;
    const part = names.filter((n) => n.includes(s));
    return part.length === 1 ? part[0]! : s;
  }

  /** 内容变化后重算自动字段与检索文本。 */
  refresh(id: number): void {
    const f = this.require(id);
    const msgs = this.db.all(`SELECT id,kind,text FROM messages WHERE feedback_id=? AND kind<>'command' ORDER BY id`, id);
    const atts = this.db.all('SELECT a.kind,a.text,a.filename FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.feedback_id=? ORDER BY a.id', id);
    const reports = msgs.filter((m) => m.kind === 'report').map((m) => String(m.text));
    const recognized = atts.map((a) => String(a.text)).filter(Boolean);
    const body = [...reports, ...recognized].join('\n');
    if (f.title_auto) f.title = makeTitle(reports, recognized, atts.map((a) => a.kind));
    if (f.category_auto) f.category = classify(body, this.taxonomy('category')) || '其他';
    if (f.product_auto) f.product = classifyProduct(body, this.taxonomy('product'));
    if (f.version_auto) f.version = detectVersion(body);
    const tags = this.tags(id);
    const search = [f.title, ...msgs.map((m) => m.text), ...recognized, ...atts.map((a) => a.filename), f.reporter, f.product, f.version, f.category, f.resolution, tags.join(' ')].join('\n').toLowerCase();
    this.db.run('UPDATE feedbacks SET title=?,category=?,product=?,version=?,search_text=?,updated_at=? WHERE id=?', f.title, f.category, f.product, f.version, search, this.now(), id);
  }

  update(id: number, patch: Row, actor: string): void {
    this.db.tx(() => {
      const f = this.require(id);
      for (const [k, raw] of Object.entries(patch)) {
        if (!(k in FIELDS)) throw new UserError(`不支持的字段：${k}`);
        if (k === 'tags') {
          if (!Array.isArray(raw)) throw new UserError('标签格式错误');
          const next = splitTags(raw.join(','));
          const before = this.tags(id);
          if (next.join() === before.join()) continue;
          this.db.run('DELETE FROM feedback_tags WHERE feedback_id=?', id);
          for (const t of next) this.db.run('INSERT INTO feedback_tags(feedback_id,tag) VALUES(?,?)', id, t);
          this.event(id, actor, '修改标签', `${before.join('、') || '空'} → ${next.join('、') || '空'}`);
          continue;
        }
        let v: string | number | null;
        if (k === 'topic_id') {
          v = raw === null || raw === '' ? null : Number(raw);
          if (v !== null && !this.db.get('SELECT 1 FROM topics WHERE id=?', v)) throw new UserError('同类问题不存在', 404);
        } else {
          if (typeof raw !== 'string') throw new UserError(`${FIELDS[k]}格式错误`);
          v = raw.trim();
          if (k === 'status' && !STATUS[v]) throw new UserError('状态无效');
          if (k === 'severity' && !SEVERITY[v]) throw new UserError('优先级无效');
          if (v.length > (MAX_LEN[k] ?? 100)) throw new UserError(`${FIELDS[k]}过长`);
        }
        // 清空自动字段 = 恢复自动识别
        if (AUTO_FIELDS.has(k)) this.db.run(`UPDATE feedbacks SET ${k}_auto=? WHERE id=?`, v === '' ? 1 : 0, id);
        if (f[k] === v) continue;
        this.db.run(`UPDATE feedbacks SET ${k}=? WHERE id=?`, v, id);
        if (k === 'status') this.db.run('UPDATE feedbacks SET resolved_at=? WHERE id=?', v === 'resolved' ? this.now() : null, id);
        this.event(id, actor, `修改${FIELDS[k]}`, `${this.show(k, f[k])} → ${this.show(k, v)}`);
      }
      this.refresh(id);
    });
  }
  private show(k: string, v: any): string {
    if (v === null || v === '') return '空';
    if (k === 'status') return STATUS[v] ?? v;
    if (k === 'severity') return SEVERITY[v] ?? v;
    if (k === 'topic_id') return `问题${v}`;
    return clip(String(v), 60);
  }

  /** 把素材移到另一条反馈；target 为 null 时新建一条。返回目标编号。 */
  moveMessage(messageId: number, target: number | null, actor: string): number {
    return this.db.tx(() => {
      const m = this.db.get('SELECT * FROM messages WHERE id=?', messageId);
      if (!m?.feedback_id) throw new UserError('素材不存在', 404);
      if (target === m.feedback_id) throw new UserError('已在该反馈中');
      if (target !== null && this.require(target).deleted_at) throw new UserError('目标反馈已删除');
      const left = this.db.get(`SELECT COUNT(*) n FROM messages WHERE feedback_id=? AND id<>?`, m.feedback_id, messageId)!.n;
      if (target === null && left === 0) throw new UserError('该反馈只有这一条素材，无需拆分');
      const to = target ?? this.createFeedback(actor, m.sent_at);
      this.db.run('UPDATE messages SET feedback_id=? WHERE id=?', to, messageId);
      const ref = this.refOf(m);
      if (ref) this.db.run('UPDATE qq_refs SET feedback_id=? WHERE ref=?', to, ref);
      this.event(m.feedback_id, actor, '移出素材', `→ #${to}`);
      this.event(to, actor, '移入素材', `← #${m.feedback_id}`);
      if (left === 0) this.remove(m.feedback_id, actor);
      this.refresh(m.feedback_id);
      this.refresh(to);
      return to;
    });
  }
  /** 两条其实是同一条反馈：把 from 的素材全部并入 to，并删除 from。 */
  merge(from: number, to: number, actor: string): void {
    if (from === to) throw new UserError('不能并入自己');
    this.db.tx(() => {
      const a = this.require(from), b = this.require(to);
      if (a.deleted_at || b.deleted_at) throw new UserError('反馈已删除');
      this.db.run('UPDATE messages SET feedback_id=? WHERE feedback_id=?', to, from);
      this.db.run('UPDATE qq_refs SET feedback_id=? WHERE feedback_id=?', to, from);
      this.db.run('INSERT OR IGNORE INTO feedback_tags(feedback_id,tag) SELECT ?,tag FROM feedback_tags WHERE feedback_id=?', to, from);
      for (const k of ['reporter', 'resolution']) if (!b[k] && a[k]) this.db.run(`UPDATE feedbacks SET ${k}=? WHERE id=?`, a[k], to);
      this.event(to, actor, '并入', `← #${from}`);
      this.event(from, actor, '并入', `→ #${to}`);
      this.remove(from, actor);
      this.refresh(from);
      this.refresh(to);
    });
  }
  /** 撤销某人最近发到该反馈的一条素材（脱离反馈但保留原始记录）。反馈因此变空则一并删除。 */
  undoLast(feedbackId: number, author: string): { text: string; removed: boolean } | null {
    return this.db.tx(() => {
      const m = this.db.get(`SELECT id,text FROM messages WHERE feedback_id=? AND author=? AND channel='qq' AND kind<>'command' ORDER BY id DESC LIMIT 1`, feedbackId, author);
      if (!m) return null;
      this.db.run('UPDATE messages SET feedback_id=NULL WHERE id=?', m.id);
      this.event(feedbackId, author, '撤销素材', clip(m.text, 60));
      const removed = !this.db.get('SELECT 1 FROM messages WHERE feedback_id=?', feedbackId);
      if (removed) this.remove(feedbackId, author);
      this.refresh(feedbackId);
      return { text: m.text, removed };
    });
  }
  lastMessageId(feedbackId: number, author: string): number | undefined {
    return this.db.get(`SELECT id FROM messages WHERE feedback_id=? AND author=? AND kind='report' ORDER BY id DESC LIMIT 1`, feedbackId, author)?.id;
  }

  private refOf(m: Row): string | undefined {
    try { return (JSON.parse(m.raw ?? 'null')?.message_scene?.ext as string[] | undefined)?.find((e) => e.startsWith('msg_idx='))?.slice(8); } catch { return undefined; }
  }

  remove(id: number, actor: string): void {
    this.require(id);
    this.db.run('UPDATE feedbacks SET deleted_at=? WHERE id=?', this.now(), id);
    this.event(id, actor, '删除');
  }
  restore(id: number, actor: string): void {
    this.require(id);
    this.db.run('UPDATE feedbacks SET deleted_at=NULL WHERE id=?', id);
    this.event(id, actor, '恢复');
  }

  event(id: number, actor: string, action: string, detail = ''): void {
    this.db.run('INSERT INTO events(feedback_id,at,actor,action,detail) VALUES(?,?,?,?,?)', id, this.now(), actor, action, detail);
  }

  /** 一次性绑定码，10 分钟有效。 */
  createBindCode(): { code: string; exp: number } {
    const v = { code: String(crypto.randomInt(10_000_000, 100_000_000)), exp: this.now() + 10 * 60_000 };
    this.db.kvSet('bind_code', JSON.stringify(v));
    return v;
  }

  // ───────── 读取 ─────────

  require(id: number): Row {
    const f = Number.isSafeInteger(id) ? this.db.get('SELECT * FROM feedbacks WHERE id=?', id) : undefined;
    if (!f) throw new UserError(`反馈 #${id} 不存在`, 404);
    return f;
  }
  tags(id: number): string[] { return this.db.all('SELECT tag FROM feedback_tags WHERE feedback_id=? ORDER BY rowid', id).map((r) => r.tag); }
  taxonomy(kind: 'category' | 'product'): (TaxItem & { id: number; sort: number })[] {
    return this.db.all('SELECT id,name,keywords,sort FROM taxonomy WHERE kind=? ORDER BY sort,id', kind) as any;
  }

  private where(f: Filter): { sql: string; args: (string | number)[] } {
    const c: string[] = [f.deleted ? 'f.deleted_at IS NOT NULL' : 'f.deleted_at IS NULL'];
    const a: (string | number)[] = [];
    const num = /^#?(\d+)$/.exec(f.q?.trim() ?? '');
    for (const term of (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
      if (num) { c.push(`(f.id=? OR f.search_text LIKE ? ESCAPE '\\')`); a.push(Number(num[1]), `%${likeEscape(num[1]!)}%`); }
      else { c.push(`f.search_text LIKE ? ESCAPE '\\'`); a.push(`%${likeEscape(term)}%`); }
    }
    if (f.status === 'todo') c.push(`f.status IN ('open','doing')`);
    else if (f.status) { c.push('f.status=?'); a.push(f.status); }
    for (const k of ['category', 'product', 'severity', 'reporter'] as const) if (f[k]) { c.push(`f.${k}=?`); a.push(f[k]!); }
    if (f.topic === 'none') c.push('f.topic_id IS NULL');
    else if (f.topic) { c.push('f.topic_id=?'); a.push(Number(f.topic)); }
    if (f.tag) { c.push('EXISTS (SELECT 1 FROM feedback_tags t WHERE t.feedback_id=f.id AND t.tag=?)'); a.push(f.tag); }
    if (f.channel) { c.push(`(SELECT m.channel FROM messages m WHERE m.feedback_id=f.id AND m.kind<>'command' ORDER BY m.sent_at,m.id LIMIT 1)=?`); a.push(f.channel); }
    if (f.from) { c.push('f.created_at>=?'); a.push(f.from); }
    if (f.to) { c.push('f.created_at<?'); a.push(f.to); }
    return { sql: c.join(' AND '), args: a };
  }

  list(f: Filter): { total: number; items: Row[] } {
    const w = this.where(f);
    const size = Math.min(Math.max(f.pageSize ?? 30, 1), 100_000);
    const order = f.sort === 'old' ? 'f.created_at ASC, f.id ASC' : f.sort === 'updated' ? 'f.updated_at DESC, f.id DESC' : 'f.created_at DESC, f.id DESC';
    const total = Number(this.db.get(`SELECT COUNT(*) n FROM feedbacks f WHERE ${w.sql}`, ...w.args)!.n);
    const items = this.db.all(
      `SELECT f.id,f.title,f.status,f.severity,f.category,f.product,f.version,f.reporter,f.source,f.resolution,f.topic_id,f.created_at,f.updated_at,f.resolved_at,
        (SELECT title FROM topics t WHERE t.id=f.topic_id) topic_title,
        (SELECT COUNT(*) FROM messages m WHERE m.feedback_id=f.id) message_count,
        (SELECT COUNT(*) FROM attachments x JOIN messages m ON m.id=x.message_id WHERE m.feedback_id=f.id) attachment_count,
        (SELECT m.channel FROM messages m WHERE m.feedback_id=f.id ORDER BY m.sent_at,m.id LIMIT 1) channel,
        (SELECT m.author FROM messages m WHERE m.feedback_id=f.id ORDER BY m.sent_at,m.id LIMIT 1) author,
        COALESCE((SELECT substr(m.text,1,300) FROM messages m WHERE m.feedback_id=f.id AND m.kind='report' AND m.text<>'' ORDER BY m.sent_at,m.id LIMIT 1),'') excerpt,
        (SELECT x.id FROM attachments x JOIN messages m ON m.id=x.message_id WHERE m.feedback_id=f.id AND x.status='done' AND x.mime LIKE 'image/%' ORDER BY x.id LIMIT 1) thumb,
        (SELECT group_concat(tag,',') FROM feedback_tags t WHERE t.feedback_id=f.id) tags
       FROM feedbacks f WHERE ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...w.args, size, (Math.max(f.page ?? 1, 1) - 1) * size);
    for (const i of items) i.tags = i.tags ? i.tags.split(',') : [];
    return { total, items };
  }

  detail(id: number): Row {
    const f = this.require(id);
    delete f.search_text;
    f.tags = this.tags(id);
    f.topic = f.topic_id ? this.db.get('SELECT id,title,status,root_cause,solution FROM topics WHERE id=?', f.topic_id) : null;
    f.messages = this.db.all(`SELECT id,channel,author,kind,text,sent_at FROM messages WHERE feedback_id=? ORDER BY sent_at,id`, id);
    const atts = this.db.all('SELECT a.id,a.message_id,a.kind,a.filename,a.mime,a.size,a.status,a.error,a.ocr_status,a.text FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.feedback_id=? ORDER BY a.id', id);
    for (const m of f.messages) m.attachments = atts.filter((a) => a.message_id === m.id);
    f.events = this.db.all('SELECT at,actor,action,detail FROM events WHERE feedback_id=? ORDER BY id DESC LIMIT 200', id);
    return f;
  }

  similar(id: number, limit = 5): Row[] {
    const docs = this.corpus(id), self = docs.find((d) => d.id === id);
    return self ? this.rank(self, docs, limit) : [];
  }
  /** 与任意一段文字相似的反馈。 */
  similarText(text: string, limit = 5): Row[] { return this.rank({ id: -1, text }, this.corpus(-1), limit); }
  private corpus(id: number): { id: number; text: string }[] {
    return this.db.all(`SELECT f.id, f.title||char(10)||COALESCE((SELECT group_concat(m.text,char(10)) FROM messages m WHERE m.feedback_id=f.id AND m.kind='report'),'')
        ||char(10)||COALESCE((SELECT group_concat(a.text,char(10)) FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.feedback_id=f.id),'') text
      FROM feedbacks f WHERE f.deleted_at IS NULL OR f.id=?`, id) as { id: number; text: string }[];
  }
  private rank(self: { id: number; text: string }, docs: { id: number; text: string }[], limit: number): Row[] {
    return this.sim.query(self, docs, limit).map((h) => ({
      ...this.db.get('SELECT f.id,f.title,f.status,f.category,f.resolution,f.topic_id,f.created_at,t.title topic_title,t.solution topic_solution FROM feedbacks f LEFT JOIN topics t ON t.id=f.topic_id WHERE f.id=?', h.id)!,
      score: Math.round(h.score * 100) / 100,
    }));
  }

  // ───────── 同类问题 ─────────

  createTopic(title: string): number {
    const t = title.trim();
    if (!t) throw new UserError('标题不能为空');
    return this.db.run('INSERT INTO topics(title,created_at,updated_at) VALUES(?,?,?)', clip(t, 200), this.now(), this.now()).id;
  }
  topics(q = ''): Row[] {
    return this.db.all(
      `SELECT t.*, COUNT(f.id) count, SUM(f.status IN ('open','doing')) todo, COUNT(DISTINCT NULLIF(f.reporter,'')) reporters, MIN(f.created_at) first_at, MAX(f.created_at) last_at, group_concat(DISTINCT NULLIF(f.category,'')) categories
       FROM topics t LEFT JOIN feedbacks f ON f.topic_id=t.id AND f.deleted_at IS NULL
       WHERE (t.title||char(10)||t.root_cause||char(10)||t.solution) LIKE ? ESCAPE '\\' GROUP BY t.id ORDER BY count DESC, last_at DESC`, `%${likeEscape(q.trim())}%`);
  }
  topic(id: number): Row {
    const t = this.db.get('SELECT * FROM topics WHERE id=?', id);
    if (!t) throw new UserError('同类问题不存在', 404);
    t.feedbacks = this.list({ topic: String(id), pageSize: 1000 }).items;
    return t;
  }
  /** @param cascade 同时把其下未关闭的反馈标为已解决 */
  updateTopic(id: number, patch: Row, actor: string, cascade = false): void {
    this.db.tx(() => {
      const t = this.topic(id);
      for (const k of ['title', 'root_cause', 'solution', 'status']) {
        const v = patch[k];
        if (v === undefined) continue;
        if (typeof v !== 'string' || v.length > 20_000) throw new UserError('字段格式错误');
        if (k === 'title' && !v.trim()) throw new UserError('标题不能为空');
        if (k === 'status' && !['open', 'resolved'].includes(v)) throw new UserError('状态无效');
        this.db.run(`UPDATE topics SET ${k}=?, updated_at=? WHERE id=?`, v.trim(), this.now(), id);
      }
      if (cascade) for (const f of t.feedbacks) if (f.status === 'open' || f.status === 'doing') this.update(f.id, { status: 'resolved' }, actor);
    });
  }
  deleteTopic(id: number): void { this.topic(id); this.db.run('DELETE FROM topics WHERE id=?', id); }

  /** 把反馈 a 与 b 归为同类：沿用已有问题组，都没有则以 b 的标题新建。两边各有问题组时，a 移入 b 的组。 */
  group(a: number, b: number, actor: string): { topicId: number; title: string; count: number } {
    if (a === b) throw new UserError('不能和自己归并');
    return this.db.tx(() => {
      const fa = this.require(a), fb = this.require(b);
      if (fa.deleted_at || fb.deleted_at) throw new UserError('反馈已删除');
      const topicId = fb.topic_id ?? fa.topic_id ?? this.createTopic(fb.title);
      this.update(a, { topic_id: topicId }, actor);
      this.update(b, { topic_id: topicId }, actor);
      return { topicId, title: this.db.get('SELECT title FROM topics WHERE id=?', topicId)!.title, count: Number(this.db.get('SELECT COUNT(*) n FROM feedbacks WHERE topic_id=? AND deleted_at IS NULL', topicId)!.n) };
    });
  }

  // ───────── 分类维护 ─────────

  saveTaxonomy(kind: 'category' | 'product', item: { id?: number; name: string; keywords: string; sort?: number }): void {
    const name = item.name.trim();
    if (!name || name.length > 50) throw new UserError('名称不能为空且不超过 50 字');
    const kw = [...new Set(item.keywords.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean))].join(',');
    const dup = this.db.get('SELECT id FROM taxonomy WHERE kind=? AND name=? AND id<>?', kind, name, item.id ?? 0);
    if (dup) throw new UserError('名称已存在');
    this.db.tx(() => {
      if (item.id) {
        const old = this.db.get('SELECT name FROM taxonomy WHERE id=? AND kind=?', item.id, kind);
        if (!old) throw new UserError('不存在', 404);
        this.db.run('UPDATE taxonomy SET name=?,keywords=?,sort=COALESCE(?,sort) WHERE id=?', name, kw, item.sort ?? null, item.id);
        if (old.name !== name) this.db.run(`UPDATE feedbacks SET ${kind}=? WHERE ${kind}=?`, name, old.name);
      } else {
        this.db.run('INSERT INTO taxonomy(kind,name,keywords,sort) VALUES(?,?,?,COALESCE(?,(SELECT COALESCE(MAX(sort),0)+1 FROM taxonomy WHERE kind=?)))', kind, name, kw, item.sort ?? null, kind);
      }
      this.reclassify();
    });
  }
  deleteTaxonomy(kind: 'category' | 'product', id: number): void {
    this.db.tx(() => { this.db.run('DELETE FROM taxonomy WHERE id=? AND kind=?', id, kind); this.reclassify(); });
  }
  /** 关键词变化后，对「自动」的反馈重新识别；人工改过的不动，updated_at 保持。 */
  reclassify(): number {
    const rows = this.db.all('SELECT id,updated_at FROM feedbacks WHERE category_auto=1 OR product_auto=1');
    for (const r of rows) { this.refresh(r.id); this.db.run('UPDATE feedbacks SET updated_at=? WHERE id=?', r.updated_at, r.id); }
    return rows.length;
  }

  // ───────── 统计 ─────────

  /** 界面侧栏和概览卡片用的数字；不受筛选影响。 */
  summary(): Row {
    const d = new Date(this.now()), ago = (n: number): number => new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
    const row = this.db.get(`SELECT COALESCE(SUM(status='open'),0) open, COALESCE(SUM(status='doing'),0) doing, COALESCE(SUM(status='resolved'),0) resolved, COUNT(*) total,
      COALESCE(SUM(severity='urgent' AND status IN ('open','doing')),0) urgent, COALESCE(SUM(topic_id IS NULL),0) ungrouped,
      COALESCE(SUM(created_at>=?),0) today, COALESCE(SUM(created_at>=?),0) week, COALESCE(SUM(created_at>=? AND created_at<?),0) prevWeek FROM feedbacks WHERE deleted_at IS NULL`, ago(0), ago(6), ago(13), ago(6))!;
    const rows = this.db.all(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') name, COUNT(*) count FROM feedbacks WHERE deleted_at IS NULL AND created_at>=? GROUP BY 1`, ago(13));
    const days = Array.from({ length: 14 }, (_, i) => { const x = new Date(ago(13 - i)), name = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; return { name, count: rows.find((r) => r.name === name)?.count ?? 0 }; });
    return { ...row, days, trash: this.db.get('SELECT COUNT(*) n FROM feedbacks WHERE deleted_at IS NOT NULL')!.n };
  }
  stats(f: Filter): Row {
    const w = this.where(f);
    const group = (col: string) => this.db.all(`SELECT ${col} name, COUNT(*) count, SUM(f.status IN ('open','doing')) todo FROM feedbacks f WHERE ${w.sql} GROUP BY ${col} ORDER BY count DESC`, ...w.args);
    const t = this.db.get(`SELECT COUNT(*) total, COALESCE(SUM(f.status IN ('open','doing')),0) todo, COALESCE(SUM(f.status='resolved'),0) resolved, AVG(CASE WHEN f.resolved_at IS NOT NULL THEN f.resolved_at-f.created_at END) avg_resolve_ms FROM feedbacks f WHERE ${w.sql}`, ...w.args)!;
    return {
      ...t,
      byCategory: group('f.category'), byProduct: group('f.product'), byStatus: group('f.status'), bySeverity: group('f.severity'), byVersion: group('f.version').filter((r) => r.name).slice(0, 15),
      byReporter: group('f.reporter').filter((r) => r.name).slice(0, 15),
      byTag: this.db.all(`SELECT t.tag name, COUNT(*) count FROM feedback_tags t JOIN feedbacks f ON f.id=t.feedback_id WHERE ${w.sql} GROUP BY t.tag ORDER BY count DESC LIMIT 20`, ...w.args),
      byMonth: this.db.all(`SELECT strftime('%Y-%m', f.created_at/1000, 'unixepoch', 'localtime') name, COUNT(*) count FROM feedbacks f WHERE ${w.sql} GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, ...w.args).reverse(),
      topTopics: this.topics().filter((x) => x.count > 0).slice(0, 10),
    };
  }
}
