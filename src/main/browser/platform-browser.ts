/**
 * 平台浏览器宿主：WebContentsView + 每平台独立持久化 Session。
 *
 * 安全边界（开发文档 §5、§5.2）：
 * - 远程页面 nodeIntegration:false / contextIsolation:true / sandbox:true / webSecurity:true。
 * - 远程页面拿不到 Node、文件系统、DeepSeek Key 或通用 IPC。
 * - 每个 Session 同时设置 setPermissionRequestHandler 与 setPermissionCheckHandler，
 *   定位/摄像头/麦克风/剪贴板/屏幕共享默认拒绝。
 * - 导航、弹窗、下载按 platformId + origin 限制，拒绝任意协议。
 */

import { app, BrowserWindow, WebContentsView, session, shell } from 'electron'
import path from 'node:path'
import type { Bounds, PlatformId } from '@shared/types'

export interface PlatformConfig {
  id: PlatformId
  name: string
  /** 允许的 origin 白名单。导航目标必须命中其一。 */
  allowedOrigins: readonly string[]
  homeUrl: string
}

export const PLATFORM_CONFIGS: readonly PlatformConfig[] = [
  {
    id: 'chaoxing',
    name: '超星学习通',
    allowedOrigins: [
      'https://passport2.chaoxing.com',
      'https://mooc1-api.chaoxing.com',
      'https://mobilelearn.chaoxing.com',
      'https://www.chaoxing.com',
      'https://chaoxing.com'
    ],
    homeUrl: 'https://passport2.chaoxing.com/login'
  },
  {
    id: 'yuketang',
    name: '雨课堂',
    allowedOrigins: [
      'https://www.yuketang.cn',
      'https://yuketang.cn',
      'https://pro.yuketang.cn',
      'https://changjiang.yuketang.cn'
    ],
    homeUrl: 'https://www.yuketang.cn/'
  },
  {
    id: 'zhihuishu',
    name: '智慧树',
    // 首版仅提供浏览入口；未取得真实样例前不声称签到/视频适配
    allowedOrigins: ['https://www.zhihuishu.com', 'https://zhihuishu.com'],
    homeUrl: 'https://www.zhihuishu.com/'
  }
]

/** 独立测试分区。绝不复用生产分区，避免定位覆盖/测试写入污染真实会话。 */
export const TEST_PARTITION = 'coursehub-test'

export function sessionNameFor(platformId: PlatformId): string {
  return `persist:coursehub-${platformId}`
}

export function isOriginAllowed(url: string, allowed: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  // 只允许 http(s)，拒绝 file:、javascript:、data: 等任意协议
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  return allowed.some((origin) => {
    try {
      const o = new URL(origin)
      const host = parsed.hostname.toLowerCase()
      const allowedHost = o.hostname.toLowerCase()
      return host === allowedHost || host.endsWith(`.${allowedHost}`)
    } catch {
      return false
    }
  })
}

/**
 * 平台浏览器宿主。
 * 显式持有 BrowserWindow 引用，避免依赖全局可变状态。
 */
export class PlatformBrowser {
  readonly platformId: PlatformId
  private view: WebContentsView | null = null
  private attached = false
  private win: BrowserWindow | null = null

  constructor(
    platformId: PlatformId,
    private readonly config: PlatformConfig
  ) {
    this.platformId = platformId
  }

  static create(platformId: PlatformId): PlatformBrowser {
    const cfg = PLATFORM_CONFIGS.find((c) => c.id === platformId)
    if (!cfg) throw new Error(`unknown platform ${platformId}`)
    return new PlatformBrowser(platformId, cfg)
  }

  /** 该平台的独立持久化 Session，权限默认全拒。 */
  getSession(): Electron.Session {
    const ses = session.fromPartition(sessionNameFor(this.platformId))
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    return ses
  }

  ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view

    const view = new WebContentsView({      webPreferences: {
        session: this.getSession(),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        // 远程页面不注入任何 preload，物理上无法触碰 IPC
        preload: undefined,
        webviewTag: false,
        spellcheck: false
      }
    })
    view.setBackgroundColor('#0b0f19')

