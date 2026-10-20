import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Store } from '../../src/main/services/store'
import { AppUpdateManager } from '../../src/main/services/updater'
import { classifyUpdaterError, formatBytes, formatSpeed, GITHUB_RELEASES_URL } from '../../src/shared/updater'
import type { AppUpdater } from 'electron-updater'

// 模拟 electron 模块与会话持久化
vi.mock('electron', () => {
  return {
    app: {
      getVersion: () => '0.4.3-beta.4',
      isPackaged: true
    },
    BrowserWindow: class {},
    shell: {
      openExternal: vi.fn()
    }
  }
})

vi.mock('../../src/main/browser/platform-browser', () => ({
  flushAllPlatformSessions: vi.fn(async () => {})
}))

class MockAppUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = false
  allowDowngrade = true
  channel: string | null = null
  logger: any = console
  feedUrlOptions: unknown = null
  installDirectory?: string
  quitAndInstallCalled = false
  quitAndInstallArgs: [boolean, boolean] | null = null
  downloadUpdateCalled = false
  checkForUpdatesCalled = false

  isUpdateSupported(_updateInfo: any): boolean {
    return true
  }

  setFeedURL(options: unknown): void {
    this.feedUrlOptions = options
  }

  async checkForUpdates(): Promise<null> {
    this.checkForUpdatesCalled = true
    this.emit('checking-for-update')
    return null
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloadUpdateCalled = true
    return []
  }

  quitAndInstall(isSilent = false, isForceRunAfter = false): void {
    this.quitAndInstallCalled = true
    this.quitAndInstallArgs = [isSilent, isForceRunAfter]
  }
}

