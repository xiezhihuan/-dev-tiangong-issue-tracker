import crypto from 'node:crypto';
import type { Row } from '../db.js';
import { UserError, type Store } from '../store.js';

export type McpScope = 'issue' | 'all';
export interface McpIdentity { id: number; name: string; permission: number }
export interface McpAuthorization { id: number; scope: McpScope; issueId: number | null; issuer: string; issuerPermission: number; expiresAt: number }

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const publicRow = (r: Row): McpAuthorization => ({ id: r.id, scope: r.scope, issueId: r.issue_id ?? null, issuer: r.issuer, issuerPermission: r.issuer_permission, expiresAt: r.expires_at });

/** 管理界面签发的短期 MCP 写入授权。明文只在 create 的返回值中出现一次。 */
export class Authorizations {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  create(scope: McpScope, issueId: number | undefined, issuer: string, issuerPermission = 1, ttlMs = 10 * 60_000): { code: string; authorization: McpAuthorization } {
    if (scope === 'issue') {
      if (!Number.isSafeInteger(issueId) || !issueId) throw new UserError('请指定有效的问题编号');
      const issue = this.store.require(issueId);
      if (issue.deleted_at) throw new UserError('已删除的问题不能签发授权');
    } else if (issueId !== undefined) {
      throw new UserError('全部问题授权不能带问题编号');
    }
    if (!issuer.trim()) throw new UserError('授权人无效');
    const ttl = Math.min(Math.max(ttlMs, 60_000), 15 * 60_000);
    const code = `tga_${crypto.randomBytes(24).toString('base64url')}`;
    const exp = this.now() + ttl;
    const id = this.store.db.run(
      'INSERT INTO mcp_authorizations(hash,scope,issue_id,issuer,issuer_permission,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
      hash(code), scope, scope === 'issue' ? issueId! : null, issuer.trim(), issuerPermission, this.now(), exp,
    ).id;
    return { code, authorization: { id, scope, issueId: scope === 'issue' ? issueId! : null, issuer: issuer.trim(), issuerPermission, expiresAt: exp } };
  }

  list(): Row[] {
    return this.store.db.all(`SELECT id,scope,issue_id,issuer,issuer_permission,created_at,expires_at,revoked_at
      FROM mcp_authorizations ORDER BY id DESC`).map((r) => ({ ...r, active: !r.revoked_at && r.expires_at > this.now() }));
  }

  auditList(limit = 100): Row[] {
    return this.store.db.all(`SELECT id,at,authorization_id,token_id,token_name,issuer,source,operation,issue_id,topic_id,success,detail
      FROM mcp_audit ORDER BY id DESC LIMIT ?`, Math.min(Math.max(limit, 1), 500));
  }

  revoke(id: number): void {
    this.store.db.run('UPDATE mcp_authorizations SET revoked_at=? WHERE id=? AND revoked_at IS NULL', this.now(), id);
  }

  authorize(code: string, identity: McpIdentity, target: { issueId?: number; topicId?: number }, operation: string): McpAuthorization {
    const row = this.store.db.get('SELECT * FROM mcp_authorizations WHERE hash=?', hash(code));
    const fail = (message = '授权码无效、已过期或已撤销') => { this.audit(row?.id ?? null, identity, row?.issuer ?? '', operation, target, false, message); throw new UserError(message, 403); };
    if (!row || row.revoked_at || row.expires_at <= this.now()) return fail();
    if (identity.permission < row.issuer_permission) return fail('MCP 身份权限低于签发人的权限');
    if (row.scope === 'issue' && target.issueId !== row.issue_id) return fail('授权码不包含该问题');
    if (row.scope === 'issue' && target.topicId !== undefined) return fail('单问题授权不能修改同类问题');
    const grant = publicRow(row);
    return grant;
  }

  audit(authorizationId: number | null, identity: McpIdentity, issuer: string, operation: string, target: { issueId?: number; topicId?: number }, success: boolean, detail: string): void {
    this.store.db.run(`INSERT INTO mcp_audit(at,authorization_id,token_id,token_name,issuer,source,operation,issue_id,topic_id,success,detail)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, this.now(), authorizationId, identity.id, identity.name, issuer, 'MCP', operation,
      target.issueId ?? null, target.topicId ?? null, success ? 1 : 0, detail.slice(0, 500));
  }

  recordResult(authorizationId: number, identity: McpIdentity, issuer: string, operation: string, target: { issueId?: number; topicId?: number }, success: boolean, detail: string): void {
    this.store.db.run(`INSERT INTO mcp_audit(at,authorization_id,token_id,token_name,issuer,source,operation,issue_id,topic_id,success,detail)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, this.now(), authorizationId, identity.id, identity.name, issuer, 'MCP', operation,
      target.issueId ?? null, target.topicId ?? null, success ? 1 : 0, detail.slice(0, 500));
  }
}

