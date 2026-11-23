/** 自检：npm run doctor —— 校验配置、QQ 凭据、网关、OCR、目录权限。不发送任何消息。 */
import './node-version.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, readConfig, validateConfig } from './config.js';
import { createOcr } from './ocr.js';
import { QQApi } from './qq/api.js';

loadEnvFile();
const c = readConfig();
let bad = 0;
const check = async (name: string, fn: () => unknown) => {
  try { console.log(`✅ ${name}：${(await fn()) ?? '正常'}`); } catch (e) { bad++; console.log(`❌ ${name}：${(e as Error).message}`); }
};
await check('Node 版本', () => process.version);
await check('配置', () => { const e = validateConfig(c); if (e.length) throw new Error(e.join('；')); });
await check('数据目录可写', () => { fs.mkdirSync(c.dataDir, { recursive: true }); const f = path.join(c.dataDir, '.w'); fs.writeFileSync(f, ''); fs.rmSync(f); return c.dataDir; });
await check('OCR', async () => { if (!c.ocr) return '已关闭'; if (!(await createOcr())) throw new Error('不可用（不影响收录，只是截图无法被搜索）'); });
if (!c.qq.appId) { bad++; console.log('❌ QQ 机器人：未填写 QQ_APP_ID / QQ_APP_SECRET'); }
else {
  const api = new QQApi({ ...c.qq, base: c.qq.apiBase });
  await check('QQ 凭据（获取 access_token）', async () => { await api.getToken(); });
  await check('QQ 网关地址', () => api.gatewayUrl());
  await check('机器人身份', async () => (await api.me()).username);
}
process.exit(bad ? 1 : 0);