describe('原生自动更新系统全流程验收测试 (v0.4.3-beta.4)', () => {
  let tmpDir: string
  let store: Store

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coursehub-updater-test-'))
    store = new Store(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('错误分类与脱敏安全 (classifyUpdaterError)', () => {
    it('正确识别 DNS 解析失败 (ENOTFOUND / getaddrinfo)', () => {
      const err = new Error('getaddrinfo ENOTFOUND github.com')
      const res = classifyUpdaterError(err)
      expect(res.code).toBe('UPDATE_DNS_ERROR')
      expect(res.message).toContain('无法解析 GitHub 域名')
      expect(res.rawError).toBe(err.message)
    })

    it('正确识别连接超时 (ETIMEDOUT / timeout)', () => {
      const err = new Error('connect ETIMEDOUT 140.82.112.4:443')
      const res = classifyUpdaterError(err)
      expect(res.code).toBe('UPDATE_TIMEOUT')
      expect(res.message).toContain('连接 GitHub 超时')
    })

    it('正确识别 HTTP 403 API 限流', () => {
      const err = new Error('HTTP 403: API rate limit exceeded for 123.45.67.89')
      const res = classifyUpdaterError(err)
      expect(res.code).toBe('UPDATE_HTTP_403')
      expect(res.message).toContain('HTTP 403')
    })

    it('正确识别 HTTP 404 资源不存在', () => {
      const err = new Error('Cannot find beta.yml in releases (HTTP 404)')
      const res = classifyUpdaterError(err)
      expect(res.code).toBe('UPDATE_HTTP_404')
      expect(res.message).toContain('HTTP 404')
    })

    it('正确识别 HTTP 5xx 服务端故障', () => {
      const err = new Error('GitHub server error 502 Bad Gateway')
      const res = classifyUpdaterError(err)
      expect(res.code).toBe('UPDATE_HTTP_5XX')
      expect(res.message).toContain('HTTP 5xx')
    })

    it('正确识别 SHA-512 校验失败与完整性受损', () => {
      const err = new Error('sha512 checksum mismatch: expected abc got def')
      const res = classifyUpdaterError(err)
      expect(res.code).toBe('UPDATE_CHECKSUM_MISMATCH')
      expect(res.message).toContain('SHA-512 完整性校验未通过')
    })

    it('自动剥离 URL 中的敏感 Token 与 Authorization 请求头', () => {
      const err = new Error('Failed to fetch https://api.github.com/repos?token=ghp_secretToken123456 with Bearer ghp_secretBearerToken987')
      const res = classifyUpdaterError(err)
      expect(res.rawError).not.toContain('ghp_secretToken123456')
      expect(res.rawError).not.toContain('ghp_secretBearerToken987')
      expect(res.rawError).toContain('token=***')
      expect(res.rawError).toContain('Bearer ***')
    })
  })

  describe('状态机流转与诊断记录 (AppUpdateManager)', () => {
    it('初始化时锁定 Beta 渠道、禁用自动静默下载并绑定官方发布源', () => {
      const mockUpdater = new MockAppUpdater()
      const manager = new AppUpdateManager({
        store,
        getWindow: () => null,
        updaterInstance: mockUpdater as unknown as AppUpdater
      })

      expect(mockUpdater.autoDownload).toBe(false)
      expect(mockUpdater.autoInstallOnAppQuit).toBe(false)
      expect(mockUpdater.allowPrerelease).toBe(true)
      expect(mockUpdater.channel).toBe('beta')
      expect(mockUpdater.allowDowngrade).toBe(false)
      expect(mockUpdater.feedUrlOptions).toEqual({
        provider: 'github',
        owner: 'Qiuizi',
        repo: 'CourseHub',
        releaseType: 'prerelease'
      })

      // 验证 isUpdateSupported 只允许带 -beta 的版本
      expect(mockUpdater.isUpdateSupported({ version: '0.4.3-beta.4' })).toBe(true)
      expect(mockUpdater.isUpdateSupported({ version: '0.4.4' })).toBe(false)
      expect(mockUpdater.isUpdateSupported({ version: '1.0.0' })).toBe(false)

      const state = manager.getState()
      expect(state.status).toBe('idle')
      expect(state.channel).toBe('beta')
      expect(state.currentVersion).toBe('0.4.3-beta.4')
    })

    it('检测到非公测版本（如正式版 0.4.4）时，严格拦截并转入 not_available，防止意外覆盖正式版', async () => {
      const mockUpdater = new MockAppUpdater()
      const manager = new AppUpdateManager({
        store,
        getWindow: () => null,
        updaterInstance: mockUpdater as unknown as AppUpdater
      })

      mockUpdater.emit('update-available', {
        version: '0.4.4', // 正式版无 -beta
        releaseDate: '2026-10-25T10:00:00Z',
        releaseNotes: '正式版发布',
        releaseName: 'CourseHub v0.4.4 Stable'
      })

      const state = manager.getState()
      expect(state.status).toBe('not_available')
      expect(state.info).toBeNull()

      // 等待诊断写盘
      await new Promise((r) => setTimeout(r, 60))
      const recent = await store.getRecentDiagnostics(10)
      const rejectedDiag = recent.find((r) => r.code === 'UPDATE_CHANNEL_REJECTED')
      expect(rejectedDiag).toBeDefined()
      expect(rejectedDiag?.data).toEqual({ targetVersion: '0.4.4' })
    })

    it('完整更新全生命周期流转：checking -> available -> downloading -> downloaded', async () => {
      const mockUpdater = new MockAppUpdater()
      const sentEvents: unknown[] = []
      const fakeWindow = {
        isDestroyed: () => false,
        webContents: {
          send: (_channel: string, payload: unknown) => {
            sentEvents.push(payload)
          }
        }
      }

      const manager = new AppUpdateManager({
        store,
        getWindow: () => fakeWindow as any,
        updaterInstance: mockUpdater as unknown as AppUpdater
      })

      // 1. 触发检查
      const checkRes = await manager.checkForUpdates(true)
      expect(checkRes.ok).toBe(true)
      expect(manager.getState().status).toBe('checking')

      // 2. 模拟收到 update-available 事件
      mockUpdater.emit('update-available', {
        version: '0.4.3-beta.4',
        releaseDate: '2026-10-20T10:00:00Z',
        releaseNotes: '1. 新增原生自动更新\n2. 修复地图底图',
        releaseName: 'CourseHub v0.4.3 Beta 4'
      })

      let state = manager.getState()
      expect(state.status).toBe('available')
      expect(state.info?.version).toBe('0.4.3-beta.4')
      expect(state.info?.releaseNotes).toContain('新增原生自动更新')

      // 3. 用户确认后开始下载
      const dlRes = await manager.downloadUpdate()
      expect(dlRes.ok).toBe(true)
      expect(mockUpdater.downloadUpdateCalled).toBe(true)
      expect(manager.getState().status).toBe('downloading')

      // 4. 模拟进度事件
      mockUpdater.emit('download-progress', {
        percent: 52.4,
        bytesPerSecond: 1024 * 1024 * 2.5,
        transferred: 52400000,
        total: 100000000
      })

      state = manager.getState()
      expect(state.status).toBe('downloading')
      expect(state.progress?.percent).toBe(52.4)
      expect(state.progress?.bytesPerSecond).toBe(Math.round(1024 * 1024 * 2.5))

      // 5. 模拟下载完成
      mockUpdater.emit('update-downloaded', {
        version: '0.4.3-beta.4',
        downloadedFile: 'C:\\Users\\test\\CourseHub-Setup-0.4.3-beta.4-x64.exe'
      })

      state = manager.getState()
      expect(state.status).toBe('downloaded')
      // 等待异步日志写盘完成
      await new Promise((r) => setTimeout(r, 60))

      // 检查脱敏诊断日志记录
      const recent = await store.getRecentDiagnostics(20)
      const codes = recent.map((r) => r.code)
      expect(codes).toContain('CHECKING')
      expect(codes).toContain('UPDATE_AVAILABLE')
      expect(codes).toContain('DOWNLOADING')
      expect(codes).toContain('DOWNLOAD_PROGRESS')
      expect(codes).toContain('UPDATE_DOWNLOADED')
    })

    it('发生网络错误时，状态机安全转入 error 并记录脱敏诊断', async () => {
      const mockUpdater = new MockAppUpdater()
      const manager = new AppUpdateManager({
        store,
        getWindow: () => null,
        updaterInstance: mockUpdater as unknown as AppUpdater
      })

      mockUpdater.emit('error', new Error('getaddrinfo ENOTFOUND github.com'))

      const state = manager.getState()
      expect(state.status).toBe('error')
      expect(state.error?.code).toBe('UPDATE_DNS_ERROR')
      expect(state.error?.releasePageUrl).toBe(GITHUB_RELEASES_URL)

      // 等待异步日志写盘完成
      await new Promise((r) => setTimeout(r, 60))

      const recent = await store.getRecentDiagnostics(10)
      const errDiag = recent.find((r) => r.code === 'UPDATE_DNS_ERROR')
      expect(errDiag).toBeDefined()
      expect(errDiag?.level).toBe('warn')
    })
  })

  describe('安全安装门禁与冲突拦截 (installUpdate)', () => {
    it('当应用正处于连续播放、AI生成或课堂测试时，拦截立即重启并给出明确提示', async () => {
      const mockUpdater = new MockAppUpdater()
      let busy = true
      const manager = new AppUpdateManager({
        store,
        getWindow: () => null,
        isBusy: () => ({ busy, reason: '正在进行连续课程播放，请暂停或结束后再更新' }),
        updaterInstance: mockUpdater as unknown as AppUpdater
      })

      mockUpdater.emit('update-downloaded', { version: '0.4.3-beta.4' })

      // 任务进行中时尝试安装
      const res = await manager.installUpdate()
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.code).toBe('STORAGE_WRITE_FAILED')
        expect(res.error.message).toContain('正在进行连续课程播放')
      }
      expect(mockUpdater.quitAndInstallCalled).toBe(false)

      // 任务结束后再次安装，应允许通过
      busy = false
      const allowRes = await manager.installUpdate()
      expect(allowRes.ok).toBe(true)

      // 等待 setImmediate 触发
      await new Promise((r) => setImmediate(r))
      expect(mockUpdater.quitAndInstallCalled).toBe(true)
      expect(mockUpdater.quitAndInstallArgs).toEqual([true, true])
    })

    it('downloadUpdate 异步 Promise 拒绝时，正确进入 error 状态并记录脱敏诊断，支持重试', async () => {
      const mockUpdater = new MockAppUpdater()
      mockUpdater.downloadUpdate = async () => {
        throw new Error('connect ETIMEDOUT 140.82.112.4:443')
      }

      const manager = new AppUpdateManager({
        store,
        getWindow: () => null,
        updaterInstance: mockUpdater as unknown as AppUpdater
      })

      // 模拟收到可用更新
      mockUpdater.emit('update-available', {
        version: '0.4.3-beta.4',
        releaseDate: '2026-10-20T10:00:00Z',
        releaseNotes: '公测更新',
        releaseName: 'CourseHub v0.4.3 Beta 4'
      })

      expect(manager.getState().status).toBe('available')

      // 启动下载，Promise 内部异步拒绝
      const res = await manager.downloadUpdate()
      expect(res.ok).toBe(true)

      // 等待微任务与事件流转
      await new Promise((r) => setTimeout(r, 60))

      const state = manager.getState()
      expect(state.status).toBe('error')
      expect(state.error?.code).toBe('UPDATE_TIMEOUT')
      expect(state.error?.message).toContain('连接 GitHub 超时')

      // 在 error 状态下支持重试
      mockUpdater.downloadUpdate = async () => []
      const retryRes = await manager.downloadUpdate()
      expect(retryRes.ok).toBe(true)
      expect(manager.getState().status).toBe('downloading')
    })

    it('setInstallOnQuit 在 Beta 3 中强制禁用延后安装，锁定为仅允许立即重启安装', () => {
      const mockUpdater = new MockAppUpdater()
      const manager = new AppUpdateManager({
        store,
        getWindow: () => null,
        updaterInstance: mockUpdater as unknown as AppUpdater
      })

      const res = manager.setInstallOnQuit(true)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.code).toBe('INVALID_REQUEST')
      }
      expect(mockUpdater.autoInstallOnAppQuit).toBe(false)
      expect(manager.getState().isInstallOnQuit).toBe(false)
    })
  })

  describe('辅助工具函数 (formatBytes / formatSpeed)', () => {
    it('正确转换字节与网速展示', () => {
      expect(formatBytes(0)).toBe('0 B')
      expect(formatBytes(1024)).toBe('1.0 KB')
      expect(formatBytes(1024 * 1024 * 5.25)).toBe('5.3 MB')
      expect(formatSpeed(1024 * 1024 * 2.3)).toBe('2.3 MB/s')
    })
  })
})
