import { fmtTime } from './exports.js';
import type { Incoming } from './qq/message.js';
import { codeOf, SEVERITY, STATUS, UserError, type Store } from './store.js';
import { clip, splitTags } from './text.js';

export interface Outcome {
  /** 立即回复的文本 */
  reply?: string;
  /** 需要（防抖后）发送收录回执的反馈编号 */
  receipt?: number;
  /** 本条消息归属的反馈，用于引用识别 */
  feedbackId?: number;
}

interface Cursor { id: number; at: number; closed: boolean }

export const HELP = `📒 反馈收集助手
直接把文字、截图、语音、文件发给我就会记录。连续发送的内容自动并成一条。

【记录】
新建 — 另起一条
完成 — 结束当前这条
撤销 — 撤回上一条素材
拆分 — 把上一条素材拆成新反馈
/补充 12 内容 — 追加到 #12
（引用任意一条消息再发，也会追加到那条反馈）

【补充信息】默认改当前这条，改别的加 #编号，如 /客户 #12 张三
/客户  /产品  /版本  /分类  /优先级  /标签  /标题  /备注  /状态
/解决 处理办法 — 标为已解决并记下办法

【查阅】
/查 关键词　/详情 12　/相似 12
待处理　统计

【归类】
/同类 7 — 与 #7 归为同类问题
/并入 7 — 与 #7 是同一条，合并过去`;

const FIELD_CMDS: Record<string, string> = { 客户: 'reporter', 反馈人: 'reporter', 产品: 'product', 版本: 'version', 分类: 'category', 优先级: 'severity', 标签: 'tags', 标题: 'title', 状态: 'status', 来源: 'source' };
const ALIASES: Record<string, string> = { help: '帮助', '?': '帮助', '？': '帮助', 归并: '同类', 合并: '并入', 搜索: '查', 查询: '查', 查找: '查', 新: '新建', new: '新建', done: '完成', 结束: '完成', 撤回: '撤销', undo: '撤销' };
const COMMANDS = ['帮助', '新建', '完成', '撤销', '拆分', '补充', '备注', '解决', '查', '详情', '相似', '待处理', '统计', '同类', '并入', '绑定', ...Object.keys(FIELD_CMDS), ...Object.keys(ALIASES)];
const SLASH = new RegExp(`^[/／]\\s*(${COMMANDS.map((c) => c.replace(/[?]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')})(?=$|[\\s#\\d:：])[\\s:：]*([\\s\\S]*)$`, 'i');
const READ_ONLY = new Set(['帮助', '绑定', '撤销', '拆分', '查', '详情', '相似', '待处理', '统计', '同类', '并入']);
/** 不带斜杠也认的只有整句完全匹配的几种，避免把反馈正文误当指令。 */
const BARE = /^(新建|完成|撤销|拆分|帮助|待处理|统计)$/;
const BARE_ID = /^(同类|归并|并入|详情|相似)\s*#?(\d{1,9})$/;

export function parseCommand(text: string): { name: string; arg: string } | null {
  const t = text.trim();
  const b = BARE.exec(t);
  if (b) return { name: b[1]!, arg: '' };
  const i = BARE_ID.exec(t);
  if (i) return { name: ALIASES[i[1]!] ?? i[1]!, arg: i[2]! };
  const s = SLASH.exec(t);
  if (!s) return null;
  const name = s[1]!.toLowerCase();
  return { name: ALIASES[name] ?? name, arg: s[2]!.trim() };
}

/** 收录核心：把一条 QQ 消息变成「新反馈 / 追加 / 指令」。全程同步，返回前已落库。 */
export class Intake {
  private bindFails = new Map<string, number[]>();
  constructor(private store: Store, private o: { mergeWindowMs: number; now?: () => number }) {}

