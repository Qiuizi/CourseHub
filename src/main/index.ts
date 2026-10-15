/**
 * Electron 主进程入口。
 *
 * 生命周期要求：
 * - 单实例锁；窗口关闭时必须清理定位覆盖与观察器。
 * - 退出前同步清理，防止遗留 CDP 覆盖或悬挂 view。
 */

import { app, BrowserWindow, Notification, shell } from 'electron'
import path from 'node:path'
import type { PlatformId, GeoTestRun, PlaybackObservation } from '@shared/types'
import { defaultStore, type Store } from './services/store'
import { GeoTestManager } from './geo-test/geo-test-manager'
import { PlatformBrowser } from './browser/platform-browser'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null
let store: Store | null = null
let geo: GeoTestManager | null = null
let ipcHandle: { dispose: () => void } | null = null
const browsers = new Map<PlatformId, PlatformBrowser>()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#f0f4f9',
    autoHideMenuBar: true,
    title: 'CourseHub',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // 本地 UI 才允许 nodeIntegration；远程平台视图另有严格设置
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // 本地 UI 不允许跳转到外部站点
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL
    if (devServer && url.startsWith(devServer)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
  })

  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) {
    void win.loadURL(devServer)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    mainWindow = null
  })

  return win
}

function bootstrap(): void {
  store = defaultStore()
  void store.init()

  geo = new GeoTestManager({
    onUpdate: (run: GeoTestRun) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('geo-test:update', run)
    }
  })

  mainWindow = createWindow()

  ipcHandle = registerIpc({
    store,
    getWindow: () => mainWindow,
    browsers,
    geo
  })

  // 播放器观测推送到本地 UI
  mainWindow.webContents.on('did-finish-load', () => {
    /* renderer 就绪，等待其主动注册 bounds */
  })

  void store.log('info', 'app_start', { version: app.getVersion() })
}

app.whenReady().then(() => {
  bootstrap()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

/**
 * 退出清理。定位覆盖必须清除，播放器观察器必须停止，
 * 否则会留下悬挂的 CDP 覆盖与定时器。
 */
function cleanup(): void {
  ipcHandle?.dispose()
  for (const b of browsers.values()) b.destroy()
  browsers.clear()
  geo?.disposeSync()
}

app.on('window-all-closed', () => {
  cleanup()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  cleanup()
})

// 供 preload/renderer 使用的类型（避免 renderer 直接 import electron）
export type { PlaybackObservation }
export { Notification }
