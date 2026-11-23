// 线性图标：24×24、单色描边，跟随文字颜色。
const P = {
  inbox: 'M4 13.5 6.4 5h11.2L20 13.5V19H4zM4 13.5h4.6L10 16h4l1.4-2.5H20',
  layers: 'm12 3.5 8.5 4.7L12 13 3.5 8.2zM3.5 12.4 12 17.1l8.5-4.7M3.5 16.4l8.5 4.7 8.5-4.7',
  chart: 'M4 20.5h16M7 17V11M12 17V5M17 17v-8',
  sliders: 'M4 7h9M18 7h2M4 17h2M11 17h9M13 7a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M6 17a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 1 0 0-14M20.5 20.5 16 16',
  filter: 'M4 6h16M7 12h10M10 18h4',
  calendar: 'M5 5.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1M4 10h16M8 3.5v4M16 3.5v4',
  chat: 'M4.5 5h15v11H11l-5 4v-4H4.5zM8.5 9h7M8.5 12h4.5',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17M3.5 12h17M12 3.5c5 5 5 12 0 17M12 3.5c-5 5-5 12 0 17',
  clip: 'm20 11.5-8.3 8.2a5 5 0 0 1-7.1-7.1l8.6-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.4a1.7 1.7 0 0 1-2.4-2.4l7.8-7.7',
  msg: 'M20 11.5a7.5 7 0 0 1-7.5 7H4l2-3.2a7 7 0 0 1-1-3.8 7.5 7 0 0 1 15 0',
  open: 'M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16',
  doing: 'M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16M12 8v4l2.8 1.8',
  resolved: 'M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16M8.5 12.2l2.5 2.5 4.5-5',
  closed: 'M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16M9.3 9.3l5.4 5.4M14.7 9.3l-5.4 5.4',
  trend: 'M3.5 17 9.5 11l4 4 7-7.5M15.5 7.5h5v5',
  flame: 'M12 3c.5 3.5 5.5 5.5 5.5 11a5.5 5.5 0 0 1-11 0c0-2 .8-3.4 2-4.5.2 1.5 1 2.3 2 2.5-.5-3 .2-6.5 1.5-9',
  unlink: 'M9.5 14.5 7 17a3.5 3.5 0 0 1-5-5l2.5-2.5M14.5 9.5 17 7a3.5 3.5 0 0 1 5 5l-2.5 2.5M9 5V3M5 9H3M15 19v2M19 15h2',
  trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 13h9.4l.8-13M10 11v5.5M14 11v5.5',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  console: 'M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4',
  logout: 'M14 4.5H5v15h9M10 12h10.5M17 8.5l3.5 3.5-3.5 3.5',
  download: 'M12 4v11M7.5 11l4.5 4.5 4.5-4.5M4.5 19.5h15',
  table: 'M4 5h16v14H4zM4 10h16M4 14.5h16M10 10v9',
  file: 'M6 3.5h8l4.5 4.5v12.5H6zM14 3.5V8h4.5',
  files: 'M8 3.5h7l4 4V17H8zM15 3.5v4h4M8 7H5v13.5h10V17',
  braces: 'M9 4c-3 0-2.5 2-2.5 4S5.5 12 4 12c1.5 0 2.5 2 2.5 4S6 20 9 20M15 4c3 0 2.5 2 2.5 4s1 4 2.5 4c-1.5 0-2.5 2-2.5 4s.5 4-2.5 4',
  back: 'M19 12H5M11 6l-6 6 6 6',
  next: 'M5 12h14M13 6l6 6-6 6',
  check: 'M20 6.5 9.5 17.5 4 12',
  x: 'M6 6l12 12M18 6 6 18',
  warn: 'M12 4 2.8 20h18.4zM12 10v4.5M12 17.3v.1',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 1 0 0-8M4.5 20.5c.5-4 3.5-6 7.5-6s7 2 7.5 6',
  users: 'M9 5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7M2.5 19.5c.4-3.5 3-5 6.5-5s6.1 1.5 6.5 5M15.5 5.3a3.5 3.5 0 0 1 0 6.5M18 15c2 .7 3.2 2.2 3.5 4.5',
  key: 'M8 10.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9M11.3 11.7 20 3.5M17 6.5l2.5 2.5M14.5 8.8l2 2',
  box: 'm12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  zap: 'M13 3 5 13.5h6L10.5 21 19 10.5h-6z',
  gauge: 'M4.5 18.5a9 9 0 1 1 15 0M12 14l4-5M12 13a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3',
  printer: 'M7 8.5v-5h10v5M7 17H4V8.5h16V17h-3M7 14h10v6.5H7z',
  layout: 'M4 4.5h16v15H4zM4 9.5h16M10 9.5v10',
  db: 'M12 3.5c4.5 0 7.5 1.2 7.5 2.8S16.5 9 12 9 4.5 7.9 4.5 6.3 7.5 3.5 12 3.5M4.5 6.3v11.4c0 1.6 3 2.8 7.5 2.8s7.5-1.2 7.5-2.8V6.3M4.5 12c0 1.6 3 2.8 7.5 2.8s7.5-1.2 7.5-2.8',
  wifi: 'M2.5 9.5c5.5-5 13.5-5 19 0M6 13.2c3.5-3 8.5-3 12 0M9.3 16.7c1.6-1.3 3.8-1.3 5.4 0M12 20v.1',
  lock: 'M5.5 11h13v9.5h-13zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 14.8v2',
  card: 'M3.5 6h17v12.5h-17zM3.5 10.5h17M7 15h3.5',
  bulb: 'M9 17.5h6M10 20.5h4M12 3.5a6 6 0 0 0-3.5 10.9c.5.4.7 1 .7 1.6h5.6c0-.6.2-1.2.7-1.6A6 6 0 0 0 12 3.5',
  help: 'M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16M9.7 9.7a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.6M12 16.3v.1',
  tag: 'M4 4.5h7.5l8.5 8.5-7 7L4.5 11.5zM8.3 8.5v.1',
  branch: 'M7 4.5v15M7 14c0-3 10-1.5 10-6.5M7 3a1.7 1.7 0 1 0 0 3.4A1.7 1.7 0 1 0 7 3M17 4.2a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 1 0 0-3.4M7 17.6a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 1 0 0-3.4',
  title: 'M5 5.5h14M12 5.5V19M9 19h6',
  flag: 'M5.5 21V4M5.5 4.5c5-2 8 2 13 0v9c-5 2-8-2-13 0',
  compass: 'M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16M15 9l-1.7 4.3L9 15l1.7-4.3z',
  note: 'M5 4h14v11l-5 5H5zM19 15h-5v5M8.5 8.5h7M8.5 12h4',
  history: 'M4 5v4.5h4.5M4.3 9.5A8 8 0 1 1 4 13M12 8v4.3l3 1.7',
  phone: 'M7.5 2.8h9a1 1 0 0 1 1 1v16.4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V3.8a1 1 0 0 1 1-1M11 18.2h2',
  ai: 'm11 3.5 1.9 5.6L18.5 11l-5.6 1.9L11 18.5l-1.9-5.6L3.5 11l5.6-1.9zM18.5 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  scan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 9.5h8M8 14.5h5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16M12 7.5V12l3 2',
  link: 'M10 14a4 4 0 0 0 5.7 0l3.3-3.3A4 4 0 0 0 13.3 5L12 6.3M14 10a4 4 0 0 0-5.7 0L5 13.3A4 4 0 0 0 10.7 19L12 17.7',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5L13 16l2.5-2.5L20 18M15.5 8.5v.1',
  voice: 'M12 3.5a2.8 2.8 0 0 0-2.8 2.8v5a2.8 2.8 0 0 0 5.6 0v-5A2.8 2.8 0 0 0 12 3.5M5.8 11a6.2 6.2 0 0 0 12.4 0M12 17.2v3.3',
  video: 'M3.5 6.5h11.5v11H3.5zM15 10.5l5.5-3v9l-5.5-3',
  empty: 'M4 13.5 6.4 5h11.2L20 13.5V19H4zM4 13.5h4.6L10 16h4l1.4-2.5H20M12 4v5M9.8 7 12 9.2 14.2 7',
};
const NS = 'http://www.w3.org/2000/svg';
export function icon(name, cls = '') {
  const s = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', `i ${cls}`.trim());
  p.setAttribute('d', P[name] ?? P.tag); s.append(p);
  return s;
}
/** 优先级：信号格；紧急是实心叹号。 */
export function sevIcon(level) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', `sevi ${level}`);
  const rect = (x, y, w, h, rx, o) => { const r = document.createElementNS(NS, 'rect'); for (const [k, v] of Object.entries({ x, y, width: w, height: h, rx, opacity: o })) r.setAttribute(k, v); s.append(r); return r; };
  if (level === 'urgent') { rect(1, 1, 14, 14, 4, 1); const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M8 4.5v4.3M8 11.3v.1'); s.append(p); } else {
    const n = { high: 3, normal: 2, low: 1 }[level] ?? 1;
    [[2, 9, 5], [6.5, 6, 8], [11, 3, 11]].forEach(([x, y, hh], i) => rect(x, y, 3, hh, 1.2, i < n ? 1 : 0.250));
  }
  return s;
}
/** 分类 → [图标, 色相]。按名字里的词匹配，自建分类用名字算出固定色相。 */
const CATS = [[/登录|账号|密码/, 'key', 'blue'], [/安装|升级|更新/, 'download', 'teal'], [/崩溃|闪退/, 'zap', 'red'], [/卡顿|性能/, 'gauge', 'orange'], [/导入|导出|文件/, 'files', 'violet'], [/打印/, 'printer', 'slate'], [/界面|显示/, 'layout', 'pink'], [/数据/, 'db', 'red'], [/网络|连接/, 'wifi', 'cyan'], [/权限/, 'lock', 'amber'], [/授权|费用|付费/, 'card', 'green'], [/建议|需求/, 'bulb', 'amber'], [/咨询|使用/, 'help', 'indigo'], [/其他|其它/, 'tag', 'slate']];
const HUES = ['blue', 'violet', 'teal', 'orange', 'pink', 'green', 'indigo', 'cyan', 'amber'];
export const hue = (s) => { let n = 7; for (const c of String(s)) n = (n * 31 + c.codePointAt(0)) >>> 0; return HUES[n % HUES.length]; };
export const category = (name) => { const c = CATS.find(([re]) => re.test(name)); return c ? [c[1], c[2]] : name ? ['tag', hue(name)] : ['msg', 'slate']; };
