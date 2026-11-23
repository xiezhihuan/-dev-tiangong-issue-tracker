const { contextBridge, ipcRenderer } = require('electron');
const OPS = ['get', 'save', 'finish', 'testQQ', 'testPublic', 'importPick', 'importStop', 'restart', 'portFix', 'bindCode', 'unbind', 'createToken', 'removeToken', 'openMain', 'openPath', 'openExternal', 'doctor', 'reset', 'copy', 'password', 'randomPassword'];
contextBridge.exposeInMainWorld('tgBridge', {
  ...Object.fromEntries(OPS.map((k) => [k, (...a) => ipcRenderer.invoke('tg', k, a)])), // 错误以普通对象返回：跨 contextBridge 会丢掉 Error 的自定义字段
  onChange: (fn) => ipcRenderer.on('change', (_e, v) => fn(v)),
  onView: (fn) => ipcRenderer.on('view', (_e, v) => fn(v)),
});
