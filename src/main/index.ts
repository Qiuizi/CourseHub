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
import { PlatformBrowser, fixturesDir, flushAllPlatformSessions } from './browser/platform-browser'
import { TestbedServer } from './testbed/testbed-server'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null
let store: Store | null = null
let geo: GeoTestManager | null = null
let testbedServer: TestbedServer | null = null
let ipcHandle: { dispose: () => void } | null = null
const browsers = new Map<PlatformId, PlatformBrowser>()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  console.warn('[CourseHub] Another instance is already running. Forwarding activation and exiting.')
  app.quit()
}

// 捕获未处理的异常与 Promise 拒绝，记录诊断日志避免隐蔽闪退
process.on('uncaughtException', (err) => {
  console.error('[CourseHub] Uncaught Exception:', err)
  try {
    void store?.log('error', 'uncaught_exception', { error: String(err), stack: err.stack })
  } catch {}
})

process.on('unhandledRejection', (reason) => {
  console.error('[CourseHub] Unhandled Rejection:', reason)
  try {
    void store?.log('error', 'unhandled_rejection', { reason: String(reason) })
  } catch {}
})

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    center: true,
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

  let isShown = false
  const showWindow = (): void => {
    if (isShown || win.isDestroyed()) return
    isShown = true
    win.show()
    win.focus()
  }

  win.once('ready-to-show', showWindow)
  // 兜底超时：部分环境不派发 ready-to-show 时强制展示窗口，避免用户界面无响应
  setTimeout(showWindow, 1500)

  // 监控渲染崩溃与页面加载错误
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[CourseHub] did-fail-load: ${errorCode} (${errorDescription}) for ${validatedURL}`)
    void store?.log('error', 'window_did_fail_load', { errorCode, errorDescription, validatedURL })
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[CourseHub] render-process-gone: ${details.reason} (exitCode: ${details.exitCode})`)
    void store?.log('error', 'renderer_process_gone', details)
  })

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

  testbedServer = new TestbedServer(fixturesDir())
  void testbedServer.start().then((port) => {
    void store?.log('info', 'testbed_server_started', { port })
  }).catch((err) => {
    console.error('[CourseHub] Testbed server failed to start:', err)
  })

  ipcHandle = registerIpc({
    store,
    getWindow: () => mainWindow,
    browsers,
    geo,
    testbedServer
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.setAlwaysOnTop(true)
    mainWindow.setAlwaysOnTop(false)
  }
})

/**
 * 退出清理。定位覆盖必须清除，播放器观察器必须停止，
 * 且强制将所有平台的 Cookies 刷写至磁盘 SQLite 数据库，避免 Session Cookie 丢失。
 */
function cleanup(): void {
  ipcHandle?.dispose()
  for (const b of browsers.values()) b.destroy()
  browsers.clear()
  geo?.disposeSync()
  void testbedServer?.stop()
  testbedServer = null
  void flushAllPlatformSessions()
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
