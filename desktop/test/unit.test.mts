import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Settings, parseEnv, normalizeUrl, randomPassword } = require('../settings.cjs');
const importer = require('../importer.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tgd-'));
const crypt = { encrypt: (s: string) => Buffer.from([...s].reverse().join('')), decrypt: (b: Buffer) => [...b.toString()].reverse().join('') };
const good = { qqAppId: '12345', qqSecret: 'topsecret', adminPassword: 'password-1' };

test('设置：校验、保存、重读；密钥不落明文、界面拿不到', () => {
  const d = tmp(), s = new Settings(d, crypt), bad = (p: object, f: string) => assert.throws(() => s.save({ ...good, ...p }), (e: any) => e.field === f, `${f}`);
  bad({ qqAppId: 'abc' }, 'qqAppId'); bad({ qqSecret: '' }, 'qqSecret'); bad({ adminPassword: 'short' }, 'adminPassword'); bad({ port: 80 }, 'port'); bad({ port: 1.5 }, 'port'); bad({ port: NaN }, 'port'); bad({ scope: 'all' }, 'scope'); bad({ mergeMinutes: NaN }, 'mergeMinutes');
  bad({ publicUrl: 'https://a.cn/x' }, 'publicUrl'); bad({ publicUrl: 'ftp://a.cn' }, 'publicUrl'); bad({ publicUrl: 'a.cn' }, 'adminPassword');
  assert.throws(() => s.save({ ...good, hack: 1 }));
  assert.equal(fs.existsSync(path.join(d, 'config.json')), false, '校验失败不写盘');
  s.save({ ...good, adminPassword: 'password-long-1', publicUrl: 'fb.example.com' });
  assert.equal(s.v.publicUrl, 'https://fb.example.com');
  const disk = fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join();
  assert.ok(!disk.includes('topsecret') && !disk.includes('password-long-1'));
  assert.equal(fs.statSync(path.join(d, 'secrets.json')).mode & 0o777, 0o600);
  const r = new Settings(d, crypt);
  assert.ok(r.view().hasSecret && !JSON.stringify(r.view()).includes('topsecret'));
  r.save({ qqSecret: '', port: 9000 });
  assert.deepEqual([r.env().QQ_APP_SECRET, r.env().PORT, r.env().HOST, r.env().TRUST_PROXY], ['topsecret', '9000', '0.0.0.0', 'loopback']);
  r.save({ skipQQ: true, scope: 'local' });
  assert.deepEqual([r.env().QQ_APP_ID, r.env().QQ_APP_SECRET, r.env().HOST], ['', '', '127.0.0.1']);
  const broken = new Settings(d, { ...crypt, decrypt: () => { throw new Error('拒绝'); } });
  assert.match(broken.view().secretError, /拒绝/); assert.equal(broken.view().hasPassword, false);
  fs.writeFileSync(path.join(d, 'config.json'), '{坏');
  assert.equal(new Settings(d, crypt).v.port, 8787, '配置损坏时用默认值');
});
test('旧版 .env 与地址解析', () => {
  assert.deepEqual(parseEnv('# x\nADMIN_PASSWORD="a b"\nQQ_APP_ID=1\n  PORT = 9001 \n'), { qqAppId: '1', qqSecret: '', adminPassword: 'a b', port: 9001, publicUrl: '' });
  assert.equal(parseEnv('ADMIN_PASSWORD=change-me-please').adminPassword, '');
  assert.equal(normalizeUrl(' https://a.cn/ '), 'https://a.cn'); assert.equal(normalizeUrl(''), '');
  assert.match(randomPassword(), /^[a-z2-9]{12}$/);
});
test('导入：找不到报错；已有数据不覆盖', () => {
  assert.throws(() => importer.inspect(tmp()), /没有找到/);
  const d = tmp(); fs.writeFileSync(path.join(d, 'feedback.db'), '');
  assert.throws(() => importer.copy({ db: path.join(d, 'feedback.db'), dataDir: d }, d), /已有数据/);
});
test('绝不结束别的程序：同名 dist/main.js 但没打开 feedback.db', async () => {
  const d = tmp(); fs.mkdirSync(path.join(d, 'dist'));
  fs.writeFileSync(path.join(d, 'dist/main.js'), `require('net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)})`);
  const p = spawn(process.execPath, ['dist/main.js'], { cwd: d });
  const port = Number(await new Promise((ok) => p.stdout.once('data', (x) => ok(String(x)))));
  try {
    assert.equal((await importer.portOwner(port)).pid, p.pid);
    assert.equal(await importer.isOld(p.pid), false);
    await assert.rejects(importer.stopOld(p.pid), /不是旧版/);
    await new Promise<void>((ok, no) => net.connect(port, '127.0.0.1', () => ok()).on('error', no));
  } finally { p.kill(); }
});
const procs = require('../procs.cjs');
test('Windows：解析 netstat（中英文）、程序名、旧版命令行', () => {
  const out = '\r\n活动连接\r\n\r\n  协议  本地地址          外部地址        状态           PID\r\n  TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       4321\r\n  TCP    0.0.0.0:87870          0.0.0.0:0              侦听            9\r\n  TCP    192.168.1.5:8788       1.2.3.4:443            ESTABLISHED     77\r\n  TCP    [::]:8789              [::]:0                 侦听            55\r\n';
  assert.deepEqual([8787, 8788, 8789, 8790].map((p) => procs.parseNetstat(out, p)), [4321, 0, 55, 0]);
  assert.equal(procs.programName('"C:\\Program Files\\nodejs\\node.exe" dist\\main.js'), 'node.exe');
  assert.equal(procs.programName('/usr/local/bin/node x'), 'node'); assert.equal(procs.programName(''), '');
  assert.ok(procs.OLD.test('"C:\\Program Files\\nodejs\\node.exe" dist\\main.js')); assert.ok(procs.OLD.test('node --x dist/main.js')); assert.ok(!procs.OLD.test('node server.js'));
});
test('不把非法 PID 拼进命令', async () => { for (const x of ['1; calc', -1, 0, 1.5, NaN, undefined]) assert.equal(await procs.command(x), ''); });
