// 问题库窗口加载的是网页，只给它一个打开控制台的能力。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tgDesktop', { openSettings: () => ipcRenderer.send('open-settings') });
