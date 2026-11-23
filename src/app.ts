import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startBackups } from './backup.js';
import type { Config } from './config.js';
import { Db } from './db.js';
import { Intake } from './intake.js';
import { Media } from './media.js';
import { createOcr, type Ocr } from './ocr.js';
import { QQApi } from './qq/api.js';
import { Bot } from './qq/bot.js';
import { Store } from './store.js';
import { createServer } from './web/server.js';

export interface App { store: Store; media: Media; intake: Intake; bot: Bot | null; server: FastifyInstance; url: string; close(): Promise<void> }

export async function startApp(config: Config, opts: { ocr?: Ocr | null; mediaRetry?: number[]; backoff?: number[] } = {}): Promise<App> {
  const db = new Db(path.join(config.dataDir, 'feedback.db'));
  const store = new Store(db);
  const media = new Media(store, { dataDir: config.dataDir, maxBytes: config.maxAttachmentBytes, allowPrivate: config.allowPrivateMedia, retry: opts.mediaRetry });
  media.ocr = opts.ocr !== undefined ? opts.ocr : config.ocr ? await createOcr() : null;
  const intake = new Intake(store, { mergeWindowMs: config.mergeWindowMs });
  const bot = config.qq.appId
    ? new Bot({ appId: config.qq.appId, api: new QQApi({ ...config.qq, base: config.qq.apiBase }), store, intake, media, dataDir: config.dataDir, receiptDelayMs: config.receiptDelayMs, backoff: opts.backoff })
    : null;
  const server = await createServer({ config, store, media, bot, startedAt: Date.now() });
  const url = await server.listen({ host: config.host, port: config.port });
  const stopBackups = startBackups(db, config.dataDir, config.backupKeep);
  media.start();
  bot?.start();
  return {
    store, media, intake, bot, server, url,
    async close() { stopBackups(); await bot?.stop(); await server.close(); await media.stop(); db.close(); },
  };
}
