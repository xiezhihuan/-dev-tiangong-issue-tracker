// 导入旧版（源码运行）的数据：数据库用 VACUUM INTO 取一致快照，附件整目录复制。只读取，不改动旧目录。
const fs = require('node:fs');
const path = require('node:path');
const procs = require('./procs.cjs');
const { parseEnv } = require('./settings.cjs');

/** 选中项目目录或 data 目录都可以。 */
function locate(dir) {
  for (const d of [dir, path.join(dir, 'data')]) {
    const db = path.join(d, 'feedback.db');
    if (fs.existsSync(db)) return { dataDir: fs.realpathSync(d), db: fs.realpathSync(db), envFile: [path.join(d, '..', '.env'), path.join(d, '.env')].find((f) => fs.existsSync(f)) ?? '' };
  }
  return null;
}
/** 占用端口的进程。 */
async function portOwner(port) {
  const pid = await procs.listener(port);
  if (!pid) return null;
  const command = await procs.command(pid);
  return { pid, command, name: procs.programName(command) || '未知程序' };
}
/** 旧版是否还在运行：macOS 给出进程号；Windows 看旧版端口上答话的是不是本服务（pid 为 0，需用户自己关）。 */
async function running(from) {
  const pid = (await procs.usersOf(from.db))[0];
  if (pid) return { pid };
  if (!procs.WIN || !from.env) return null;
  try { const d = await (await fetch(`http://127.0.0.1:${from.env.port}/healthz`, { signal: AbortSignal.timeout(2000) })).json(); return d?.ok === true && 'bot' in d ? { pid: 0 } : null; } catch { return null; }
}
async function stopOld(pid) {
  if (!(await procs.isOld(pid))) throw new Error('这不是旧版服务，请手动处理');
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 100)); try { process.kill(pid, 0); } catch { return; } }
  throw new Error('旧版服务没有在 10 秒内退出');
}
function inspect(dir) {
  const at = locate(dir);
  if (!at) throw new Error('这里没有找到 feedback.db，请选择旧版的项目文件夹或其中的 data 文件夹');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(at.db, { readOnly: true });
  try {
    const n = (t) => Number(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
    return { ...at, issues: n('feedbacks'), attachments: n('attachments'), users: n('qq_users'), env: at.envFile ? parseEnv(fs.readFileSync(at.envFile, 'utf8')) : null };
  } finally { db.close(); }
}
function copy(from, toDir) {
  const { DatabaseSync } = require('node:sqlite');
  const target = path.join(toDir, 'feedback.db');
  if (fs.existsSync(target)) throw new Error('本机已有数据，为避免覆盖不能再导入');
  fs.mkdirSync(toDir, { recursive: true, mode: 0o700 });
  const tmp = target + '.importing';
  fs.rmSync(tmp, { force: true });
  const db = new DatabaseSync(from.db, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(tmp); } finally { db.close(); }
  const files = path.join(from.dataDir, 'files');
  if (fs.existsSync(files)) fs.cpSync(files, path.join(toDir, 'files'), { recursive: true });
  fs.renameSync(tmp, target); // 最后才就位：中途失败不会留下半份数据
}
module.exports = { inspect, copy, running, portOwner, isOld: procs.isOld, stopOld };
