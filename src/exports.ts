import type { Row } from './db.js';
import { SEVERITY, STATUS, type Filter, type Store } from './store.js';

const pad = (n: number) => String(n).padStart(2, '0');
export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 防 CSV 注入：以公式字符开头的内容前加单引号。 */
const cell = (v: unknown): string => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const fullText = (d: Row): string => (d.messages as Row[]).filter((m) => m.kind === 'report').map((m) => [m.text, ...m.attachments.map((a: Row) => `[${a.kind === 'image' ? '截图' : a.kind === 'voice' ? '语音' : '附件'}${a.filename ? ' ' + a.filename : ''}]${a.text ? ' ' + a.text : ''}`)].filter(Boolean).join('\n')).join('\n');
const notes = (d: Row): string => (d.messages as Row[]).filter((m) => m.kind === 'note').map((m) => m.text).join('\n');

function details(store: Store, f: Filter): Row[] {
  return store.list({ ...f, page: 1, pageSize: 100_000 }).items.map((i) => ({ ...store.detail(i.id) }));
}

export function toCsv(store: Store, f: Filter): string {
  const head = ['编号', '时间', '标题', '状态', '优先级', '分类', '产品', '版本', '反馈人', '来源', '标签', '同类问题', '反馈内容', '内部备注', '处理结果', '解决时间'];
  const rows = details(store, f).map((d) => [d.id, fmtTime(d.created_at), d.title, STATUS[d.status], SEVERITY[d.severity], d.category, d.product, d.version, d.reporter, d.source, d.tags.join('、'), d.topic?.title ?? '', fullText(d), notes(d), d.resolution, fmtTime(d.resolved_at)]);
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function toJson(store: Store, f: Filter): string {
  return JSON.stringify(details(store, f).map(({ events: _e, ...d }) => d), null, 2);
}

/** 便于通读或交给分析工具的 Markdown，按同类问题、再按分类组织。 */
export function toMarkdown(store: Store, f: Filter): string {
  const all = details(store, f);
  const out: string[] = [`# 用户反馈汇总`, '', `导出时间：${fmtTime(Date.now())}，共 ${all.length} 条`, ''];
  const section = (d: Row) => {
    out.push(`#### #${d.id} ${d.title}`, '', `- ${fmtTime(d.created_at)}｜${STATUS[d.status]}｜${SEVERITY[d.severity]}｜${d.category}${d.product ? '｜' + d.product : ''}${d.version ? '｜' + d.version : ''}${d.reporter ? '｜反馈人：' + d.reporter : ''}${d.tags.length ? '｜标签：' + d.tags.join('、') : ''}`, '');
    out.push(fullText(d).split('\n').map((l) => `> ${l}`).join('\n'), '');
    if (notes(d)) out.push(`备注：${notes(d)}`, '');
    if (d.resolution) out.push(`**处理结果**：${d.resolution}`, '');
  };
  const topics = new Map<number, Row[]>(), cats = new Map<string, Row[]>();
  for (const d of all) {
    if (d.topic) (topics.get(d.topic.id) ?? topics.set(d.topic.id, []).get(d.topic.id)!).push(d);
    else (cats.get(d.category) ?? cats.set(d.category, []).get(d.category)!).push(d);
  }
  if (topics.size) out.push('## 同类问题', '');
  for (const list of [...topics.values()].sort((a, b) => b.length - a.length)) {
    const t = list[0]!.topic;
    out.push(`### ${t.title}（${list.length} 条，${t.status === 'resolved' ? '已解决' : '未解决'}）`, '');
    if (t.root_cause) out.push(`**原因**：${t.root_cause}`, '');
    if (t.solution) out.push(`**方案**：${t.solution}`, '');
    list.forEach(section);
  }
  if (cats.size) out.push('## 未归并的反馈', '');
  for (const [c, list] of [...cats].sort((a, b) => b[1].length - a[1].length)) { out.push(`### ${c || '未分类'}（${list.length} 条）`, ''); list.forEach(section); }
  return out.join('\n');
}
