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
  shortName: string
  /** 允许的 origin 白名单。导航目标必须命中其一。 */
  allowedOrigins: readonly string[]
  homeUrl: string
  /**
   * 是否允许 file:// 协议。仅「自有测试站点」开启，
   * 用于加载随包分发的本地 fixture（视频/题目/定位回显页）。
   * 生产平台一律关闭。
   */
  allowFileProtocol?: boolean
}

export const PLATFORM_CONFIGS: readonly PlatformConfig[] = [
  {
    id: 'chaoxing',
    name: '超星学习通',
    shortName: '学习通',
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
    shortName: '雨课堂',
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
    shortName: '智慧树',
    // 首版仅提供浏览入口；未取得真实样例前不声称签到/视频适配
    allowedOrigins: ['https://www.zhihuishu.com', 'https://zhihuishu.com'],
    homeUrl: 'https://www.zhihuishu.com/'
  },
  {
    // 自有测试站点（开发文档 §2.2）：独立会话 + 本地 fixture，
    // 用于可重复地验证播放器观测、题目交互与定位覆盖。
    id: 'testbed',
    name: '测试台',
    shortName: '测试台',
    allowedOrigins: [],
    allowFileProtocol: true,
    homeUrl: ''
  }
]

/** 独立测试分区。绝不复用生产分区，避免定位覆盖/测试写入污染真实会话。 */
export const TEST_PARTITION = 'coursehub-test'

export function sessionNameFor(platformId: PlatformId): string {
  return `persist:coursehub-${platformId}`
}

/**
 * origin 白名单校验。
 *
 * - 生产平台：只允许 http(s)，且 hostname 必须在白名单内（含子域）。
 * - 自有测试站点（allowFileProtocol）：额外允许 file://，
 *   且**只允许指向随包分发的 fixtures 目录**，不允许任意本地路径。
 */
export function isOriginAllowed(
  url: string,
  allowed: readonly string[],
  allowFile = false
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (allowFile && parsed.protocol === 'file:') {
    // 只放行 fixtures 目录内的文件，避免变成任意本地文件读取器
    const p = decodeURIComponent(parsed.pathname).replace(/\\/g, '/').toLowerCase()
    return p.includes('/tests/fixtures/') || p.includes('/resources/fixtures/')
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

  /** 该平台的持久化 Session。测试台使用专用测试分区并放行 geolocation，生产平台权限默认全拒。 */
  getSession(): Electron.Session {
    if (this.platformId === 'testbed') {
      return testSession()
    }
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
      if (!isOriginAllowed(url, this.config.allowedOrigins, this.config.allowFileProtocol))
        event.preventDefault()
    })
    wc.on('will-redirect', (event, url) => {
      if (!isOriginAllowed(url, this.config.allowedOrigins, this.config.allowFileProtocol))
        event.preventDefault()
    })

    // 弹窗一律拒绝；白名单内的 http(s) 在当前视图内导航
    wc.setWindowOpenHandler(({ url }) => {
      if (isOriginAllowed(url, this.config.allowedOrigins, this.config.allowFileProtocol)) {
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
    if (!isOriginAllowed(url, this.config.allowedOrigins, this.config.allowFileProtocol)) {
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

  /** 开发诊断：视图当前 bounds 与可见性。 */
  debugBounds(): { bounds: Electron.Rectangle | null; visible: boolean; attached: boolean } {
    if (!this.view) return { bounds: null, visible: false, attached: this.attached }
    return {
      bounds: this.view.getBounds(),
      visible: this.view.getVisible(),
      attached: this.attached
    }
  }

  get webContents(): Electron.WebContents | null {
    if (!this.view || this.view.webContents.isDestroyed()) return null
    return this.view.webContents
  }

  /** 只有白名单内的 http(s) 才允许用系统浏览器打开。 */
  openExternal(url: string): boolean {
    // file:// 不交给系统浏览器，避免把本地 fixture 变成外部可打开文件
    if (this.config.allowFileProtocol && url.startsWith('file:')) return false
    if (!isOriginAllowed(url, this.config.allowedOrigins, this.config.allowFileProtocol)) return false
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
