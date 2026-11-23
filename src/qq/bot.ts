import fs from 'node:fs';
import path from 'node:path';
import { HELP, type Intake } from '../intake.js';
import { logger } from '../log.js';
import type { Media } from '../media.js';
import type { Store } from '../store.js';
import type { QQApi } from './api.js';
import { Gateway, type Payload, type Session } from './gateway.js';
import { parseC2C, sanitizeReply } from './message.js';

const log = logger('qq-bot');
const SETTLE_MS = 12_000;

/** 把网关、收录逻辑、回执串起来。 */
export class Bot {
  readonly gateway: Gateway;
  private seq = new Map<string, number>();
  private pending = new Map<string, { id: number; msgId: string; timer: NodeJS.Timeout }>();
  private inflight = new Set<Promise<unknown>>();

  constructor(private o: { appId: string; api: QQApi; store: Store; intake: Intake; media: Media; dataDir: string; receiptDelayMs: number; backoff?: number[] }) {
    const db = o.store.db, key = `qq_session:${o.appId}`;
    this.gateway = new Gateway({
      getToken: () => o.api.getToken(), invalidateToken: () => o.api.invalidateToken(), getUrl: () => o.api.gatewayUrl(),
      loadSession: () => JSON.parse(db.kvGet(key) ?? 'null') as Session | null,
      saveSession: (s) => (s ? db.kvSet(key, JSON.stringify(s)) : db.kvDel(key)),
      onDispatch: (p) => this.onDispatch(p),
      onState: (s, r) => log.info(`状态：${s}${r ? ` ${r}` : ''}`),
      backoff: o.backoff,
    });
  }

  start(): void { this.gateway.start(); }
  /** 停机前把攒着的回执发完。 */
  async stop(): Promise<void> {
    this.gateway.stop();
    for (const openid of [...this.pending.keys()]) this.flush(openid);
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, 5000))]);
  }

  private onDispatch(p: Payload): void {
    if (p.t === 'C2C_MESSAGE_CREATE') {
      let openid = '', msgId = '', out;
      try {
        const m = parseC2C(p.d);
        ({ openid, msgId } = m);
        out = this.o.intake.handle(m);
      } catch (e) {
        // 单条消息异常不能卡住后续消息：原样写入死信文件后继续；连死信都写不进去才抛出，由网关断线补发
        const file = path.join(this.o.dataDir, 'deadletter.jsonl');
        fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), error: String(e), payload: p }) + '\n');
        log.error(`消息处理异常，已写入 ${file}`, e);
        if (openid) this.reply(openid, msgId, '⚠️ 这条消息处理出错，原始内容已保存到服务器的 deadletter.jsonl，没有生成反馈，请换个方式重发。');
        return;
      }
      if (out.receipt !== undefined) { this.schedule(openid, out.receipt, msgId); this.o.media.kick(); }
      if (out.reply) {
        if (out.receipt === undefined) this.flush(openid); // 指令前先把攒着的回执发出，顺序不乱
        this.reply(openid, msgId, out.reply, out.feedbackId);
        this.o.media.kick();
      }
    } else if (p.t === 'FRIEND_ADD') {
      const openid = p.d?.openid;
      if (openid && p.id) this.track(this.send(openid, { eventId: p.id }, this.o.intake.isBound(openid) ? HELP : '👋 你好，我是反馈收集助手。请先在网页后台「设置 → QQ 账号」生成绑定码，然后发送：绑定 12345678'));
    }
  }

  private schedule(openid: string, id: number, msgId: string): void {
    const cur = this.pending.get(openid);
    if (cur && cur.id !== id) this.flush(openid);
    else if (cur) clearTimeout(cur.timer);
    this.pending.set(openid, { id, msgId, timer: setTimeout(() => this.flush(openid), this.o.receiptDelayMs) });
  }
  private flush(openid: string): void {
    const p = this.pending.get(openid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(openid);
    this.track((async () => {
      await this.o.media.settle(p.id, SETTLE_MS);
      if (this.o.store.require(p.id).deleted_at) return;
      await this.send(openid, { msgId: p.msgId }, this.o.intake.receipt(p.id), p.id, `✅ 已记录 #${p.id}`);
    })());
  }

  private reply(openid: string, msgId: string, text: string, feedbackId?: number): void {
    this.track(this.send(openid, { msgId }, text, feedbackId, feedbackId ? `✅ 操作成功（#${feedbackId}），详细内容因平台限制无法显示，请到后台查看` : '内容因平台限制无法显示，请到后台查看'));
  }
  private track(p: Promise<unknown>): void {
    const t = p.catch((e) => log.error('回复发送失败（消息本身已入库）', e)).finally(() => this.inflight.delete(t));
    this.inflight.add(t);
  }

  /** 平台可能因内容审核拒发，此时退回到最短回执，保证用户知道已记录。 */
  private async send(openid: string, ref: { msgId?: string; eventId?: string }, text: string, feedbackId?: number, fallback?: string): Promise<void> {
    const key = ref.msgId ?? ref.eventId!;
    const post = async (t: string) => {
      const seq = (this.seq.get(key) ?? 0) + 1;
      this.seq.set(key, seq);
      if (this.seq.size > 2000) this.seq.delete(this.seq.keys().next().value!);
      return this.o.api.replyC2C(openid, sanitizeReply(t), { ...ref, seq });
    };
    let refIdx: string | undefined;
    try { refIdx = await post(text); } catch (e) {
      if (!fallback) throw e;
      log.warn(`完整回复发送失败，改发精简回执：${(e as Error).message}`);
      refIdx = await post(fallback);
    }
    if (refIdx && feedbackId) this.o.intake.rememberRef(refIdx, feedbackId);
  }
}
