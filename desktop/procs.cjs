// 查进程：谁占了端口、谁开着数据库、命令行是什么。只用系统自带命令，macOS 与 Windows 各一套。
const { execFile } = require('node:child_process');
const path = require('node:path');

const WIN = process.platform === 'win32';
const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => ok(String(out ?? ''))));
const sys = (f) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', f);
/** 输出统一 UTF-8，避免中文路径乱码。 */
const ps = (script) => run(sys('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`]);

/** 命令行；Windows 上权限不够看不到时退回程序名。 */
async function command(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return '';
  if (!WIN) return (await run('/bin/ps', ['-p', String(n), '-o', 'command='])).trim();
  return (await ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${n}'; if($p){ if($p.CommandLine){$p.CommandLine}else{$p.Name} }`)).trim();
}
/** netstat 的状态列随系统语言变化，监听行靠「对端端口为 0」识别。 */
function parseNetstat(out, port) {
  for (const l of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+:0\s+\S+\s+(\d+)\s*$/i.exec(l);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return 0;
}
async function listener(port) {
  if (!WIN) return Number((await run('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])).split('\n')[0]);
  return parseNetstat(await run(sys('netstat.exe'), ['-ano']), port);
}
/** 从命令行取程序名：路径可能带空格（Windows 会加引号）。 */
function programName(cmd) {
  const m = /^"([^"]+)"/.exec(cmd) ?? /^(\S+)/.exec(cmd);
  return m ? m[1].split(/[\\/]/).pop() : '';
}
const OLD = /\bnode(?:\.exe)?"?\s.*(?:dist[\\/]main\.js|src[\\/]main\.ts)/i;

/** 命令行像、并且正打开着 feedback.db 才算本项目旧版；很多别的项目也叫 dist/main.js，绝不能误结束。 */
async function isOld(pid) {
  if (!OLD.test(await command(pid))) return false;
  if (!WIN) return /\/feedback\.db$/m.test(await run('/usr/sbin/lsof', ['-p', String(pid), '-Fn']));
  return false; // Windows 没有可靠办法确认它开着哪个文件，宁可让用户自己关
}
/** 正在使用这个数据库的旧版服务。 */
async function usersOf(db) {
  if (WIN) return []; // Windows 上由 importer 通过旧版端口判断
  const out = [];
  for (const pid of new Set((await run('/usr/sbin/lsof', ['-t', '--', db])).split('\n').filter(Boolean).map(Number))) if (pid !== process.pid && (await isOld(pid))) out.push(pid);
  return out;
}
module.exports = { WIN, command, listener, parseNetstat, programName, isOld, usersOf, OLD };
