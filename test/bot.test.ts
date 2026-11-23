import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { boot, PNG, sleep, U, until, type Env } from './helper.js';

const run = (name: string, fn: (e: Env) => Promise<void>, ...a: Parameters<typeof boot>) => test(name, async () => { const e = await boot(...a); try { await fn(e); } finally { await e.stop(); } });
const count = (e: Env) => e.app.store.list({}).total;
const detail = (e: Env, id: number) => e.app.store.detail(id);

run('未绑定者不记录；绑定码一次性、可防爆破', async (e) => {
  e.mock.say(U, '导出失败');
  await e.reply(/没有权限/);
  assert.equal(e.app.store.db.get('SELECT COUNT(*) n FROM messages')!.n, 0);
  e.app.store.db.kvSet('bind_code', JSON.stringify({ code: '12345678', exp: Date.now() + 60_000 }));
  e.mock.say(U, '绑定 00000000');
  await e.reply(/不正确/);
  e.mock.say(U, '绑定 12345678');
  await e.reply(/绑定成功/);
  e.mock.say('B'.repeat(32), '绑定 12345678');
  await until(() => e.mock.sent.filter((s) => /不正确/.test(s.content)).length === 2);
  for (let i = 0; i < 6; i++) e.mock.say('C'.repeat(32), '绑定 11111111');
  await e.reply(/次数过多/);
  e.mock.say(U, '导出失败');
  await e.reply(/已记录 #1/);
}, {}, { bind: false });

run('连发多条合并成一条，只回一次；新建/完成后另起', async (e) => {
  e.mock.say(U, '客户：张三\n导出PDF提示损坏 V3.2.1'); e.mock.say(U, '昨天升级以后出现'); e.mock.say(U, '重启也没用');
  const r = await e.reply(/已记录 #1/);
  assert.match(r, /标题：导出PDF提示损坏/); assert.match(r, /分类：导入导出与文件/); assert.match(r, /反馈人：张三/); assert.match(r, /V3\.2\.1/); assert.match(r, /文字3/);
  await sleep(200);
  assert.equal(e.mock.sent.length, 1);
  e.mock.say(U, '新建'); await e.reply(/另起|新的一条/);
  e.mock.say(U, '登录收不到验证码'); await e.reply(/已记录 #2/);
  e.mock.say(U, '完成'); await e.reply(/#2 记录完成/);
  e.mock.say(U, '打印页眉错位'); await e.reply(/已记录 #3/);
  assert.equal(count(e), 3);
});
run('超过合并窗口自动另起（以平台时间戳为准）', async (e) => {
  const t = Date.now();
  e.mock.say(U, '第一条', { at: t - 20 * 60_000 }); e.mock.say(U, '同一条', { at: t - 17 * 60_000 }); e.mock.say(U, '另一条', { at: t });
  await e.reply(/#2/);
  assert.deepEqual([detail(e, 1).messages.length, detail(e, 2).messages.length], [2, 1]);
});
run('引用任意一条（自己的消息或机器人回执）都能追加到对应反馈', async (e) => {
  const a = e.mock.say(U, '导出失败'); await e.reply(/已记录 #1/);
  e.mock.say(U, '新建'); e.mock.say(U, '登录失败'); await e.reply(/已记录 #2/);
  e.mock.say(U, '补充给第一条', { ref: a.idx, msg_elements: [{ msg_idx: a.idx, content: '导出失败' }] });
  await until(() => detail(e, 1).messages.length === 2);
  e.mock.say(U, '新建'); e.mock.say(U, '第三个'); await e.reply(/已记录 #3/);
  const bot2 = e.mock.sent.findIndex((s) => /已记录 #2/.test(s.content)) + 1;
  e.mock.say(U, '/解决 重置密码即可', { ref: `REFIDX_bot${bot2}` });
  await e.reply(/#2 已标为解决/);
  assert.equal(detail(e, 2).resolution, '重置密码即可');
  e.mock.say(U, '新建');
  e.mock.say(U, '这条也是', { ref: 'REFIDX_unknown', msg_elements: [{ msg_idx: 'REFIDX_unknown', content: '绑定前发的旧消息' }] });
  await until(() => count(e) === 4);
  assert.match(detail(e, 4).messages[0].text, /\[引用\] 绑定前发的旧消息\n这条也是/);
});
run('指令：字段、备注、查询、同类、并入、拆分、撤销', async (e) => {
  const cmd = async (t: string, re: RegExp) => { const n = e.mock.sent.length; e.mock.say(U, t); return e.reply(re, n); };
  await cmd('导出PDF提示文件损坏', /已记录 #1/);
  await cmd('/客户 张三律所', /客户：张三律所/); await cmd('/产品 PC端', /产品：PC端/); await cmd('/优先级 紧急', /紧急/); await cmd('/标签 导出 V3', /导出、V3/);
  await cmd('/状态 处理中', /处理中/); await cmd('/状态 随便', /可选：待处理/); await cmd('/备注 3 个用户都遇到', /加备注/); await cmd('/分类 打印', /分类：打印/);
  const f = detail(e, 1);
  assert.deepEqual([f.reporter, f.product, f.severity, f.status, f.category, f.tags], ['张三律所', 'PC端', 'urgent', 'doing', '打印', ['导出', 'V3']]);
  assert.equal(f.messages.find((m: any) => m.kind === 'note').text, '3 个用户都遇到');
  await cmd('新建', /新的一条/);
  assert.match(await cmd('导出 pdf 报文件损坏', /已记录 #2/), /以前有类似的：\n· #1.*\n归为同类请发：同类 1/);
  await cmd('同类 1', /已归为同类[\s\S]*共 2 条/);
  assert.match(await cmd('/查 损坏', /共 2 条/), /#1/);
  await cmd('/查 不存在的词', /没有找到/); await cmd('/详情 1', /张三律所/); await cmd('相似 1', /#2/); await cmd('待处理', /待处理 2 条/); await cmd('统计', /累计 2 条/);
  await cmd('又发了一条其实是别的问题', /已记录 #2/); await cmd('拆分', /拆出新反馈 #3/);
  await cmd('/并入 2', /#3 已并入 #2/); assert.ok(e.app.store.require(3).deleted_at);
  await cmd('撤销', /已撤销/); assert.equal(detail(e, 2).messages.length, 1);
  await cmd('撤销', /一并删除/); assert.ok(e.app.store.require(2).deleted_at);
  await cmd('/客户 #99 某人', /#99 不存在/); await cmd('/补充 1 追加内容', /已记录 #1/);
  assert.ok(detail(e, 1).messages.some((m: any) => m.text === '追加内容'));
  await cmd('/usr/bin 崩溃', /已记录/);
});
run('指令夹带图片时图片不丢', async (e) => {
  e.mock.files.set('/file/a', { body: PNG });
  const att = { attachments: [{ content_type: 'image/png', url: e.mock.base + '/file/a' }] };
  e.mock.say(U, '/查 导出', att);
  await until(() => count(e) === 1);
  e.mock.say(U, '/客户 李四', att);
  await e.reply(/客户：李四/);
  assert.equal(detail(e, 1).messages.flatMap((m: any) => m.attachments).length, 2);
  e.mock.say(U, '/新建 另一个问题', att);
  await until(() => count(e) === 2);
  assert.equal(detail(e, 2).messages[0].attachments.length, 1);
});
run('附件：落盘、去重、失败重试、OCR 文字进入标题/分类/搜索', async (e) => {
  e.mock.files.set('/file/a', { body: PNG, fail: 2 }); e.mock.files.set('/file/b', { body: PNG });
  e.mock.say(U, '', { attachments: [{ content_type: 'image/png', url: e.mock.base + '/file/a', filename: 'a.png' }] });
  e.mock.say(U, '', { attachments: [{ content_type: 'image/png', url: e.mock.base + '/file/b', filename: 'b.png' }] });
  await until(() => detail(e, 1).messages.flatMap((m: any) => m.attachments).every((a: any) => a.ocr_status === 'done'));
  const rows = e.app.store.db.all('SELECT * FROM attachments');
  assert.equal(rows[0]!.attempts, 2);
  assert.equal(rows[0]!.path, rows[1]!.path);
  assert.deepEqual(fs.readFileSync(path.join(e.dir, 'files', rows[0]!.path)), PNG);
  assert.equal(detail(e, 1).title, '打印机页眉显示不正常');
  assert.equal(detail(e, 1).category, '打印');
  assert.equal(e.app.store.list({ q: '页眉' }).total, 1);
  await e.reply(/截图2/);
}, {}, { ocr: { recognize: async () => '9:41\n打印机页眉显示不正常' } });
run('附件彻底失败时回执明确告知，可手动重试', async (e) => {
  e.mock.say(U, '看图', { attachments: [{ content_type: 'image/png', url: e.mock.base + '/file/none' }] });
  await until(() => detail(e, 1).messages[0].attachments[0].status === 'failed');
  e.mock.files.set('/file/none', { body: PNG });
  e.app.media.retry(1);
  await until(() => detail(e, 1).messages[0].attachments[0].status === 'done');
});
run('超大附件、空附件被拒绝且不留临时文件', async (e) => {
  e.mock.files.set('/file/big', { body: Buffer.alloc(3000, 1) }); e.mock.files.set('/file/empty', { body: Buffer.alloc(0) });
  e.mock.say(U, 'x', { attachments: [{ content_type: 'file', url: e.mock.base + '/file/big' }, { content_type: 'file', url: e.mock.base + '/file/empty' }] });
  await until(() => detail(e, 1).messages[0].attachments.every((a: any) => a.status === 'failed'));
  assert.deepEqual(fs.readdirSync(path.join(e.dir, 'files', 'tmp')), []);
}, { maxAttachmentBytes: 1000 });
run('默认拒绝从内网地址下载（防 SSRF）', async (e) => {
  e.mock.files.set('/file/a', { body: PNG });
  e.mock.say(U, 'x', { attachments: [{ content_type: 'image/png', url: e.mock.base + '/file/a' }, { content_type: 'image/png', url: 'https://127.0.0.1/a' }, { content_type: 'image/png', url: 'file:///etc/passwd' }] });
  await until(() => detail(e, 1).messages[0].attachments.every((a: any) => a.status === 'failed'));
}, { allowPrivateMedia: false });
run('聊天记录卡片没有内容时明确提醒，不静默', async (e) => {
  e.mock.say(U, '', { message_type: 102 });
  await e.reply(/没有把这条消息的内容发给我/);
  assert.equal(count(e), 1);
});

run('重复推送只记一次、指令也只执行一次', async (e) => {
  const m = e.mock.say(U, '导出失败'); e.mock.emit('C2C_MESSAGE_CREATE', m.event); e.mock.emit('C2C_MESSAGE_CREATE', m.event);
  await e.reply(/已记录 #1/);
  const c = e.mock.say(U, '/备注 一次'); e.mock.emit('C2C_MESSAGE_CREATE', c.event);
  const d = e.mock.say(U, '/补充 1 追加'); e.mock.emit('C2C_MESSAGE_CREATE', d.event);
  const n = e.mock.say(U, '/新建 另一个'); e.mock.emit('C2C_MESSAGE_CREATE', n.event);
  await e.reply(/已记录 #2/);
  await sleep(150);
  assert.equal(count(e), 2);
  assert.equal(detail(e, 1).messages.length, 3);
});
run('断线（4009）后 RESUME，断线期间的消息补发不丢', async (e) => {
  e.mock.say(U, '第一条'); await e.reply(/已记录 #1/);
  e.mock.closeSocket(4009);
  e.mock.say(U, '断线期间发的'); // 此时没有连接，只进平台历史
  await until(() => detail(e, 1).messages.length === 2);
  assert.ok(e.mock.log.some((l) => l.startsWith('resume:')));
});
run('服务重启期间的消息，启动后补发', async (e) => {
  e.mock.say(U, '重启前'); await e.reply(/已记录 #1/);
  await e.app.close();
  e.mock.say(U, '停机时发的');
  const { startApp } = await import('../src/app.js'); const { cfg } = await import('./helper.js');
  e.app = await startApp(cfg(e.mock, e.dir), { ocr: null, backoff: [20] });
  await until(() => detail(e, 1).messages.length === 2);
  assert.deepEqual(detail(e, 1).messages.map((m: any) => m.text), ['重启前', '停机时发的']);
});
run('落库失败时不推进 seq，恢复后由平台补发', async (e) => {
  const orig = e.app.intake.handle.bind(e.app.intake), write = fs.appendFileSync; let broken = true;
  e.app.intake.handle = (m) => { if (broken) throw new Error('disk full'); return orig(m); };
  (fs as any).appendFileSync = (...a: any[]) => { if (broken) throw new Error('ENOSPC'); return (write as any)(...a); };
  try {
    e.mock.say(U, '磁盘满时发的');
    await until(() => e.mock.log.filter((l) => l.startsWith('resume:')).length >= 2);
    broken = false;
    await until(() => count(e) === 1);
  } finally { (fs as any).appendFileSync = write; }
});
run('单条异常消息写入死信并告知，不阻塞后续', async (e) => {
  e.mock.emit('C2C_MESSAGE_CREATE', { id: 'bad' });
  e.mock.say(U, '正常消息');
  await e.reply(/已记录 #1/);
  assert.match(fs.readFileSync(path.join(e.dir, 'deadletter.jsonl'), 'utf8'), /"id":"bad"/);
});
run('会话失效（op 9 / 4006）重新登录；op 7 重连', async (e) => {
  e.mock.rejectResume = true; e.mock.closeSocket(4009);
  await until(() => e.mock.log.filter((l) => l.startsWith('identify')).length === 2 && e.mock.online);
  e.mock.closeSocket(4006);
  await until(() => e.mock.log.filter((l) => l.startsWith('identify')).length === 3 && e.mock.online);
  const n = e.mock.log.filter((l) => l === 'connect').length;
  e.mock.send({ op: 7 });
  await until(() => e.mock.log.filter((l) => l === 'connect').length > n && e.app.bot!.gateway.state === 'online');
  e.mock.say(U, '还能用'); await e.reply(/已记录/);
});
test('心跳无响应判定假死并重连', async () => {
  const e = await boot();
  try {
    e.mock.heartbeat = 40; e.mock.closeSocket(4009);
    await until(() => e.mock.log.filter((l) => l === 'heartbeat').length >= 3);
    e.mock.ackHeartbeat = false;
    const n = e.mock.log.filter((l) => l === 'connect').length;
    await until(() => e.mock.log.filter((l) => l === 'connect').length > n);
    e.mock.ackHeartbeat = true;
    await until(() => e.app.bot!.gateway.state === 'online');
  } finally { await e.stop(); }
});
run('被封禁/下架（4914/4915）显示原因，不疯狂重连', async (e) => {
  const n = e.mock.log.filter((l) => l === 'connect').length;
  e.mock.closeSocket(4915);
  await until(() => e.app.bot!.gateway.state === 'blocked');
  await sleep(150);
  assert.equal(e.mock.log.filter((l) => l === 'connect').length, n);
  assert.match(e.app.bot!.gateway.reason, /封禁/);
});
run('token 失效自动刷新重发；限流/5xx 重试', async (e) => {
  e.mock.say(U, '一'); await e.reply(/已记录 #1/);
  e.mock.validToken = 'tok-2';
  e.mock.say(U, '新建'); await e.reply(/新的一条/);
  e.mock.sendFailures.push({ status: 500, body: { message: 'x' } });
  e.mock.say(U, '帮助'); await e.reply(/反馈收集助手/);
});
run('平台审核拒发时改发精简回执；含链接的反馈也能回执', async (e) => {
  e.mock.sendFailures.push({ status: 400, body: { err_code: 40054010, message: '不允许' } });
  e.mock.say(U, '敏感内容'); await e.reply(/^✅ 已记录 #1$/);
  e.mock.say(U, '新建'); await e.reply(/新的一条/);
  e.mock.say(U, '打开 https://abc.com/x 报错'); await e.reply(/已记录 #2[\s\S]*\[链接\]/);
  assert.equal(detail(e, 2).messages[0].text, '打开 https://abc.com/x 报错');
});
run('凭据错误时网页照常可用，状态显示原因', async (e) => {
  e.mock.tokenFails = true; e.app.bot!.gateway.stop(); (e.app.bot as any).o.api.invalidateToken();
  e.app.bot!.gateway.start();
  await until(() => /invalid appid/.test(e.app.bot!.gateway.reason));
  assert.equal((await fetch(e.app.url + '/healthz')).status, 200);
  e.mock.tokenFails = false;
  await until(() => e.app.bot!.gateway.state === 'online');
});
run('加好友时发送欢迎语', async (e) => { e.mock.emit('FRIEND_ADD', { openid: U, timestamp: 1 }, 'FRIEND_ADD:1'); await e.reply(/反馈收集助手/); assert.equal(e.mock.sent[0]!.event_id, 'FRIEND_ADD:1'); });
run('并发压力：200 条消息（含 28 次断线）一条不丢、不重', async (e) => {
  for (let i = 0; i < 200; i++) { e.mock.say(U, `压力消息-${i}`); if (i % 7 === 6) { e.mock.closeSocket(4009); await sleep(15); } }
  await until(() => e.app.store.db.get(`SELECT COUNT(*) n FROM messages WHERE kind='report'`)!.n === 200, '200 条', 15000);
  await sleep(200);
  const texts = e.app.store.db.all(`SELECT text FROM messages ORDER BY id`).map((r) => r.text);
  assert.deepEqual(texts, Array.from({ length: 200 }, (_, i) => `压力消息-${i}`));
});
