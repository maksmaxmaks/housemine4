'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hm', {
  call: (action, payload) => ipcRenderer.invoke('hm', action, payload),
  on: (channel, cb) => {
    const f = (_e, data) => cb(data);
    ipcRenderer.on('hm:' + channel, f);
    return () => ipcRenderer.removeListener('hm:' + channel, f);
  },
});
