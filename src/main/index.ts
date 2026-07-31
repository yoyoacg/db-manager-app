import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  getDescriptor,
  getDescriptors,
  getInstalledVersions,
  readConfig,
  resetConfig,
  resolveInstall,
  writeConfig
} from './registry'
import { startService, stopService, getStatusMap } from './processManager'
import { listRemoteVersions, downloadVersion, importZipToVersion } from './downloadManager'
import { addExternalInstall, getConfig, setServicesRoot } from './store'

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    title: 'DB 服务管理器',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc() {
  ipcMain.handle('services:list', () =>
    getDescriptors().map((d) => ({
      ...d,
      installed: d.connectionOnly ? [] : getInstalledVersions(d.id)
    }))
  )
  ipcMain.handle('services:status', () => getStatusMap())
  ipcMain.handle('service:start', (_e, id: string, version: string) => startService(id, version))
  ipcMain.handle('service:stop', (_e, id: string) => stopService(id))
  ipcMain.handle('service:remoteVersions', (_e, id: string) => listRemoteVersions(id))
  ipcMain.handle('service:download', (_e, id: string, version: string) =>
    downloadVersion(id, version)
  )
  ipcMain.handle('service:openDir', (_e, id: string, version?: string) => {
    let p: string
    if (version) {
      const resolved = resolveInstall(id, version)
      p = resolved ? resolved.installDir : path.join(getConfig().servicesRoot, id, version)
    } else {
      p = path.join(getConfig().servicesRoot, id)
    }
    fs.mkdirSync(p, { recursive: true })
    shell.openPath(p)
  })
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:setRoot', (_e, root: string) => setServicesRoot(root))

  // 配置文件读写（phpStudy 式）
  ipcMain.handle('service:getConf', (_e, id: string, version: string) => {
    const r = readConfig(id, version)
    if (!r) throw new Error('该服务不支持配置文件，或对应版本尚未安装')
    return r
  })
  ipcMain.handle('service:saveConf', (_e, id: string, version: string, content: string) => {
    const p = writeConfig(id, version, content)
    if (!p) throw new Error('该服务不支持配置文件，或对应版本尚未安装')
    return { ok: true, path: p }
  })
  ipcMain.handle('service:resetConf', (_e, id: string, version: string) => {
    const r = resetConfig(id, version)
    if (!r) throw new Error('该服务不支持配置文件，或对应版本尚未安装')
    return r
  })

  // 导入用户手动下载的 zip 包
  ipcMain.handle('service:importZip', async (e, id: string, version: string) => {
    const d = getDescriptor(id)
    if (!d) throw new Error(`未知服务: ${id}`)
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(win!, {
      title: `选择 ${d.displayName} 的 Windows zip 发布包`,
      filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return { canceled: true }
    return importZipToVersion(id, version, r.filePaths[0])
  })

  // 登记机器上已存在的安装目录（如 C:\Program Files\MongoDB\Server\8.2）
  ipcMain.handle('service:addExternal', async (e, id: string, version: string) => {
    const d = getDescriptor(id)
    if (!d || d.connectionOnly || !d.install) throw new Error('该条目不支持登记')
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(win!, {
      title: `选择 ${d.displayName} 的安装目录（其下应存在 ${d.install.binPath}）`,
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return { canceled: true }
    const dir = r.filePaths[0]
    if (!fs.existsSync(path.join(dir, d.install.binPath))) {
      throw new Error(`该目录下未找到 ${d.install.binPath}，请选择正确的安装目录`)
    }
    addExternalInstall({ id, version, path: dir })
    return { ok: true }
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
