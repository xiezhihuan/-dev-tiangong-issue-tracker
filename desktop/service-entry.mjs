// 在独立的 utilityProcess 里运行真正的服务；与主进程只通过消息通信。
import { startApp } from './server/dist/app.js';
import { readConfig, validateConfig } from './server/dist/config.js';
import { Tokens } from './server/dist/mcp/http.js';
import { accessUrls } from './server/dist/web/access.js';

const port = process.parentPort;
const send = (m) => port.postMessage(m);
const fatal = (code, message) => { send({ type: 'fatal', code, message }); setTimeout(() => process.exit(2), 100); };

const config = readConfig(), errs = validateConfig(config);
let app;
if (errs.length) fatal('config', errs.join('；'));
else try {
  app = await startApp(config);
} catch (e) {
  fatal(e.code === 'EADDRINUSE' ? 'port' : e.code ?? 'start', e.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用` : e.message);
}

if (app) {
  const { store } = app, one = (sql, ...a) => store.db.get(sql, ...a), boundPort = new URL(app.url).port;
  let last = '', maxId = Number(one('SELECT COALESCE(MAX(id),0) n FROM feedbacks').n);
  const tick = () => {
    const snap = {
      url: `http://127.0.0.1:${boundPort}`, access: accessUrls(config, boundPort),
      bot: app.bot ? { state: app.bot.gateway.state, reason: app.bot.gateway.reason } : { state: 'disabled', reason: '' },
      ocr: app.media.ocr ? 'ready' : config.ocr ? 'unavailable' : 'disabled',
      users: store.db.all('SELECT openid,nickname,bound_at FROM qq_users ORDER BY bound_at'),
      total: Number(one('SELECT COUNT(*) n FROM feedbacks WHERE deleted_at IS NULL').n),
      todo: Number(one(`SELECT COUNT(*) n FROM feedbacks WHERE deleted_at IS NULL AND status IN ('open','doing')`).n),
      today: Number(one('SELECT COUNT(*) n FROM feedbacks WHERE deleted_at IS NULL AND created_at>=?', new Date().setHours(0, 0, 0, 0)).n),
      failed: Number(one(`SELECT COUNT(*) n FROM attachments WHERE status='failed'`).n),
      tokens: new Tokens(store).list(),
    };
    const s = JSON.stringify(snap);
    if (s !== last) { last = s; send({ type: 'snap', snap }); }
    // 等回执（附件、识别）差不多了再通知，标题更准
    for (const f of store.db.all(`SELECT f.id,f.title FROM feedbacks f WHERE f.id>? AND f.deleted_at IS NULL AND f.updated_at<? AND EXISTS(SELECT 1 FROM messages m WHERE m.feedback_id=f.id AND m.channel='qq') ORDER BY f.id`, maxId, Date.now() - 4000)) { maxId = f.id; send({ type: 'new', id: f.id, title: f.title }); }
  };
  const timer = setInterval(() => { try { tick(); } catch (e) { console.error(e); } }, 1500);
  tick(); // 先有状态再报就绪，主进程收到就绪就能直接打开问题库
  send({ type: 'ready' });
  const ops = {
    bindCode: () => store.createBindCode(),
    unbind: (openid) => { store.db.run('DELETE FROM qq_users WHERE openid=?', String(openid)); },
    createToken: (name) => new Tokens(store).create(String(name)),
    removeToken: (id) => { new Tokens(store).remove(Number(id)); },
  };
  let closing = false;
  port.on('message', async ({ data: m }) => {
    if (m.type === 'stop') {
      if (closing) return;
      closing = true; clearInterval(timer);
      await app.close().catch((e) => console.error(e));
      process.exit(0);
    }
    if (m.type === 'call') {
      try { if (!Object.hasOwn(ops, m.op)) throw new Error('未知操作'); const value = ops[m.op](...m.args); tick(); send({ type: 'reply', id: m.id, value: value ?? null }); } catch (e) { send({ type: 'reply', id: m.id, error: e.message }); }
    }
  });
}
