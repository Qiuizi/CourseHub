import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Store } from '../../src/main/services/store'
import { registerIpc } from '../../src/main/ipc'
import { isIpcResult } from '../../src/shared/ipc'
import type { IpcDeps } from '../../src/main/ipc'

const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>()

const { mockDefaultUpdater } = vi.hoisted(() => {
  const { EventEmitter } = require('node:events')
  class MockAppUpdater extends EventEmitter {
    autoDownload = true
    autoInstallOnAppQuit = true
    allowPrerelease = false
    allowDowngrade = true
    channel: string | null = null
    logger: any = null
    feedUrlOptions: unknown = null

    isUpdateSupported(): boolean {
      return true
    }

    setFeedURL(options: unknown): void {
      this.feedUrlOptions = options
    }

    async checkForUpdates(): Promise<null> {
      this.emit('checking-for-update')
      this.emit('update-not-available', { version: '0.4.3-beta.4' })
      return null
    }

    async downloadUpdate(): Promise<string[]> {
      return []
    }

    quitAndInstall(): void {}
  }
  return { mockDefaultUpdater: new MockAppUpdater() }
})

vi.mock('electron-updater', () => ({
  autoUpdater: mockDefaultUpdater
}))

// 模拟 electron 模块环境
vi.mock('electron', () => {
  return {
    app: {
      getVersion: () => '0.4.3-beta.4',
      isPackaged: true
    },
    BrowserWindow: class {},
    shell: {
      openExternal: vi.fn()
    },
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, payload?: unknown) => Promise<unknown>) => {
        handlers.set(channel, fn)
      }
    },
    session: {
      fromPartition: () => ({})
    },
    Notification: class {
      static isSupported() {
        return false
      }
    }
  }
})

vi.mock('../../src/main/browser/platform-browser', () => ({
  flushAllPlatformSessions: vi.fn(async () => {})
}))

