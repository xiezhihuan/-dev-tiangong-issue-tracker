// 打包：node build.mjs [mac|win]，默认当前系统。产物在 release/（可用 TG_OUT 换目录）。
// mac 只能在 macOS 上打（当前机器的架构，.app + .dmg）；win 在 macOS 或 Windows 上都能打（x64，NSIS 安装包）。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const target = process.argv[2] ?? (process.platform === 'win32' ? 'win' : 'mac');
if (!['mac', 'win'].includes(target)) throw new Error('用法：node build.mjs [mac|win]');
if (target === 'mac' && process.platform !== 'darwin') throw new Error('mac 版只能在 macOS 上打包');
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const NAME = '天工反馈', ID = 'com.tiangong.feedback', PLATFORM = target === 'mac' ? 'darwin' : 'win32', ARCH = target === 'mac' ? process.arch : 'x64';
const stage = path.join(here, `build/${target}`), tmpOut = path.join(here, `build-out/${target}`), out = process.env.TG_OUT ? path.resolve(process.env.TG_OUT) : path.join(here, 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(fs.readFileSync(path.join(here, 'node_modules/electron/package.json'), 'utf8')).version;
const sh = (c, a, o = {}) => execFileSync(c, a, { stdio: 'inherit', ...o });
const npm = (a, cwd) => sh(process.platform === 'win32' ? 'npm.cmd' : 'npm', a, { cwd, shell: process.platform === 'win32', env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip', ONNXRUNTIME_NODE_INSTALL: 'skip' } });
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
for (const d of [stage, tmpOut]) rm(d);
fs.mkdirSync(out, { recursive: true });

console.log(`1/4 准备服务（${PLATFORM}-${ARCH}）`);
const srv = path.join(stage, 'server');
fs.mkdirSync(srv, { recursive: true });
npm(['run', '-s', 'build'], root);
for (const f of ['package.json', 'package-lock.json', 'dist', 'public', 'models']) fs.cpSync(path.join(root, f), path.join(srv, f), { recursive: true });
// 按目标系统装依赖；依赖都带预编译文件，不需要安装脚本
npm(['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', `--os=${PLATFORM}`, `--cpu=${ARCH}`], srv);
const ort = path.join(srv, 'node_modules/onnxruntime-node/bin');
for (const v of fs.readdirSync(ort)) for (const o of fs.readdirSync(path.join(ort, v))) {
  if (o !== PLATFORM) rm(path.join(ort, v, o));
  else for (const a of fs.readdirSync(path.join(ort, v, o))) if (a !== ARCH) rm(path.join(ort, v, o, a));
}
// 只用 CPU 识别：显卡加速用的 DLL 是延迟加载的，不带
if (target === 'win') for (const f of fs.globSync('napi-v*/win32/x64/{DirectML,dxcompiler}.dll', { cwd: ort })) rm(path.join(ort, f));
for (const f of fs.globSync('node_modules/**/*.{map,d.ts,d.mts,d.cts}', { cwd: srv })) rm(path.join(srv, f));
rm(path.join(srv, 'node_modules/.bin'));
// 必须存在的原生文件：缺了就别出包
const need = [`node_modules/onnxruntime-node/bin/napi-v6/${PLATFORM}/${ARCH}/onnxruntime_binding.node`, `node_modules/@napi-rs/canvas-${PLATFORM}-${ARCH}${target === 'win' ? '-msvc' : ''}`];
for (const f of need) if (!fs.existsSync(path.join(srv, f))) throw new Error(`缺少 ${f}`);
for (const f of ['main.cjs', 'settings.cjs', 'importer.cjs', 'procs.cjs', 'service.cjs', 'service-entry.mjs', 'preload-settings.cjs', 'preload-main.cjs', 'ui', 'assets']) fs.cpSync(path.join(here, f), path.join(stage, f), { recursive: true });
if (target === 'win') for (const f of ['icon.icns', 'trayTemplate.png', 'trayTemplate@2x.png']) rm(path.join(stage, 'assets', f)); else rm(path.join(stage, 'assets/icon.ico'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, productName: NAME, version: pkg.version, main: 'main.cjs' }));

console.log('2/4 打包');
const [dir] = await packager({
  dir: stage, out: tmpOut, overwrite: true, name: NAME, platform: PLATFORM, arch: ARCH, asar: false, prune: false, electronVersion,
  download: process.env.ELECTRON_MIRROR ? { mirrorOptions: { mirror: process.env.ELECTRON_MIRROR } } : {},
  appVersion: pkg.version, buildVersion: pkg.version, icon: path.join(here, target === 'mac' ? 'assets/icon.icns' : 'assets/icon.ico'), appCopyright: 'Tiangong',
  appBundleId: ID, appCategoryType: 'public.app-category.productivity',
  extendInfo: { CFBundleDevelopmentRegion: 'zh_CN', CFBundleLocalizations: ['zh_CN'], NSLocalNetworkUsageDescription: '让同一局域网的手机和电脑访问问题库' },
  win32metadata: { CompanyName: 'Tiangong', FileDescription: NAME, ProductName: NAME, InternalName: NAME, OriginalFilename: `${NAME}.exe`, 'requested-execution-level': 'asInvoker' },
});
rm(stage);
const made = target === 'mac' ? mac(dir) : await win(dir);
rm(tmpOut);
console.log(`完成：\n${made.map((f) => `  ${f}${fs.statSync(f).isFile() ? `\n    ${(fs.statSync(f).size / 1e6).toFixed(0)} MB  SHA-256 ${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}` : ''}`).join('\n')}`);

function mac(d) {
  const app = path.join(out, `${NAME}.app`), dmg = path.join(out, `${NAME}-${pkg.version}-${ARCH}.dmg`);
  rm(app); fs.renameSync(path.join(d, `${NAME}.app`), app);
  console.log('3/4 签名');
  sh('xattr', ['-cr', app]);
  sh('codesign', ['--force', '--deep', '--sign', process.env.CODESIGN_IDENTITY || '-', app]); // 默认临时签名；有开发者证书时填证书名
  sh('codesign', ['--verify', '--deep', '--strict', app]);
  console.log('4/4 制作 dmg');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-'));
  sh('cp', ['-R', app, tmp]);
  fs.symlinkSync('/Applications', path.join(tmp, 'Applications'));
  sh('hdiutil', ['create', '-volname', NAME, '-srcfolder', tmp, '-ov', '-format', 'UDZO', '-quiet', dmg]);
  rm(tmp);
  return [app, dmg];
}

async function win(d) {
  for (const f of fs.globSync('vendor/win-x64/*.dll', { cwd: here })) fs.copyFileSync(path.join(here, f), path.join(d, path.basename(f)));
  // Electron 自带几十种界面语言，只留中英文
  for (const f of fs.readdirSync(path.join(d, 'locales'))) if (!/^(zh-CN|en-US)\.pak$/.test(f)) rm(path.join(d, 'locales', f));
  console.log('3/4 签名');
  const cert = (process.env.SIGN_CERT_SHA1 ?? '').replace(/\s/g, ''); // 与天工阅卷、天工私信同一套变量
  const sign = (f) => sh('signtool', ['sign', '/sha1', cert, '/fd', 'sha256', '/tr', process.env.SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com', '/td', 'sha256', f]);
  if (!cert && process.env.TG_DESKTOP_SIGN === '1') throw new Error('TG_DESKTOP_SIGN=1 但未设置 SIGN_CERT_SHA1：拒绝产出未签名的正式包');
  if (cert && process.platform !== 'win32') throw new Error('签名要在插着 EV Key 的 Windows 上进行');
  if (cert) sign(path.join(d, `${NAME}.exe`)); else console.log('  未签名（开发包）');
  console.log('4/4 制作安装包');
  const { build, Platform, Arch } = await import('electron-builder');
  const nsisOut = path.join(tmpOut, 'nsis');
  const [setup] = (await build({
    projectDir: here, prepackaged: d, publish: 'never', targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    config: {
      appId: ID, productName: NAME, copyright: 'Tiangong', electronVersion, npmRebuild: false, directories: { output: nsisOut, buildResources: path.join(here, 'assets') },
      win: { icon: path.join(here, 'assets/icon.ico'), signAndEditExecutable: false, executableName: NAME },
      nsis: {
        artifactName: `${NAME}-\${version}-x64-setup.\${ext}`, oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
        installerLanguages: ['zh_CN'], language: '2052', createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: NAME, uninstallDisplayName: NAME, runAfterFinish: true,
        deleteAppDataOnUninstall: false, include: path.join(here, 'installer.nsh'), differentialPackage: false,
      },
    },
  })).filter((f) => f.endsWith('.exe'));
  if (cert) sign(setup);
  const dest = path.join(out, path.basename(setup));
  fs.rmSync(dest, { force: true }); fs.copyFileSync(setup, dest);
  return [dest];
}
