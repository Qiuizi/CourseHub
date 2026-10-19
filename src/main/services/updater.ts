/**
 * CourseHub 客户端自动更新服务 (AppUpdateManager)。
 *
 * 核心机制：
 * 1. 基于 electron-updater 与 electron-builder GitHub Releases Provider。
 * 2. 严格限制更新源为官方公开仓库 Qiuizi/CourseHub，不含任何私有 Token 或发布凭据。
 * 3. 严格遵循信道隔离：Beta 渠道专用 (beta.yml)，与 Stable (v0.4.1) 隔离。
 * 4. 禁用静默静默偷跑下载 (autoDownload = false)，用户确认后才开始下载。
 * 5. 状态全链路受控推送给渲染进程，记录结构化脱敏诊断日志。
 * 6. 重启安装前执行业务互斥检查（连续播放、AI 生成、课堂定位），并先落盘 Session Cookie。
 */

import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { autoUpdater as defaultAutoUpdater, type AppUpdater } from 'electron-updater'
import type { Store } from './store'
import { flushAllPlatformSessions } from '../browser/platform-browser'
import { ok, fail } from '@shared/ipc'
import type { IpcResult } from '@shared/types'
import {
  type UpdateState,
  type UpdateReleaseInfo,
  type UpdateProgressInfo,
  GITHUB_RELEASES_URL,
  classifyUpdaterError
} from '@shared/updater'

export interface AppUpdateManagerDeps {
  store: Store
  getWindow: () => BrowserWindow | null
  isBusy?: () => { busy: boolean; reason?: string }
  updaterInstance?: AppUpdater
}

export class AppUpdateManager {
  private readonly autoUpdater: AppUpdater
  private state: UpdateState
  private lastLoggedProgress = 0
  private checkStartTime = 0
  private isManualCheck = false

  constructor(private readonly deps: AppUpdateManagerDeps) {
    this.autoUpdater = deps.updaterInstance || defaultAutoUpdater

    const currentVersion = typeof app?.getVersion === 'function' ? app.getVersion() : '0.4.3-beta.3'

    this.state = {
      status: 'idle',
      currentVersion,
      channel: 'beta',
      info: null,
      progress: null,
      error: null,
      lastCheckedAt: null,
      isInstallOnQuit: false
    }

    this.initUpdater()
  }

  private initUpdater(): void {
    try {
      // 核心安全策略：严禁静默偷跑下载，必须用户显式确认
      this.autoUpdater.autoDownload = false
      this.autoUpdater.autoInstallOnAppQuit = false
      this.autoUpdater.allowPrerelease = true
      this.autoUpdater.channel = 'beta'
      // 关键安全修复：electron-updater 在设置 channel 时会隐式将 allowDowngrade 设为 true，
      // 必须在其后立即显式重置为 false，防止意外降级或被串行版本劫持
      this.autoUpdater.allowDowngrade = false
      // 日志交由 CourseHub 本地脱敏诊断系统统一管控，禁用默认控制台直接打出
      this.autoUpdater.logger = null

      // 强门禁：覆盖 isUpdateSupported，确保 Beta 客户端绝对只接受公测版本（包含 -beta）
      if (typeof this.autoUpdater.isUpdateSupported === 'function') {
        const defaultIsUpdateSupported = this.autoUpdater.isUpdateSupported.bind(this.autoUpdater)
        this.autoUpdater.isUpdateSupported = (updateInfo) => {
          if (!defaultIsUpdateSupported(updateInfo)) return false
          const targetVer = updateInfo?.version || ''
          if (!targetVer.includes('-beta')) {
            return false
          }
          return true
        }
      }

      // 显式锁定官方 GitHub 公开发布源，防止任何非官方配置劫持
      this.autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'Qiuizi',
        repo: 'CourseHub',
        releaseType: 'prerelease'
      })

