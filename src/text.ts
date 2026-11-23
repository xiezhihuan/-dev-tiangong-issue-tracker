/** 文本处理：元信息行解析、标题生成、分类打分、相似度。全部本地计算，不出网。 */

export interface Meta { reporter?: string; product?: string; version?: string; category?: string; severity?: string; source?: string; tags?: string[]; title?: string }

const META_KEYS: Record<string, keyof Meta> = {
  客户: 'reporter', 反馈人: 'reporter', 用户: 'reporter', 产品: 'product', 软件: 'product', 版本: 'version', 版本号: 'version',
  分类: 'category', 类别: 'category', 优先级: 'severity', 严重程度: 'severity', 来源: 'source', 标签: 'tags', 标题: 'title',
};
const META_LINE = new RegExp(`^\\s*[【\\[]?(${Object.keys(META_KEYS).sort((a, b) => b.length - a.length).join('|')})[】\\]]?\\s*[:：]\\s*(\\S.*?)\\s*$`);

/** 只从独占一行的「键：值」里取元信息；原文不改动。值过长的视为正文。 */
export function parseMeta(text: string): Meta {
  const meta: Meta = {};
  for (const line of text.split('\n')) {
    const m = META_LINE.exec(line);
    if (!m || m[2]!.length > 40) continue;
    const key = META_KEYS[m[1]!]!;
    if (key === 'tags') meta.tags = splitTags(m[2]!);
    else meta[key] = m[2]!;
  }
  return meta;
}
export const isMetaLine = (line: string): boolean => META_LINE.test(line);
export const splitTags = (s: string): string[] => [...new Set(s.split(/[\s,，、;；#]+/).map((t) => t.trim()).filter(Boolean))].map((t) => t.slice(0, 20));

const VERSION = /(?:^|[^\w.])[vV]\s?(\d{1,4}(?:\.\d{1,6}){1,3})(?![\w.])|版本(?:号)?\s*(?:是|为|[:：])?\s*[vV]?\s?(\d{1,4}(?:\.\d{1,6}){1,3})(?![\w.])/;
export function detectVersion(text: string): string {
  const m = VERSION.exec(text);
  const v = m?.[1] ?? m?.[2];
  return v ? `V${v}` : '';
}

export function clip(s: string, n: number): string {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : s;
}

/** 标题：取第一行有内容的正文；没有正文则用截图/语音识别文字；再没有就按素材类型命名。 */
export function makeTitle(texts: string[], recognized: string[], kinds: string[]): string {
  for (const t of texts) {
    for (const line of t.split('\n')) {
      const s = line.replace(/^\[(引用|聊天记录)\]\s*/, '').replace(/\[表情[^\]]*\]/g, '').trim();
      if (!isMetaLine(line) && /[\p{L}\p{N}]{2}/u.test(s)) return clip(s, 40);
    }
  }
  let best = '';
  for (const t of recognized) for (const line of t.split('\n')) {
    const s = line.trim();
    if ([...s].length >= 6 && [...s].length > [...best].length) best = s;
  }
  if (best) return clip(best, 40);
  const name: Record<string, string> = { image: '截图', voice: '语音', video: '视频', file: '文件' };
  const uniq = [...new Set(kinds)].map((k) => name[k] ?? k);
  return uniq.length ? `（${uniq.join('、')}反馈，待补充说明）` : '（空内容）';
}

export interface TaxItem { name: string; keywords: string }
/** 关键词命中打分：命中词越长越可信。返回得分最高的名称，没有命中返回空串。 */
export function classify(text: string, items: TaxItem[]): string {
  const hay = text.toLowerCase();
  let best = '', score = 0;
  for (const it of items) {
    let s = 0;
    for (const kw of it.keywords.split(/[,，]/).map((k) => k.trim().toLowerCase()).filter(Boolean)) if (hay.includes(kw)) s += [...kw].length;
    if (s > score) { score = s; best = it.name; }
  }
  return best;
}
/** 产品识别：名称本身也算关键词。 */
export const classifyProduct = (text: string, items: TaxItem[]): string => classify(text, items.map((i) => ({ name: i.name, keywords: `${i.name},${i.keywords}` })));

const STOP = new Set(['你好', '您好', '我们', '这边', '一下', '就是', '这个', '那个', '现在', '什么', '可以', '不能', '无法', '没有', '时候', '问题', '麻烦', '请问', '谢谢', '收到', '怎么', '还是', '一直', '已经', '然后', '但是', '因为', '所以', '的时', '了一', '是不', '图片', '截图', 'the', 'and', 'is', 'to', 'of']);

/** 分词：中文二元组 + 英文/数字词。 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/\p{Script=Han}+|[a-z0-9][a-z0-9._-]*/gu)) {
    const s = m[0];
    if (/\p{Script=Han}/u.test(s)) {
      const c = [...s];
      if (c.length === 1) continue;
      for (let i = 0; i + 1 < c.length; i++) { const g = c[i]! + c[i + 1]!; if (!STOP.has(g)) out.push(g); }
    } else if (s.length > 1 && !STOP.has(s)) out.push(s.replace(/[._-]+$/, ''));
  }
  return out;
}

export interface Doc { id: number; text: string }
export interface Hit { id: number; score: number }

/** TF-IDF 余弦相似度，按内容缓存分词结果。几千条规模下毫秒级。 */
export class SimilarityIndex {
  private cache = new Map<number, { text: string; tf: Map<string, number> }>();

  private tf(doc: Doc): Map<string, number> {
    const hit = this.cache.get(doc.id);
    if (hit && hit.text === doc.text) return hit.tf;
    const tf = new Map<string, number>();
    for (const t of tokenize(doc.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) tf.set(t, 1 + Math.log(n));
    this.cache.set(doc.id, { text: doc.text, tf });
    return tf;
  }

  /** @param corpus 全部候选（可含 query 自身，会被排除） */
  query(query: Doc, corpus: Doc[], limit = 5, minScore = 0.12): Hit[] {
    const q = this.tf(query);
    if (q.size === 0) return [];
    const docs = corpus.filter((d) => d.id !== query.id).map((d) => ({ id: d.id, tf: this.tf(d) }));
    const alive = new Set(corpus.map((d) => d.id).concat(query.id));
    for (const id of this.cache.keys()) if (!alive.has(id)) this.cache.delete(id);

    const df = new Map<string, number>();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const n = docs.length + 1;
    const idf = (t: string) => Math.log(1 + n / ((df.get(t) ?? 0) + 1));
    const norm = (tf: Map<string, number>) => { let s = 0; for (const [t, w] of tf) s += (w * idf(t)) ** 2; return Math.sqrt(s); };
    const qn = norm(q);
    const hits: Hit[] = [];
    for (const d of docs) {
      let dot = 0;
      for (const [t, w] of q) { const dw = d.tf.get(t); if (dw) dot += w * dw * idf(t) ** 2; }
      if (dot === 0) continue;
      const score = dot / (qn * norm(d.tf));
      if (score >= minScore) hits.push({ id: d.id, score });
    }
    return hits.sort((a, b) => b.score - a.score || b.id - a.id).slice(0, limit);
  }
}

/** 去掉 OCR 在汉字之间插入的空格。 */
export const tidyOcr = (s: string): string => s.replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

/** 通用查询转义。 */
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);
