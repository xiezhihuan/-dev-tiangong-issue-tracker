import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { DEFAULT_CATEGORIES } from './defaults.js';

export type Row = Record<string, any>;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE qq_users (openid TEXT PRIMARY KEY, nickname TEXT NOT NULL DEFAULT '', bound_at INTEGER NOT NULL);

  -- 分类与产品：keywords 为逗号分隔，用于自动识别
  CREATE TABLE taxonomy (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('category','product')),
    name TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, UNIQUE (kind, name));

  -- 同类问题：多条反馈归并到一个问题，沉淀原因与解决方案
  CREATE TABLE topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, root_cause TEXT NOT NULL DEFAULT '', solution TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

  CREATE TABLE feedbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', title_auto INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','doing','resolved','closed')),
    severity TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('urgent','high','normal','low')),
    category TEXT NOT NULL DEFAULT '', category_auto INTEGER NOT NULL DEFAULT 1,
    product TEXT NOT NULL DEFAULT '', product_auto INTEGER NOT NULL DEFAULT 1,
    version TEXT NOT NULL DEFAULT '', version_auto INTEGER NOT NULL DEFAULT 1,
    reporter TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '微信',
    resolution TEXT NOT NULL DEFAULT '', topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER, deleted_at INTEGER,
    search_text TEXT NOT NULL DEFAULT '');
  CREATE INDEX feedbacks_created ON feedbacks(created_at);
  CREATE INDEX feedbacks_topic ON feedbacks(topic_id);

  CREATE TABLE feedback_tags (feedback_id INTEGER NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (feedback_id, tag));

  -- 原始素材：一条反馈由多条消息组成；raw 保留平台原始 JSON
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, feedback_id INTEGER REFERENCES feedbacks(id) ON DELETE SET NULL,
    channel TEXT NOT NULL, dedupe_key TEXT UNIQUE, author TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('report','note','command')),
    text TEXT NOT NULL DEFAULT '', raw TEXT, sent_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX messages_feedback ON messages(feedback_id);

  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image','voice','video','file')),
    filename TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
    url TEXT, path TEXT, sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT,
    ocr_status TEXT NOT NULL DEFAULT 'none' CHECK (ocr_status IN ('none','pending','done','failed')),
    text TEXT NOT NULL DEFAULT '');
  CREATE INDEX attachments_message ON attachments(message_id);
  CREATE INDEX attachments_queue ON attachments(status, next_at);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, feedback_id INTEGER NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
    at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
  CREATE INDEX events_feedback ON events(feedback_id);

  -- QQ 引用索引 → 反馈编号，用于「引用某条消息补充」
  CREATE TABLE qq_refs (ref TEXT PRIMARY KEY, feedback_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(readonly file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  private migrate(): void {
    const v = Number(this.get('PRAGMA user_version')!.user_version);
    if (v > MIGRATIONS.length) throw new Error(`数据库版本 ${v} 高于程序支持的 ${MIGRATIONS.length}，请升级程序`);
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[i]!);
        if (i === 0) DEFAULT_CATEGORIES.forEach(([name, kw], n) => this.run(`INSERT INTO taxonomy(kind,name,keywords,sort) VALUES('category',?,?,?)`, name, kw, n));
        this.raw.exec(`PRAGMA user_version=${i + 1}`);
      });
    }
  }

  all<T = Row>(sql: string, ...args: SQLInputValue[]): T[] { return this.raw.prepare(sql).all(...args) as T[]; }
  get<T = Row>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.raw.prepare(sql).get(...args) as T | undefined; }
  run(sql: string, ...args: SQLInputValue[]): { id: number; changes: number } {
    const r = this.raw.prepare(sql).run(...args);
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }

  /** 事务；可嵌套（内层并入外层）。 */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  kvGet(key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM kv WHERE key=?', key)?.value; }
  kvSet(key: string, value: string): void { this.run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }
  kvDel(key: string): void { this.run('DELETE FROM kv WHERE key=?', key); }
  close(): void { this.raw.close(); }
}
