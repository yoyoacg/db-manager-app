import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dbapi', {
  listServices: () => ipcRenderer.invoke('services:list'),
  getStatus: () => ipcRenderer.invoke('services:status'),
  scanWindowsServices: () => ipcRenderer.invoke('services:scanWindows'),
  start: (id: string, version: string) => ipcRenderer.invoke('service:start', id, version),
  stop: (id: string) => ipcRenderer.invoke('service:stop', id),
  remoteVersions: (id: string) => ipcRenderer.invoke('service:remoteVersions', id),
  download: (id: string, version: string) => ipcRenderer.invoke('service:download', id, version),
  importZip: (id: string, version: string) => ipcRenderer.invoke('service:importZip', id, version),
  addExternal: (id: string, version: string) =>
    ipcRenderer.invoke('service:addExternal', id, version),
  openDir: (id: string, version?: string) => ipcRenderer.invoke('service:openDir', id, version),
  getConf: (id: string, version: string) => ipcRenderer.invoke('service:getConf', id, version),
  saveConf: (id: string, version: string, content: string) =>
    ipcRenderer.invoke('service:saveConf', id, version, content),
  resetConf: (id: string, version: string) =>
    ipcRenderer.invoke('service:resetConf', id, version),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setRoot: (root: string) => ipcRenderer.invoke('config:setRoot', root),
  onProgress: (cb: (p: any) => void) => {
    const listener = (_e: any, p: any) => cb(p)
    ipcRenderer.on('download-progress', listener)
    return () => ipcRenderer.removeListener('download-progress', listener)
  }
})
