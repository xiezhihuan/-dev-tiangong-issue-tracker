/** 演示模式：不需要 QQ 账号。启动真实系统 + 模拟 QQ 平台，在终端里打字就等于在 QQ 里发消息。 */
import '../src/node-version.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { readConfig } from '../src/config.js';
process.env.LOG_LEVEL = 'error';
const { startApp } = await import('../src/app.js');
const { MockQQ } = await import('../test/mock-qq.js');

const U = 'DEMO'.padEnd(32, '0');
const mock = new MockQQ();
await mock.start();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-demo-'));
const port = Number(process.env.PORT ?? 8799);
const app = await startApp({ ...readConfig({}), port, dataDir, adminPassword: 'demo-password', qq: { appId: 'app', secret: 'sec', apiBase: mock.base }, allowPrivateMedia: true, backupKeep: 0 });
app.store.db.run('INSERT INTO qq_users(openid,nickname,bound_at) VALUES(?,?,?)', U, '演示用户', Date.now());
app.store.saveTaxonomy('product', { name: '桌面端', keywords: '电脑版,客户端' });
const day = 86400_000;
for (const [ago, text, res] of [
  [40, '客户：王经理\n电脑版 V3.2.0 导出PDF提示文件损坏', '升级到 V3.2.2 后修复'], [33, '客户：李律师\n登录收不到短信验证码', '运营商拦截，改用语音验证码'],
  [21, '客户：赵总\n打印预览页眉错位', ''], [12, '客户：孙女士\n希望增加批量导出的功能', ''], [5, '客户：钱主任\n案件列表加载很慢，要等半分钟 V3.2.1', ''], [1, '客户：周律师\n手机收不到登录验证码', ''],
] as const) {
  const id = app.store.createFeedback(U, Date.now() - ago * day);
  app.store.addMessage(id, { channel: 'qq', author: U, kind: 'report', text, sentAt: Date.now() - ago * day, attachments: [] });
  if (res) app.store.update(id, { status: 'resolved', resolution: res }, U);
}
console.log(`网页后台：${app.url}   密码：demo-password\n在下面打字 = 在 QQ 里给机器人发消息；发图片用：图 /路径/截图.png；发「帮助」看指令；Ctrl+C 退出\n`);
let shown = 0;
setInterval(() => { while (shown < mock.sent.length) console.log('\x1b[32m机器人> ' + mock.sent[shown++]!.content.replace(/\n/g, '\n        ') + '\x1b[0m\n'); }, 100);
const rl = readline.createInterface({ input: process.stdin });
let n = 0;
rl.on('line', (l) => {
  const img = /^图\s+(.+)$/.exec(l.trim());
  if (img) {
    const f = img[1]!.replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ');
    if (!fs.existsSync(f)) return console.log('找不到文件：' + f);
    mock.files.set(`/file/${++n}`, { body: fs.readFileSync(f) });
    mock.say(U, '', { attachments: [{ content_type: 'image/png', filename: path.basename(f), url: `${mock.base}/file/${n}` }] });
  } else if (l.trim()) mock.say(U, l);
});
const quit = async () => { await app.close(); await mock.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(); };
process.on('SIGINT', quit); process.on('SIGTERM', quit);