      // NSIS 覆盖更新目标目录指定：若打包运行，显式锚定当前执行程序所在目录
      if (app?.isPackaged && typeof process?.execPath === 'string') {
        const currentInstallDir = path.dirname(process.execPath)
        ;(this.autoUpdater as unknown as { installDirectory?: string }).installDirectory = currentInstallDir
      }
    } catch (err) {
      console.warn('[CourseHub Updater] Failed to configure autoUpdater options:', err)
    }

    this.bindEvents()
  }

  private bindEvents(): void {
    this.autoUpdater.on('checking-for-update', () => {
      this.state.status = 'checking'
      this.state.error = null
      this.notifyRenderer()
      void this.deps.store.recordDiagnostic({
        module: 'updater',
        level: 'info',
        type: 'checking',
        code: 'CHECKING',
        summary: `开始检查更新 (当前版本: v${this.state.currentVersion}, 渠道: ${this.state.channel})`,
        data: {
          currentVersion: this.state.currentVersion,
          channel: this.state.channel,
          manual: this.isManualCheck
        }
      })
    })

    this.autoUpdater.on('update-available', (info) => {
      // 深度防御：严防目标版本非公测版（防止下载并安装正式版安装包覆盖 Beta 运行环境）
      if (!info.version || !info.version.includes('-beta')) {
        this.state.status = 'not_available'
        this.state.lastCheckedAt = new Date().toISOString()
        this.notifyRenderer()
        void this.deps.store.recordDiagnostic({
          module: 'updater',
          level: 'warn',
          type: 'update_channel_rejected',
          code: 'UPDATE_CHANNEL_REJECTED',
          summary: `检测到非公测版本 v${info?.version || 'unknown'}，Beta 渠道严格拦截以防止覆盖正式版`,
          data: { targetVersion: info?.version }
        })
        return
      }

      this.state.status = 'available'
      this.state.lastCheckedAt = new Date().toISOString()
      this.state.error = null

      let releaseNotes: string | null = null
      if (typeof info.releaseNotes === 'string') {
        releaseNotes = info.releaseNotes
      } else if (Array.isArray(info.releaseNotes)) {
        releaseNotes = info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note || '')).join('\n\n')
      }

      const releaseInfo: UpdateReleaseInfo = {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes,
        releaseName: info.releaseName || `CourseHub v${info.version}`,
        releaseUrl: `${GITHUB_RELEASES_URL}/tag/v${info.version}`
      }
      this.state.info = releaseInfo
      this.notifyRenderer()

      const durationMs = this.checkStartTime > 0 ? Date.now() - this.checkStartTime : undefined
      void this.deps.store.recordDiagnostic({
        module: 'updater',
        level: 'info',
        type: 'update_available',
        code: 'UPDATE_AVAILABLE',
        summary: `发现新版本 v${info.version} (发布时间: ${info.releaseDate || '未知'})`,
        data: {
          targetVersion: info.version,
          releaseDate: info.releaseDate,
          durationMs
        }
      })
    })

    this.autoUpdater.on('update-not-available', (info) => {
      this.state.status = 'not_available'
      this.state.lastCheckedAt = new Date().toISOString()
      this.state.error = null
      this.notifyRenderer()

      const durationMs = this.checkStartTime > 0 ? Date.now() - this.checkStartTime : undefined
      void this.deps.store.recordDiagnostic({
        module: 'updater',
        level: 'info',
        type: 'update_not_available',
        code: 'UPDATE_NOT_AVAILABLE',
        summary: `当前已是最新版本 (v${this.state.currentVersion})`,
        data: {
          currentVersion: this.state.currentVersion,
          checkedVersion: info?.version || this.state.currentVersion,
          durationMs
        }
      })
    })

    this.autoUpdater.on('download-progress', (progress) => {
      this.state.status = 'downloading'
      const percent = Math.round(progress.percent * 10) / 10
      const progressInfo: UpdateProgressInfo = {
        percent,
        bytesPerSecond: Math.round(progress.bytesPerSecond || 0),
        transferred: progress.transferred || 0,
        total: progress.total || 0
      }
      this.state.progress = progressInfo
      this.notifyRenderer()

      // 进度脱敏打点：在 25%, 50%, 75%, 100% 阶段记录诊断日志，避免高频 I/O 泛洪
      const step = Math.floor(percent / 25) * 25
      if (step > this.lastLoggedProgress && step <= 100) {
        this.lastLoggedProgress = step
        void this.deps.store.recordDiagnostic({
          module: 'updater',
          level: 'info',
          type: 'download_progress',
          code: 'DOWNLOAD_PROGRESS',
          summary: `更新下载进度: ${step}%`,
          data: {
            percent: step,
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond: Math.round(progress.bytesPerSecond || 0)
          }
        })
      }
    })

    this.autoUpdater.on('update-downloaded', (info) => {
      this.state.status = 'downloaded'
      this.state.progress = {
        percent: 100,
        bytesPerSecond: 0,
        transferred: this.state.progress?.total || 0,
        total: this.state.progress?.total || 0
      }
      this.notifyRenderer()

      void this.deps.store.recordDiagnostic({
        module: 'updater',
        level: 'info',
        type: 'update_downloaded',
        code: 'UPDATE_DOWNLOADED',
        summary: `更新安装包已就绪，版本 v${info.version}，可随时重启安装`,
        data: {
          targetVersion: info.version,
          downloadedFile: info.downloadedFile ? path.basename(info.downloadedFile) : undefined
        }
      })
    })

    this.autoUpdater.on('error', (err) => {
      const classified = classifyUpdaterError(err)
      this.state.status = 'error'
      this.state.error = {
        code: classified.code,
        message: classified.message,
        rawError: classified.rawError,
        releasePageUrl: GITHUB_RELEASES_URL
      }
      this.notifyRenderer()

      const durationMs = this.checkStartTime > 0 ? Date.now() - this.checkStartTime : undefined
      void this.deps.store.recordDiagnostic({
        module: 'updater',
        level: 'warn',
        type: 'update_error',
        code: classified.code,
        summary: `更新服务异常 [${classified.code}]: ${classified.message}`,
        data: {
          classifiedCode: classified.code,
          rawError: classified.rawError,
          durationMs
        }
      })
    })
  }

  public notifyRenderer(): void {
    const win = this.deps.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater:status', { ...this.state })
    }
  }

  public getState(): UpdateState {
    return { ...this.state }
  }

  /**
   * 触发检测更新。
   * @param manual 是否由用户在界面手动点击触发
   */
  public async checkForUpdates(manual = false): Promise<IpcResult<UpdateState>> {
    if (this.state.status === 'checking' || this.state.status === 'downloading') {
      return ok({ ...this.state })
    }

    this.checkStartTime = Date.now()
    this.lastLoggedProgress = 0
    this.isManualCheck = manual

    // 开发环境未打包且无注入 Mock 时，平滑提示未打包
    if (!app?.isPackaged && !this.deps.updaterInstance) {
      this.state.status = 'not_available'
      this.state.lastCheckedAt = new Date().toISOString()
      this.notifyRenderer()
      return ok({ ...this.state })
    }

    try {
      await this.autoUpdater.checkForUpdates()
      return ok({ ...this.state })
    } catch (err) {
      const classified = classifyUpdaterError(err)
      this.state.status = 'error'
      this.state.error = {
        code: classified.code,
        message: classified.message,
        rawError: classified.rawError,
        releasePageUrl: GITHUB_RELEASES_URL
      }
      this.notifyRenderer()
      return fail('NETWORK_TIMEOUT', classified.message, true)
    }
  }

  /**
   * 用户确认后触发下载更新包。
   */
  public async downloadUpdate(): Promise<IpcResult<{ started: boolean }>> {
    if (this.state.status !== 'available' && this.state.status !== 'error') {
      return fail('INVALID_REQUEST', `当前状态为 ${this.state.status}，无需启动下载`)
    }

    if (!this.state.info?.version?.includes('-beta')) {
      return fail('INVALID_REQUEST', '非公测版更新包，Beta 客户端拒绝下载')
    }

    this.state.status = 'downloading'
    this.state.error = null
    this.lastLoggedProgress = 0
    this.notifyRenderer()

    void this.deps.store.recordDiagnostic({
      module: 'updater',
      level: 'info',
      type: 'downloading',
      code: 'DOWNLOADING',
      summary: `用户确认，开始下载更新包 v${this.state.info?.version || ''}`,
      data: { targetVersion: this.state.info?.version }
    })

    try {
      const downloadPromise = this.autoUpdater.downloadUpdate()
      if (downloadPromise && typeof (downloadPromise as Promise<unknown>).catch === 'function') {
        ;(downloadPromise as Promise<unknown>).catch((err: unknown) => {
          const classified = classifyUpdaterError(err)
          this.state.status = 'error'
          this.state.error = {
            code: classified.code,
            message: classified.message,
            rawError: classified.rawError,
            releasePageUrl: GITHUB_RELEASES_URL
          }
          this.notifyRenderer()
          void this.deps.store.recordDiagnostic({
            module: 'updater',
            level: 'warn',
            type: 'download_failed',
            code: classified.code,
            summary: `更新包异步下载失败: ${classified.message}`,
            data: {
              targetVersion: this.state.info?.version,
              rawError: classified.rawError
            }
          })
        })
      }
      return ok({ started: true })
    } catch (err) {
      const classified = classifyUpdaterError(err)
      this.state.status = 'error'
      this.state.error = {
        code: classified.code,
        message: classified.message,
        rawError: classified.rawError,
        releasePageUrl: GITHUB_RELEASES_URL
      }
      this.notifyRenderer()
      void this.deps.store.recordDiagnostic({
        module: 'updater',
        level: 'warn',
        type: 'download_failed',
        code: classified.code,
        summary: `启动下载更新包失败: ${classified.message}`,
        data: {
          targetVersion: this.state.info?.version,
          rawError: classified.rawError
        }
      })
      return fail('NETWORK_TIMEOUT', classified.message, true)
    }
  }

  /**
   * 安装更新并重启软件。
   * 前置安全门禁：校验是否有正在运行的耗时业务任务，并刷写平台 Cookies。
   */
  public async installUpdate(): Promise<IpcResult<{ quitting: boolean }>> {
    if (this.state.status !== 'downloaded') {
      return fail('INVALID_REQUEST', '更新包尚未下载完成，无法执行安装')
    }

    // 业务互斥安全检查
    if (this.deps.isBusy) {
      const busyCheck = this.deps.isBusy()
      if (busyCheck.busy) {
        return fail('STORAGE_WRITE_FAILED', busyCheck.reason || '当前正在进行重要任务，已暂缓重启更新')
      }
    }

    try {
      // 退出前强制持久化所有平台会话 Cookies 至 SQLite 数据库
      await flushAllPlatformSessions()

      void this.deps.store.recordDiagnostic({
        module: 'updater',
        level: 'info',
        type: 'install_initiated',
        code: 'UPDATE_INSTALL_INITIATED',
        summary: `更新安装已触发，准备重启进入安装向导 (目标版本: v${this.state.info?.version || ''})`,
        data: { targetVersion: this.state.info?.version }
      })

      // NSIS 安装参数：非静默弹出安装向导，安装后自动重新拉起应用
      // 允许用户审查安装路径，并覆盖当前安装目录
      setImmediate(() => {
        try {
          this.autoUpdater.quitAndInstall(false, true)
        } catch (e) {
          console.error('[CourseHub Updater] quitAndInstall failed:', e)
        }
      })

      return ok({ quitting: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return fail('STORAGE_WRITE_FAILED', `更新前清理失败：${msg}`)
    }
  }

  /**
   * 配置是否在用户下次正常关闭应用时自动安装。
   * Beta 3 专项安全策略：
   * 退出时自动安装由于绕过 isBusy() 业务繁忙检查和 flushAllPlatformSessions() 会话持久化，
   * 在 Beta 3 中强制关闭延后自动安装，确保所有更新必须经过安全门禁的“立即重启安装”。
   */
  public setInstallOnQuit(_installOnQuit: boolean): IpcResult<{ installOnQuit: boolean }> {
    this.autoUpdater.autoInstallOnAppQuit = false
    this.state.isInstallOnQuit = false
    this.notifyRenderer()

    void this.deps.store.recordDiagnostic({
      module: 'updater',
      level: 'warn',
      type: 'set_install_on_quit_disabled',
      code: 'SET_INSTALL_ON_QUIT_DISABLED',
      summary: 'Beta 3 强制关闭退出时延后自动安装，仅保留受安全门禁保护的“立即重启安装”',
      data: { requested: _installOnQuit }
    })

    return fail('INVALID_REQUEST', 'Beta 3 暂不支持退出时自动安装，请使用立即重启安装')
  }

  /**
   * 兜底入口：调用系统默认浏览器打开 GitHub Releases 网页。
   */
  public openReleasePage(): void {
    const url = this.state.info?.releaseUrl || GITHUB_RELEASES_URL
    void shell.openExternal(url)
  }
}