describe('自动更新全量 IPC 返回值合同与防二次嵌套回归测试 (v0.4.3-beta.4)', () => {
  let tmpDir: string
  let store: Store
  let deps: IpcDeps
  let mockSender: { id: string }
  let validEvent: { senderFrame: { url: string }; sender: unknown }

  beforeEach(async () => {
    handlers.clear()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coursehub-ipc-test-'))
    store = new Store(tmpDir)

    mockSender = { id: 'main-win-wc', send: vi.fn() } as any
    validEvent = {
      senderFrame: { url: 'file:///path/to/renderer/index.html' },
      sender: mockSender
    }

    const fakeWin = {
      isDestroyed: () => false,
      webContents: mockSender
    }

    deps = {
      store,
      getWindow: () => fakeWin as any,
      browsers: new Map(),
      geo: { isActive: () => false } as any
    }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('isIpcResult 合同校验器单元测试', () => {
    it('正确断言单层标准 IpcResult 结构', () => {
      expect(isIpcResult({ ok: true, data: { status: 'idle' } })).toBe(true)
      expect(
        isIpcResult({
          ok: false,
          error: { code: 'NETWORK_TIMEOUT', message: 'timeout', retryable: true }
        })
      ).toBe(true)
    })

    it('对非标准 IpcResult 结构（如业务内部对象）返回 false，避免误判', () => {
      // 平台章节读取返回包含 ok: boolean 但不含 data 的业务结构
      expect(isIpcResult({ ok: true, chapters: [] })).toBe(false)
      expect(isIpcResult({ ok: false, chapters: [], error: '平台暂不支持' })).toBe(false)
      expect(isIpcResult(null)).toBe(false)
      expect(isIpcResult(undefined)).toBe(false)
      expect(isIpcResult('some string')).toBe(false)
      expect(isIpcResult({ status: 'idle', channel: 'beta' })).toBe(false)
    })
  })

  describe('真实 registerIpc 注册层穿透测试（断言无嵌套 data）', () => {
    it('1. updater:get-state 必须单层包装，严禁出现 {ok:true,data:{ok:true,data:...}}', async () => {
      registerIpc(deps)
      const getStateHandler = handlers.get('updater:get-state')
      expect(getStateHandler).toBeDefined()

      const res = (await getStateHandler!(validEvent)) as any
      expect(res.ok).toBe(true)
      expect(res.data).toBeDefined()
      // 断言直接获得 UpdateState，而不是嵌套的 { ok: true, data: ... }
      expect(res.data.status).toBe('idle')
      expect(res.data.channel).toBe('beta')
      expect(res.data.currentVersion).toBe('0.4.3-beta.4')
      expect(res.data.data).toBeUndefined()
    })

    it('2. updater:check 必须单层包装，成功与失败均不得嵌套', async () => {
      const { updateManager } = registerIpc(deps)
      const checkHandler = handlers.get('updater:check')
      expect(checkHandler).toBeDefined()

      // 模拟成功检查
      const res = (await checkHandler!(validEvent, { manual: true })) as any
      expect(res.ok).toBe(true)
      expect(res.data).toBeDefined()
      expect(res.data.status).toBe('not_available')
      expect(res.data.currentVersion).toBe('0.4.3-beta.4')
      expect(res.data.data).toBeUndefined()

      // 模拟检查失败分支
      vi.spyOn(updateManager, 'checkForUpdates').mockResolvedValueOnce({
        ok: false,
        error: { code: 'NETWORK_TIMEOUT', message: '连接 GitHub 超时', retryable: true }
      })

      const errRes = (await checkHandler!(validEvent, { manual: true })) as any
      expect(errRes.ok).toBe(false)
      expect(errRes.error.code).toBe('NETWORK_TIMEOUT')
      expect(errRes.error.message).toContain('连接 GitHub 超时')
      // 严禁被 handle() 二次包裹成 { ok: true, data: { ok: false, error: ... } }
      expect(errRes.data).toBeUndefined()
    })

    it('3. updater:download 必须单层包装，无嵌套 data', async () => {
      registerIpc(deps)
      const downloadHandler = handlers.get('updater:download')
      expect(downloadHandler).toBeDefined()

      // 初始为 idle 时下载应受控返回 INVALID_REQUEST
      const invalidRes = (await downloadHandler!(validEvent)) as any
      expect(invalidRes.ok).toBe(false)
      expect(invalidRes.error.code).toBe('INVALID_REQUEST')
      expect(invalidRes.data).toBeUndefined()

      // 通过更新器事件流转为 available 状态
      mockDefaultUpdater.emit('update-available', {
        version: '0.4.3-beta.5',
        releaseDate: '2026-10-21',
        releaseNotes: '新版本',
        releaseName: 'v0.4.3-beta.5'
      })

      const successRes = (await downloadHandler!(validEvent)) as any
      expect(successRes.ok).toBe(true)
      expect(successRes.data).toEqual({ started: true })
      expect(successRes.data.data).toBeUndefined()
    })

    it('4. updater:install 必须单层包装，无嵌套 data', async () => {
      registerIpc(deps)
      const installHandler = handlers.get('updater:install')
      expect(installHandler).toBeDefined()

      // 未下载完成时应拒绝安装
      const notReadyRes = (await installHandler!(validEvent)) as any
      expect(notReadyRes.ok).toBe(false)
      expect(notReadyRes.error.code).toBe('INVALID_REQUEST')
      expect(notReadyRes.data).toBeUndefined()

      // 通过更新器事件模拟已就绪状态
      mockDefaultUpdater.emit('update-downloaded', {
        version: '0.4.3-beta.5'
      })

      const readyRes = (await installHandler!(validEvent)) as any
      expect(readyRes.ok).toBe(true)
      expect(readyRes.data).toEqual({ quitting: true })
      expect(readyRes.data.data).toBeUndefined()
    })

    it('5. updater:set-install-on-quit 必须单层包装，直接返回拒绝错误码', async () => {
      registerIpc(deps)
      const setQuitHandler = handlers.get('updater:set-install-on-quit')
      expect(setQuitHandler).toBeDefined()

      const res = (await setQuitHandler!(validEvent, { installOnQuit: true })) as any
      // 在 Beta 3 / Beta 4 中强制禁用延后安装
      expect(res.ok).toBe(false)
      expect(res.error.code).toBe('INVALID_REQUEST')
      expect(res.error.message).toContain('暂不支持退出时自动安装')
      expect(res.data).toBeUndefined()
    })

    it('6. updater:open-release-page 单层包裹 null', async () => {
      registerIpc(deps)
      const openPageHandler = handlers.get('updater:open-release-page')
      expect(openPageHandler).toBeDefined()

      const res = (await openPageHandler!(validEvent)) as any
      expect(res.ok).toBe(true)
      expect(res.data).toBeNull()
    })

    it('7. IPC Sender 安全校验严格生效，无权调用时返回标准安全错误码', async () => {
      registerIpc(deps)
      const getStateHandler = handlers.get('updater:get-state')!

      // 缺失 senderFrame
      const noFrameRes = (await getStateHandler({ senderFrame: null })) as any
      expect(noFrameRes.ok).toBe(false)
      expect(noFrameRes.error.code).toBe('INVALID_REQUEST')
      expect(noFrameRes.error.message).toContain('缺少 sender frame')

      // 非法远程 URL
      const evilEvent = {
        senderFrame: { url: 'https://evil.attacker.com/exploit.html' },
        sender: mockSender
      }
      const evilRes = (await getStateHandler(evilEvent)) as any
      expect(evilRes.ok).toBe(false)
      expect(evilRes.error.code).toBe('INVALID_REQUEST')
      expect(evilRes.error.message).toContain('远程页面无权调用本地 IPC')
    })
  })
})