  private get db() { return this.store.db; }
  private now() { return (this.o.now ?? Date.now)(); }
  private cursor(openid: string): Cursor | null {
    const c = JSON.parse(this.db.kvGet(`cur:${openid}`) ?? 'null') as Cursor | null;
    if (!c) return null;
    const f = this.db.get('SELECT deleted_at FROM feedbacks WHERE id=?', c.id);
    return f && !f.deleted_at ? c : null;
  }
  private setCursor(openid: string, c: Cursor | null): void { c ? this.db.kvSet(`cur:${openid}`, JSON.stringify(c)) : this.db.kvDel(`cur:${openid}`); }
  private addRef(ref: string, id: number): void {
    if (ref) this.db.run('INSERT INTO qq_refs(ref,feedback_id,created_at) VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET feedback_id=excluded.feedback_id', ref, id, this.now());
  }
  /** 机器人回执的 ref_idx，供用户引用回执来补充。 */
  rememberRef(ref: string, id: number): void { this.addRef(ref, id); }
  isBound(openid: string): boolean { return !!this.db.get('SELECT 1 FROM qq_users WHERE openid=?', openid); }

  handle(m: Incoming): Outcome {
    if (!this.isBound(m.openid)) return this.bind(m);
    return this.db.tx(() => {
      if (this.store.seen(m.dedupeKey)) return {};
      if (m.nickname) this.db.run('UPDATE qq_users SET nickname=? WHERE openid=?', m.nickname, m.openid);
      const quotedId = m.refIdx ? this.refTarget(m.refIdx) : undefined;
      const cmd = parseCommand(m.text);
      if (cmd) {
        const out = this.command(m, cmd.name, cmd.arg, quotedId);
        if (out) {
          this.store.markCommand(m.dedupeKey, m.openid, m.text, m.sentAt);
          if (out.feedbackId && m.msgIdx) this.addRef(m.msgIdx, out.feedbackId);
          return out;
        }
      }
      return this.record(m, quotedId);
    });
  }

  private refTarget(ref: string): number | undefined {
    const r = this.db.get('SELECT r.feedback_id id FROM qq_refs r JOIN feedbacks f ON f.id=r.feedback_id WHERE r.ref=? AND f.deleted_at IS NULL', ref);
    return r?.id;
  }

  /** @param target 明确指定的反馈；'new' 强制新建；undefined 按合并窗口判断 */
  private record(m: Incoming, target: number | 'new' | undefined, text = m.text, dedupe = true): Outcome {
    const cur = this.cursor(m.openid);
    const inWindow = cur && !cur.closed && Math.abs(m.sentAt - cur.at) <= this.o.mergeWindowMs;
    let id = typeof target === 'number' ? target : target === undefined && inWindow ? cur.id : undefined;
    id ??= this.store.createFeedback(m.openid, m.sentAt);

    let body = text;
    const atts = [...m.attachments];
    const quote = typeof target !== 'number'; // 引用了未收录过的消息：连同原文一起记
    if (quote && m.quoted) body = [`[引用] ${m.quoted}`, body].filter(Boolean).join('\n');
    if (quote) atts.push(...m.quotedAttachments);
    const empty = !body && atts.length === 0;
    if (empty) body = '（收到一条平台未下发内容的消息，可能是合并转发的聊天记录，请改用截图或复制文字）';
    this.store.addMessage(id, { channel: 'qq', dedupeKey: dedupe ? m.dedupeKey : undefined, author: m.openid, kind: 'report', text: body, raw: m.raw, sentAt: m.sentAt, attachments: atts });
    if (m.msgIdx) this.addRef(m.msgIdx, id);
    this.setCursor(m.openid, { id, at: m.sentAt, closed: false });
    return { receipt: id, feedbackId: id, reply: empty ? `⚠️ #${id}：QQ 没有把这条消息的内容发给我（合并转发的聊天记录可能如此）。请改用截图，或复制文字再发一次。` : undefined };
  }

