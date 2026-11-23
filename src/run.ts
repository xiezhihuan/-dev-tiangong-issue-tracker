import { startApp } from './app.js';
import { loadEnvFile, readConfig, validateConfig } from './config.js';
import { accessUrls } from './web/access.js';
import { logger } from './log.js';

const log = logger('main');
try {
  loadEnvFile();
  const config = readConfig();
  const errs = validateConfig(config);
  if (errs.length) { for (const e of errs) log.error(`配置错误：${e}`); process.exit(1); }
  const app = await startApp(config);
  log.info(`网页后台：${app.url}`);
  for (const a of accessUrls(config, new URL(app.url).port)) log.info(`手机访问：${a.url}`);
  log.info(`MCP：${config.publicUrl || app.url}/mcp`);
  if (!app.bot) log.warn('未配置 QQ 机器人，仅网页可用');
  let closing = false;
  const stop = () => { if (closing) process.exit(1); closing = true; log.info('正在停止…'); app.close().then(() => process.exit(0), (e) => { log.error('停止异常', e); process.exit(1); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (e) {
  log.error('启动失败', e);
  process.exit(1);
}
