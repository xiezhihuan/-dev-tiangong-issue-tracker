import assert from 'node:assert/strict';
import test from 'node:test';
import './helper.js';
import { Db } from '../src/db.js';
import { DEFAULT_CATEGORIES } from '../src/defaults.js';
import { toCsv, toMarkdown } from '../src/exports.js';
import { parseCommand } from '../src/intake.js';
import { isPrivateIp, sniff } from '../src/media.js';
import { slices } from '../src/ocr.js';
import { parseC2C, sanitizeReply } from '../src/qq/message.js';
import { Store } from '../src/store.js';
import { classify, detectVersion, makeTitle, parseMeta, SimilarityIndex, tidyOcr } from '../src/text.js';

const cats = DEFAULT_CATEGORIES.map(([name, keywords]) => ({ name, keywords }));
const mk = () => new Store(new Db(':memory:'));
const add = (s: Store, text: string, extra: object = {}) => { const id = s.createFeedback('t'); s.addMessage(id, { channel: 'web', author: 't', kind: 'report', text, sentAt: Date.now(), attachments: [], ...extra }); return id; };

test('指令识别：只认明确格式，正文不会被误判', () => {
  for (const [t, n, a] of [['新建', '新建', ''], ['/新建 导出失败', '新建', '导出失败'], ['／完成', '完成', ''], ['/客户 #12 张三', '客户', '#12 张三'], ['/补充 12 又出现了', '补充', '12 又出现了'], ['同类 7', '同类', '7'], ['归并#7', '同类', '7'], ['/查 导出 PDF', '查', '导出 PDF'], ['/help', '帮助', ''], ['/版本：3.2.1', '版本', '3.2.1'], ['/详情12', '详情', '12']] as const)
    assert.deepEqual(parseCommand(t), { name: n, arg: a }, t);
  for (const t of ['新建案件的时候报错', '完成之后没有提示', '统计数据不对', '/usr/bin/app 崩溃', '查不到案件', '/新建案件报错', '详情页打不开', '帮助文档在哪', '同类案件 7 个都打不开', '撤销按钮没反应', '解决不了'])
    assert.equal(parseCommand(t), null, t);
});
test('元信息行解析', () => {
  assert.deepEqual(parseMeta('客户：张三律所\n【产品】: PC端\n版本：3.2\n标签：紧急 打印，V3\n优先级：高\n导出报错'), { reporter: '张三律所', product: 'PC端', version: '3.2', tags: ['紧急', '打印', 'V3'], severity: '高' });
  assert.deepEqual(parseMeta('客户说：导出报错'), {});
});
test('版本号识别', () => {
  assert.equal(detectVersion('我用的V3.2.1，win11'), 'V3.2.1');
  assert.equal(detectVersion('版本是 2.10 的'), 'V2.10');
  assert.equal(detectVersion('金额 3.5 万，IP 192.168.1.1'), '');
});
test('标题生成', () => {
  assert.equal(makeTitle(['客户：张三\n导出PDF失败'], [], []), '导出PDF失败');
  assert.equal(makeTitle([''], ['9:41\n导出的时候提示文件损坏\n好的'], ['image']), '导出的时候提示文件损坏');
  assert.equal(makeTitle([''], [], ['image', 'image', 'voice']), '（截图、语音反馈，待补充说明）');
  assert.equal([...makeTitle(['长'.repeat(100)], [], [])].length, 40);
});
test('自动分类', () => {
  for (const [t, c] of [['登录不上，验证码收不到', '登录与账号'], ['导出PDF提示文件损坏', '导入导出与文件'], ['点击案件列表会卡住很慢', '卡顿与性能'], ['软件闪退打不开', '崩溃与闪退'], ['打印的时候页眉没了', '打印'], ['希望增加一个批量功能', '功能建议'], ['昨天写的内容丢失了', '数据错误或丢失']] as const)
    assert.equal(classify(t, cats), c, t);
  assert.equal(classify('啊啊啊', cats), '');
});
test('相似度：同类高于阈值，无关低于阈值', () => {
  const docs = ['导出PDF提示文件损坏', '导出 pdf 的时候报错说文件损坏了', '登录收不到验证码', '打印页眉错位', '手机收不到登录验证码短信', '软件启动闪退', '列表加载很慢', '希望增加批量删除'].map((text, id) => ({ id: id + 1, text }));
  const s = new SimilarityIndex();
  const hits = (id: number) => s.query(docs[id - 1]!, docs, 5, 0.2).map((h) => h.id);
  assert.deepEqual(hits(1), [2]);
  assert.deepEqual(hits(3), [5]);
  assert.deepEqual(hits(6), []);
});
test('QQ 消息规整：表情、语音、卡片、引用、聊天记录', () => {
  const base = { id: 'm', author: { user_openid: 'u' }, timestamp: '2026-07-21T10:00:00+08:00', message_scene: { ext: ['msg_idx=R1'] } };
  const ext = Buffer.from(JSON.stringify({ text: '[流泪]' })).toString('base64');
  assert.equal(parseC2C({ ...base, content: `崩溃了<faceType=1,faceId="5",ext="${ext}"> a<b` }).text, '崩溃了[表情:流泪] a<b');
  const v = parseC2C({ ...base, content: '', attachments: [{ content_type: 'voice', url: '//x.qq.com/a', filename: 'a.silk', voice_wav_url: 'https://x.qq.com/a.wav', asr_refer_text: '导出不了' }] });
  assert.deepEqual([v.attachments[0]!.kind, v.attachments[0]!.url, v.attachments[0]!.filename, v.attachments[0]!.text], ['voice', 'https://x.qq.com/a.wav', 'a.wav', '导出不了']);
  assert.equal(parseC2C({ ...base, attachments: [{ content_type: 'image/png', url: '//x.qq.com/a' }] }).attachments[0]!.url, 'https://x.qq.com/a');
  assert.match(parseC2C({ ...base, content: '[卡片消息] 小程序\n摘要', message_type: 3, ark_data: { ark_name: '小程序', fields: { title: '打卡', desc: '说明' } } }).text, /^\[小程序\] 打卡 说明$/);
  const q = parseC2C({ ...base, content: '补充', message_type: 103, message_scene: { ext: ['ref_msg_idx=R0', 'msg_idx=R1'] }, msg_elements: [{ msg_idx: 'R0', content: '原文' }] });
  assert.deepEqual([q.refIdx, q.text, q.quoted], ['R0', '补充', '原文']);
  const rec = parseC2C({ ...base, content: '', message_type: 102, msg_elements: [{ content: '张三: 打不开', msg_elements: [{ content: '李四: 我也是', attachments: [{ content_type: 'image/jpeg', url: 'https://a.qq.com/1' }] }] }] });
  assert.equal(rec.text, '张三: 打不开\n李四: 我也是');
  assert.equal(rec.attachments.length, 1);
});
test('回复净化：去掉链接与域名，不误伤版本号和文件名', () => {
  assert.equal(sanitizeReply('见 https://a.com/x 和 www.b.cn/y 版本 V3.2.1 文件 a.pdf'), '见 [链接] 和 [链接] 版本 V3.2.1 文件 a.pdf');
});
test('内网地址判断与文件头识别', () => {
  for (const ip of ['127.0.0.1', '10.1.1.1', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['1.1.1.1', '203.205.1.1', '2400:3200::1']) assert.ok(!isPrivateIp(ip), ip);
  assert.equal(sniff(Buffer.from('<svg onload=alert(1)>'.padEnd(32))), null);
});
test('OCR 文本整理与长图切片归属', () => {
  assert.equal(tidyOcr('导 出 PDF 失 败\n\n 好 的 '), '导出 PDF 失败\n好的');
  for (const h of [1, 1800, 1801, 3360, 10308]) {
    const s = slices(h);
    assert.equal(s[0]!.from, 0); assert.equal(s.at(-1)!.to, Infinity);
    for (let i = 1; i < s.length; i++) assert.equal(s[i]!.from, s[i - 1]!.to, '归属区间首尾相接');
    for (const x of s) assert.ok(x.h > 0 && x.h <= 1800);
  }
});
test('存储：自动字段跟随内容，人工修改后不再覆盖，清空恢复自动', () => {
  const s = mk(), id = add(s, '导出PDF失败 V3.1.0');
  assert.equal(s.require(id).category, '导入导出与文件');
  s.update(id, { category: '打印', title: '我的标题' }, 't');
  s.addMessage(id, { channel: 'web', author: 't', kind: 'report', text: '登录验证码也收不到', sentAt: 1, attachments: [] });
  assert.deepEqual([s.require(id).category, s.require(id).title, s.require(id).version], ['打印', '我的标题', 'V3.1.0']);
  s.update(id, { category: '', title: '' }, 't');
  assert.equal(s.require(id).title, '导出PDF失败 V3.1.0');
  assert.notEqual(s.require(id).category, '打印');
});
test('存储：搜索（中文子串、多词、特殊字符、编号）与过滤', () => {
  const s = mk(); const a = add(s, '导出PDF进度 100% 后失败'), b = add(s, '导出Word正常'); add(s, '登录问题');
  const ids = (f: object) => s.list(f).items.map((i) => i.id).sort();
  assert.deepEqual(ids({ q: '导出' }), [a, b]);
  assert.deepEqual(ids({ q: '导出 pdf' }), [a]);
  assert.deepEqual(ids({ q: '100%' }), [a]);
  assert.deepEqual(ids({ q: '%' }), [a]);
  assert.deepEqual(ids({ q: `#${b}` }), [b]);
  assert.deepEqual(ids({ q: "' OR 1=1 --" }), []);
  s.update(a, { status: 'resolved' }, 't');
  assert.equal(s.list({ status: 'todo' }).total, 2);
});
test('存储：归同类、拆分、合并、撤删、级联解决', () => {
  const s = mk(); const a = add(s, '导出PDF失败'), b = add(s, '导出PDF报错'), c = add(s, '登录失败');
  const g = s.group(a, b, 't');
  assert.equal(g.count, 2);
  assert.throws(() => s.group(a, a, 't'));
  s.updateTopic(g.topicId, { solution: '升级到 3.3', status: 'resolved' }, 't', true);
  assert.equal(s.require(a).status, 'resolved');
  assert.equal(s.similar(a)[0]!.topic_solution, '升级到 3.3');
  s.merge(c, a, 't');
  assert.ok(s.require(c).deleted_at);
  assert.equal(s.detail(a).messages.length, 2);
  const n = s.moveMessage(s.detail(a).messages.find((m: any) => m.text === '登录失败').id, null, 't');
  assert.equal(s.require(n).title, '登录失败');
  assert.throws(() => s.moveMessage(s.detail(n).messages[0].id, null, 't'), /无需拆分/);
});
test('存储：分类改名同步，关键词变化只影响自动归类的反馈', () => {
  const s = mk(); const a = add(s, '量子纠缠异常'), b = add(s, '量子纠缠异常'); s.update(b, { category: '打印' }, 't');
  s.saveTaxonomy('category', { name: '量子', keywords: '纠缠' });
  assert.deepEqual([s.require(a).category, s.require(b).category], ['量子', '打印']);
  s.saveTaxonomy('category', { id: s.taxonomy('category').find((x) => x.name === '打印')!.id, name: '打印机', keywords: '打印' });
  assert.equal(s.require(b).category, '打印机');
  s.saveTaxonomy('product', { name: 'PC客户端', keywords: '电脑版' });
  assert.equal(s.require(add(s, '电脑版打不开')).product, 'PC客户端');
});
test('导出：CSV 防公式注入，Markdown 按同类组织', () => {
  const s = mk(); const a = add(s, '=cmd|calc, "x"\n第二行'), b = add(s, '导出失败'); s.group(a, b, 't'); s.updateTopic(1, { solution: '重装' }, 't');
  const csv = toCsv(s, {});
  assert.ok(csv.startsWith('﻿编号'));
  assert.ok(csv.includes(`"'=cmd|calc, ""x""`));
  const md = toMarkdown(s, {});
  assert.ok(md.includes('## 同类问题') && md.includes('**方案**：重装'));
});