    const wc = view.webContents

    // 导航限制：只允许白名单 origin
    wc.on('will-navigate', (event, url) => {
      if (!isOriginAllowed(url, this.config.allowedOrigins)) event.preventDefault()
    })
    wc.on('will-redirect', (event, url) => {
      if (!isOriginAllowed(url, this.config.allowedOrigins)) event.preventDefault()
    })

    // 弹窗一律拒绝；白名单内的 http(s) 在当前视图内导航
    wc.setWindowOpenHandler(({ url }) => {
      if (isOriginAllowed(url, this.config.allowedOrigins)) {
        void wc.loadURL(url).catch(() => undefined)
      }
      return { action: 'deny' }
    })

    this.view = view

    // 下载拦截挂在 Session 上（will-download 是 Session 事件，不是 webContents 事件）：
    // 不静默落盘，也不自动运行，避免远程页面触发任意文件写入。
    this.getSession().on('will-download', (event) => {
      event.preventDefault()
    })

    return view
  }

  attach(win: BrowserWindow): void {
    this.win = win
    if (this.attached) return
    const view = this.ensureView()
    win.contentView.addChildView(view)
    this.attached = true
  }

  setBounds(bounds: Bounds): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    const w = Math.max(0, Math.floor(bounds.width))
    const h = Math.max(0, Math.floor(bounds.height))
    if (w === 0 || h === 0) return
    this.view.setBounds({
      x: Math.floor(bounds.x),
      y: Math.floor(bounds.y),
      width: w,
      height: h
    })
  }

  /** 截图/设置等本地模态框弹出时临时移除视图，避免遮挡；不销毁 webContents。 */
  setVisible(visible: boolean): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    const win = this.win
    if (!win) return
    if (!visible) {
      if (this.attached) {
        win.contentView.removeChildView(this.view)
        this.attached = false
      }
      this.view.setVisible(false)
    } else {
      if (!this.attached) {
        win.contentView.addChildView(this.view)
        this.attached = true
      }
      this.view.setVisible(true)
    }
  }

  async navigate(url: string): Promise<{ ok: boolean; error?: string }> {
    if (!isOriginAllowed(url, this.config.allowedOrigins)) {
      return { ok: false, error: `UNSUPPORTED: 目标 origin 不在 ${this.config.name} 白名单内` }
    }
    const view = this.ensureView()
    try {
      await view.webContents.loadURL(url)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async loadHome(): Promise<void> {
    const view = this.ensureView()
    await view.webContents.loadURL(this.config.homeUrl).catch(() => undefined)
  }

  async reload(): Promise<void> {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.reload()
  }

  async goBack(): Promise<void> {
    const wc = this.webContents
    if (wc) wc.navigationHistory.goBack()
  }

  async goForward(): Promise<void> {
    const wc = this.webContents
    if (wc) wc.navigationHistory.goForward()
  }

  get currentUrl(): string | null {
    const wc = this.webContents
    if (!wc) return null
    return wc.getURL() || null
  }

  get webContents(): Electron.WebContents | null {
    if (!this.view || this.view.webContents.isDestroyed()) return null
    return this.view.webContents
  }

  /** 只有白名单内的 http(s) 才允许用系统浏览器打开。 */
  openExternal(url: string): boolean {
    if (!isOriginAllowed(url, this.config.allowedOrigins)) return false
    void shell.openExternal(url)
    return true
  }

  destroy(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close()
    this.view = null
    this.attached = false
    this.win = null
  }
}

/**
 * 独立测试 Session：内存 + 临时存储，绝不接触生产 Cookie。
 * 只放行 geolocation，用于验证覆盖是否真的生效。
 */
export function testSession(): Electron.Session {
  const ses = session.fromPartition(TEST_PARTITION)
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'geolocation')
  })
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'geolocation')
  return ses
}

/** 测试 fixture 目录。开发态在项目根，打包后随 asar 分发。 */
export function fixturesDir(): string {
  return path.join(app.getAppPath(), 'tests', 'fixtures')
}
