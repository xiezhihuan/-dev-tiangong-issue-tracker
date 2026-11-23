// 生成图标：node make-icons.mjs（用本机 Chrome 渲染 SVG；结果已入库，改图标时才需要运行）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const here = path.dirname(fileURLToPath(import.meta.url)), out = path.join(here, 'assets');
const bubble = (fill) => `<path d="M8 9h16v11H15l-5 4v-4H8z" fill="${fill}"/>`;
// macOS 图标留边：1024 画布里 824 的圆角方块
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a86e0"/><stop offset="1" stop-color="#1f5aa4"/></linearGradient></defs><rect x="100" y="100" width="824" height="824" rx="186" fill="url(#g)"/><g transform="translate(112 112) scale(25)">${bubble('#fff')}<path d="M11.5 13h9M11.5 16h6" stroke="#256abf" stroke-width="1.3" stroke-linecap="round"/></g></svg>`;
const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 7 20 20"><path d="M8 9h16v11H15l-5 4v-4H8z" fill="none" stroke="#000" stroke-width="1.9" stroke-linejoin="round"/><path d="M12 13.2h8M12 16.2h5" stroke="#000" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const b = await chromium.launch({ channel: 'chrome' });
const png = async (svg, n, file) => { const p = await b.newPage({ viewport: { width: n, height: n } }); await p.setContent(`<style>body{margin:0}svg{display:block;width:${n}px;height:${n}px}</style>${svg}`); await p.screenshot({ path: file, omitBackground: true }); await p.close(); };
await png(tray, 18, path.join(out, 'trayTemplate.png')); await png(tray, 36, path.join(out, 'trayTemplate@2x.png'));
const set = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-')) + '/icon.iconset';
fs.mkdirSync(set);
for (const n of [16, 32, 128, 256, 512]) { await png(appIcon, n, `${set}/icon_${n}x${n}.png`); await png(appIcon, n * 2, `${set}/icon_${n}x${n}@2x.png`); }
// Windows：.ico 内嵌 PNG，各尺寸齐全；去掉 macOS 的留边
const win = appIcon.replace('viewBox="0 0 1024 1024"', 'viewBox="76 76 872 872"'), sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256], imgs = [];
for (const n of sizes) { const f = `${set}-${n}.png`; await png(win, n, f); imgs.push(fs.readFileSync(f)); }
const head = Buffer.alloc(6 + 16 * sizes.length); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let at = head.length;
sizes.forEach((n, i) => { const o = 6 + 16 * i; head[o] = head[o + 1] = n === 256 ? 0 : n; head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(imgs[i].length, o + 8); head.writeUInt32LE(at, o + 12); at += imgs[i].length; });
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([head, ...imgs]));
await b.close();
execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(out, 'icon.icns')]);
