// 服务进程的看护：启动、停止、崩溃退避重启、日志。
const { utilityProcess } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

// Windows 缺 SystemRoot 等变量时，加密和网络会初始化失败
const KEEP = ['PATH', 'Path', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];

class Service extends EventEmitter {
  constructor(home) { super(); this.home = home; this.state = 'stopped'; this.error = null; this.snap = null; this.child = null; this.fails = 0; this.calls = new Map(); this.seq = 0; this.queue = Promise.resolve(); }
  get logFile() { return path.join(this.home, 'logs', 'service.log'); }
  set(state, error = null) { this.state = state; this.error = error; if (state !== 'running') this.snap = null; this.emit('change'); }
  serial(fn) { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }

  start(env) { return this.serial(() => this.spawn(env)); }
  stop() {
    if (this.state === 'starting' && this.child) { this.stopping = true; this.child.kill(); } // 启动途中要停：不等它启动完
    return this.serial(() => this.kill());
  }
  restart(env) { return this.serial(async () => { await this.kill(); this.fails = 0; await this.spawn(env); }); }

  /** 就绪返回 true；启动失败返回 false，原因在 this.error。 */
  spawn(env) {
    clearTimeout(this.timer);
    if (this.child) return Promise.resolve(this.state === 'running');
    this.set('starting');
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    try { if (fs.statSync(this.logFile).size > 5 * 1024 * 1024) fs.renameSync(this.logFile, this.logFile + '.1'); } catch { /* 首次运行 */ }
    const out = fs.createWriteStream(this.logFile, { flags: 'a', mode: 0o600 });
    const child = utilityProcess.fork(path.join(__dirname, 'service-entry.mjs'), [], { stdio: 'pipe', serviceName: '天工反馈服务', env: { ...Object.fromEntries(KEEP.filter((k) => process.env[k]).map((k) => [k, process.env[k]])), ...env } });
    this.child = child;
    child.stdout.on('data', (d) => out.write(d));
    child.stderr.on('data', (d) => out.write(d));
    return new Promise((resolve) => {
      let failure = null;
      const slow = setTimeout(() => { failure ??= { code: 'timeout', message: '服务 60 秒内没有启动完成' }; child.kill(); }, 60_000);
      child.on('message', (m) => {
        if (child !== this.child) return;
        if (m.type === 'ready') { clearTimeout(slow); this.upAt = Date.now(); this.set('running'); resolve(true); }
        else if (m.type === 'snap') { this.snap = m.snap; this.emit('change'); }
        else if (m.type === 'new') this.emit('new', m);
        else if (m.type === 'fatal') failure = m;
        else if (m.type === 'reply') { const c = this.calls.get(m.id); this.calls.delete(m.id); if (c) m.error ? c.reject(new Error(m.error)) : c.resolve(m.value); }
      });
      child.on('exit', (code) => {
        clearTimeout(slow); out.end();
        for (const c of this.calls.values()) c.reject(new Error('服务已停止'));
        this.calls.clear();
        if (child !== this.child) return resolve(false);
        this.child = null;
        if (this.stopping) { this.stopping = false; this.set('stopped'); return resolve(false); }
        if (failure) { this.set('error', failure); return resolve(false); } // 配置或端口问题，重试也没用
        if (Date.now() - (this.upAt ?? 0) > 60_000) this.fails = 0;
        const wait = Math.min(2000 * 2 ** this.fails++, 60_000);
        this.set('error', { code: 'crash', message: `服务意外退出（${code}），${Math.round(wait / 1000)} 秒后自动重启` });
        this.timer = setTimeout(() => void this.start(env), wait);
        resolve(false);
      });
    });
  }
  async kill() {
    clearTimeout(this.timer);
    const child = this.child;
    if (!child) { if (this.state !== 'stopped') this.set('stopped'); return; }
    this.stopping = true;
    try {
      await new Promise((resolve) => {
        const t = setTimeout(() => child.kill(), 10_000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
        child.postMessage({ type: 'stop' });
      });
    } finally { this.stopping = false; }
  }
  call(op, ...args) {
    if (this.state !== 'running') return Promise.reject(new Error('服务没有在运行'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.calls.set(id, { resolve, reject }); this.child.postMessage({ type: 'call', id, op, args }); });
  }
}
module.exports = { Service };
