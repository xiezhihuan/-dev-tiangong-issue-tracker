import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { logger } from './log.js';

const log = logger('backup');
const stamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 每天一份数据库快照（VACUUM INTO，一致性备份）。附件按内容寻址只增不改，直接同步 data/files 即可。 */
export function backupOnce(db: Db, dataDir: string, keep: number): string | null {
  if (keep <= 0) return null;
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp()}.db`);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.tmp`;
    fs.rmSync(tmp, { force: true });
    db.run('VACUUM INTO ?', tmp);
    fs.renameSync(tmp, file);
    log.info(`已备份 ${file}`);
  }
  for (const old of fs.readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.db$/.test(f)).sort().slice(0, -keep)) fs.rmSync(path.join(dir, old));
  return file;
}
export function startBackups(db: Db, dataDir: string, keep: number): () => void {
  const run = () => { try { backupOnce(db, dataDir, keep); } catch (e) { log.error('备份失败', e); } };
  run();
  const t = setInterval(run, 3600_000);
  t.unref();
  return () => clearInterval(t);
}