  private bind(m: Incoming): Outcome {
    const t = this.now();
    const fails = (this.bindFails.get(m.openid) ?? []).filter((x) => t - x < 10 * 60_000);
    const arg = /^[/／]?\s*绑定\s*(\d{6,10})$/.exec(m.text)?.[1];
    if (!arg) return { reply: '🔒 你还没有权限使用。请在网页后台「设置 → QQ 账号」生成绑定码，然后发送：绑定 12345678\n（未绑定前发送的内容不会被记录）' };
    if (fails.length >= 5) return { reply: '尝试次数过多，请 10 分钟后再试。' };
    const saved = JSON.parse(this.db.kvGet('bind_code') ?? 'null') as { code: string; exp: number } | null;
    if (!saved || saved.exp < t || saved.code !== arg) {
      this.bindFails.set(m.openid, [...fails, t]);
      return { reply: '绑定码不正确或已过期，请在后台重新生成。' };
    }
    this.db.tx(() => {
      this.db.kvDel('bind_code'); // 一次性
      this.db.run('INSERT OR REPLACE INTO qq_users(openid,nickname,bound_at) VALUES(?,?,?)', m.openid, m.nickname, t);
      this.store.markCommand(m.dedupeKey, m.openid, '绑定', m.sentAt);
    });
    return { reply: `✅ 绑定成功！\n\n${HELP}` };
  }

  private command(m: Incoming, name: string, arg: string, quotedId: number | undefined): Outcome | null {
    // 查询类指令夹带了附件：整条按内容收录，宁可多记不可丢
    if (m.attachments.length && READ_ONLY.has(name)) return null;
    try {
      return this.exec(m, name, arg, quotedId);
    } catch (e) {
      if (e instanceof UserError && m.attachments.length) return null;
      if (e instanceof UserError) return { reply: `⚠️ ${e.message}` };
      throw e;
    }
  }

  private exec(m: Incoming, name: string, arg: string, quotedId: number | undefined): Outcome | null {
    const cur = this.cursor(m.openid);
    const close = () => cur && this.setCursor(m.openid, { ...cur, closed: true });
    /** 取出开头的 #编号（写类指令必须带 #，避免「/备注 3 个用户…」被误解）。 */
    const idm = /^#(\d{1,9})\s*/.exec(arg);
    const rest = idm ? arg.slice(idm[0].length).trim() : arg;
    const bareId = /^#?(\d{1,9})$/.exec(arg)?.[1];
    const target = (): number => {
      const id = idm ? Number(idm[1]) : quotedId ?? cur?.id;
      if (!id) throw new UserError('没有当前反馈，请加编号，例如 #12');
      if (this.store.require(id).deleted_at) throw new UserError(`#${id} 已删除`);
      return id;
    };
    // 指令消息里夹带的图片不能丢
    const keepFiles = (id: number) => { if (m.attachments.length) this.record(m, id, '', false); };

    switch (name) {
      case '帮助': return { reply: HELP };
      case '绑定': return { reply: '你已经绑定过了。' };
      case '新建': {
        if (arg || m.attachments.length) return this.record(m, 'new', arg, false);
        close();
        return { reply: '🆕 好的，接下来发的内容会记为新的一条。' };
      }
      case '完成': {
        if (!cur || cur.closed) return { reply: '当前没有正在记录的反馈。' };
        keepFiles(cur.id);
        this.setCursor(m.openid, { ...cur, closed: true });
        return { reply: `✅ #${cur.id} 记录完成。\n${this.brief(cur.id)}`, feedbackId: cur.id };
      }
      case '撤销': {
        if (!cur) return { reply: '没有可撤销的内容。' };
        const r = this.store.undoLast(cur.id, m.openid);
        if (!r) return { reply: `#${cur.id} 里没有你发的素材可撤销。` };
        return { reply: `↩️ 已撤销：${clip(r.text || '（附件）', 30)}${r.removed ? `\n#${cur.id} 已无内容，一并删除（后台可恢复）。` : `\n仍属于 #${cur.id}`}` };
      }
      case '拆分': {
        if (!cur) return { reply: '没有可拆分的内容。' };
        const mid = this.store.lastMessageId(cur.id, m.openid);
        if (!mid) return { reply: `#${cur.id} 里没有你发的素材可拆分。` };
        const id = this.store.moveMessage(mid, null, m.openid);
        this.setCursor(m.openid, { id, at: m.sentAt, closed: false });
        return { reply: `✂️ 已从 #${cur.id} 拆出新反馈 #${id}\n${this.brief(id)}`, feedbackId: id };
      }
      case '补充': {
        const x = /^#?(\d{1,9})(?:\s+|$)([\s\S]*)$/.exec(arg);
        const id = x ? Number(x[1]) : quotedId;
        const body = x ? x[2]!.trim() : arg;
        if (!id) return null; // 没写编号：按普通内容记录，不丢
        if (this.store.require(id).deleted_at) throw new UserError(`#${id} 已删除`);
        if (!body && !m.attachments.length) { this.setCursor(m.openid, { id, at: m.sentAt, closed: false }); return { reply: `好的，接下来发的内容会追加到 #${id}。`, feedbackId: id }; }
        return this.record(m, id, body, false);
      }
      case '备注': {
        const id = target();
        if (!rest) throw new UserError('请写上备注内容，例如：/备注 已电话沟通');
        this.store.addMessage(id, { channel: 'qq', author: m.openid, kind: 'note', text: rest, sentAt: m.sentAt, attachments: m.attachments });
        return { reply: `📝 已给 #${id} 加备注。`, feedbackId: id };
      }
      case '解决': {
        const id = target();
        keepFiles(id);
        this.store.update(id, { status: 'resolved', ...(rest ? { resolution: rest } : {}) }, m.openid);
        if (cur?.id === id) close();
        return { reply: `🎉 #${id} 已标为解决${rest ? `，办法：${clip(rest, 50)}` : '。建议补上办法：/解决 #' + id + ' 处理办法'}`, feedbackId: id };
      }
      case '查': {
        if (!arg) throw new UserError('请写上关键词，例如：/查 导出 PDF');
        const r = this.store.list({ q: arg, pageSize: 8 });
        return { reply: r.total ? `🔍 “${clip(arg, 20)}” 共 ${r.total} 条${r.total > 8 ? '，最近 8 条' : ''}：\n${r.items.map((i) => this.line(i)).join('\n')}` : `🔍 没有找到 “${clip(arg, 20)}”` };
      }
      case '详情': {
        const id = bareId ? Number(bareId) : target();
        return { reply: this.full(id), feedbackId: id };
      }
      case '相似': {
        const id = bareId ? Number(bareId) : target();
        this.store.require(id);
        const s = this.store.similar(id, 6);
        return { reply: s.length ? `🔁 与 #${id} 相似：\n${s.map((x) => this.simLine(x)).join('\n')}` : `没有找到与 #${id} 相似的反馈。`, feedbackId: id };
      }
      case '待处理': {
        const r = this.store.list({ status: 'todo', pageSize: 10 });
        return { reply: r.total ? `📋 待处理 ${r.total} 条${r.total > 10 ? '，最近 10 条' : ''}：\n${r.items.map((i) => this.line(i)).join('\n')}` : '🎉 没有待处理的反馈。' };
      }
      case '统计': {
        const d = new Date(this.now()); d.setDate(d.getDate() - 30);
        const a = this.store.stats({}), b = this.store.stats({ from: d.getTime() });
        return { reply: `📊 累计 ${a.total} 条，待处理 ${a.todo} 条\n近 30 天 ${b.total} 条\n${b.byCategory.slice(0, 6).map((c: any) => `· ${c.name || '未分类'} ${c.count}`).join('\n')}`.trim() };
      }
      case '同类': case '并入': {
        const x = /^#?(\d{1,9})(?:\s+#?(\d{1,9}))?$/.exec(arg);
        if (!x) throw new UserError(`格式：/${name} 7（当前这条与 #7），或 /${name} 12 7`);
        const a = x[2] ? Number(x[1]) : quotedId ?? cur?.id, b = Number(x[2] ?? x[1]);
        if (!a) throw new UserError(`没有当前反馈，请写两个编号，例如：/${name} 12 7`);
        if (name === '同类') {
          const g = this.store.group(a, b, m.openid);
          return { reply: `🗂 #${a} 与 #${b} 已归为同类：\n${clip(g.title, 40)}（共 ${g.count} 条）`, feedbackId: a };
        }
        this.store.merge(a, b, m.openid);
        this.setCursor(m.openid, { id: b, at: m.sentAt, closed: false });
        return { reply: `🔗 #${a} 已并入 #${b}\n${this.brief(b)}`, feedbackId: b };
      }
    }

    const field = FIELD_CMDS[name];
    if (!field) return null;
    const id = target();
    if (!rest) throw new UserError(`请写上内容，例如：/${name} ${name === '状态' ? Object.values(STATUS).join(' 或 ') : name === '优先级' ? Object.values(SEVERITY).join(' 或 ') : 'xxx'}`);
    let value: unknown = rest;
    if (field === 'status' || field === 'severity') {
      const map = field === 'status' ? STATUS : SEVERITY;
      value = codeOf(map, rest);
      if (!value) throw new UserError(`${name}可选：${Object.values(map).join('、')}`);
    } else if (field === 'tags') value = [...this.store.tags(id), ...splitTags(rest)];
    else if (field === 'category') value = this.store.matchCategory(rest);
    keepFiles(id);
    this.store.update(id, { [field]: value }, m.openid);
    return { reply: `✏️ #${id} ${name}：${field === 'tags' ? (value as string[]).join('、') : clip(field === 'category' ? String(value) : rest, 40)}`, feedbackId: id };
  }

  // ───────── 文案 ─────────

  private line(i: any): string { return `#${i.id} [${STATUS[i.status]}] ${clip(i.title, 28)}（${fmtTime(i.created_at).slice(5, 10)}）`; }
  private simLine(x: any): string {
    const sol = x.resolution || x.topic_solution;
    return `· #${x.id} ${clip(x.title, 26)}（${Math.round(x.score * 100)}%，${STATUS[x.status]}）${sol ? `\n   办法：${clip(sol, 40)}` : ''}`;
  }
  private counts(id: number): string {
    const f = this.store.detail(id);
    const n = { 文字: 0, 截图: 0, 语音: 0, 视频: 0, 文件: 0 } as Record<string, number>;
    const label: Record<string, string> = { image: '截图', voice: '语音', video: '视频', file: '文件' };
    for (const m of f.messages) { if (m.text) n['文字']!++; for (const a of m.attachments) n[label[a.kind]!]!++; }
    return Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${k}${v}`).join('、') || '空';
  }
  private brief(id: number): string {
    const f = this.store.require(id);
    return `标题：${f.title}\n分类：${f.category}${f.product ? `｜${f.product}` : ''}${f.version ? `｜${f.version}` : ''}${f.reporter ? `｜反馈人：${f.reporter}` : ''}\n素材：${this.counts(id)}`;
  }

  /** 收录回执。 */
  receipt(id: number): string {
    const f = this.store.detail(id);
    const sim = this.store.similar(id, 3).filter((s) => s.score >= 0.2 && !(f.topic_id && s.topic_id === f.topic_id));
    const atts = f.messages.flatMap((m: any) => m.attachments);
    const bad = atts.filter((a: any) => a.status === 'failed').length, wait = atts.filter((a: any) => a.status === 'pending').length;
    return [
      `✅ 已记录 #${id}`, this.brief(id),
      bad ? `⚠️ ${bad} 个附件没能保存，请重发` : '', wait ? `⏳ ${wait} 个附件还在保存，失败会自动重试` : '',
      sim.length ? `🔁 以前有类似的：\n${sim.map((s) => this.simLine(s)).join('\n')}\n归为同类请发：同类 ${sim[0]!.id}` : '',
      `（${Math.round(this.o.mergeWindowMs / 60_000)} 分钟内继续发会并入本条，发「新建」另起一条）`,
    ].filter(Boolean).join('\n');
  }

  private full(id: number): string {
    const f = this.store.detail(id);
    const text = f.messages.filter((m: any) => m.kind === 'report').flatMap((m: any) => [m.text, ...m.attachments.map((a: any) => (a.text ? `[识别] ${a.text}` : ''))]).filter(Boolean).join('\n');
    return clip([
      `#${id} ${f.title}`, `${STATUS[f.status]}｜${SEVERITY[f.severity]}｜${f.category}${f.product ? `｜${f.product}` : ''}${f.version ? `｜${f.version}` : ''}`,
      `${fmtTime(f.created_at)}${f.reporter ? `｜反馈人：${f.reporter}` : ''}｜${this.counts(id)}`,
      f.topic ? `同类问题：${f.topic.title}` : '', '', clip(text, 800),
      f.resolution ? `\n处理结果：${f.resolution}` : f.topic?.solution ? `\n同类方案：${f.topic.solution}` : '',
    ].filter((x) => x !== '').join('\n'), 1500);
  }
}
