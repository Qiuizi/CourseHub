/**
 * 类型化 IPC 注册。
 *
 * 所有通道都做 sender frame 校验、schema 校验与大小限制（开发文档 §10）。
 * 远程平台页面拿不到任何 preload，因此不可能调用这些通道。
 */

import { app, BrowserWindow, ipcMain, session, nativeImage, Notification } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type {
  AIResult,
  Bounds,
  ClassroomActivityItem,
  ClassroomQuestion,
  GeoTestConfig,
  PlatformId,
  PlayPolicy,
  TestActionPlan
} from '@shared/types'
import { ok, toErrorResult, CodedError } from '@shared/ipc'
import { isAllowedRate } from '@shared/video'
import { validateGeoPoint } from '@shared/geo'
import { getAdapter } from '../adapters'
import {
  PLATFORM_CONFIGS,
  PlatformBrowser,
  isOriginAllowed,
  fixturesDir,
  sessionNameFor,
  testSession
} from '../browser/platform-browser'
import { TestbedServer } from '../testbed/testbed-server'
import { GeoTestManager } from '../geo-test/geo-test-manager'
import { PlayerObserver, commandPlayer } from '../video/player-observer'
import { ContinuousManager } from '../video/continuous-manager'
import { inspectChapterInWebContents } from '../video/task-inspector'
import { DeepSeekClient } from '../ai/deepseek-client'
import {
  extractQuestions,
  previewTestAction,
  executeTestAction,
  suggestMapping
} from '../classroom/question-extractor'
import { ClassroomNotificationManager } from '../classroom/notification-manager'
import { redactForOutbound } from '@shared/deepseek'
import { buildTestPlan } from '@shared/question'
import type { Store } from '../services/store'

const MAX_TEXT_LEN = 20_000

function assertSender(
  event: Electron.IpcMainInvokeEvent,
  getWindow?: () => BrowserWindow | null
): void {
  const frame = event.senderFrame
  if (!frame) throw new CodedError('INVALID_REQUEST', '缺少 sender frame')

  const win = getWindow?.()
  if (win && !win.isDestroyed() && event.sender !== win.webContents) {
    throw new CodedError('INVALID_REQUEST', '非主窗口无权调用本地 IPC')
  }

  const url = frame.url
  const devServer = process.env.ELECTRON_RENDERER_URL
  const isAllowedDev = devServer ? url.startsWith(devServer) : false
  const isLocalFile = url.startsWith('file://')
  const isLocalHost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)

  if (!isLocalFile && !isAllowedDev && !isLocalHost) {
    throw new CodedError('INVALID_REQUEST', '远程页面无权调用本地 IPC')
  }
}

function str(v: unknown, field: string, maxLen = 512): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new CodedError('INVALID_REQUEST', `${field} 必须是非空字符串`)
  }
  if (v.length > maxLen) throw new CodedError('INVALID_REQUEST', `${field} 超长`)
  return v
}

function platformId(v: unknown): PlatformId {
  const s = str(v, 'platformId', 32)
  if (!PLATFORM_CONFIGS.some((c) => c.id === s)) {
    throw new CodedError('INVALID_REQUEST', `未知平台 ${s}`)
  }
  return s as PlatformId
}

export interface IpcDeps {
  store: Store
  getWindow: () => BrowserWindow | null
  browsers: Map<PlatformId, PlatformBrowser>
  geo: GeoTestManager
  testbedServer?: TestbedServer
}

export function registerIpc(deps: IpcDeps): { ai: DeepSeekClient; dispose: () => void } {
  const ai = new DeepSeekClient(deps.store)
  const observers = new Map<string, PlayerObserver>()
  const continuousManager = new ContinuousManager({
    store: deps.store,
    getWindow: deps.getWindow,
    getWebContents: (platformId) => deps.browsers.get(platformId)?.webContents ?? null
  })
  const notificationManager = new ClassroomNotificationManager({
    store: deps.store,
    sender: (payload) => {
      const win = deps.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('classroom:activity-notify', payload)
      }
      if (Notification.isSupported()) {
        try {
          const notification = new Notification({
            title: payload.notifTitle,
            body: payload.notifBody,
            silent: false
          })
          notification.on('click', () => {
            const targetWin = deps.getWindow()
            if (targetWin) {
              if (targetWin.isMinimized()) targetWin.restore()
              targetWin.show()
              targetWin.focus()
              targetWin.webContents.send('classroom:notification-clicked', {
                platformId: payload.platformId,
                activityId: payload.activityId,
                sourceUrl: payload.sourceUrl
              })
            }
          })
          notification.show()
        } catch {
          // 桌面通知在特定环境静默降级
        }
      }
    }
  })

  const handle = <T>(
    channel: string,
    fn: (event: Electron.IpcMainInvokeEvent, payload: unknown) => Promise<T>
  ): void => {
    ipcMain.handle(channel, async (event, payload): Promise<unknown> => {
      try {
        assertSender(event, deps.getWindow)
        return ok(await fn(event, payload))
      } catch (e) {
        return toErrorResult(e)
      }
    })
  }

  /* ------------------------------ 平台与导航 ------------------------------ */

  handle('platform:list', async () =>
    PLATFORM_CONFIGS.map((c) => {
      const adapter = getAdapter(c.id)
      return {
        id: c.id,
        name: c.name,
        homeUrl: c.homeUrl,
        capabilities: adapter?.capabilities ?? {},
        adapterVersion: adapter?.version ?? null
      }
    })
  )

  handle('platform:auth', async (_e, payload) => {
    const id = platformId((payload as { platformId?: unknown })?.platformId)
    const adapter = getAdapter(id)
    if (!adapter) throw new CodedError('NOT_FOUND', `未知平台 ${id}`)
    const b = deps.browsers.get(id)
    const ses = b
      ? b.getSession()
      : id === 'testbed'
        ? testSession()
        : session.fromPartition(sessionNameFor(id))
    const snapshot = await adapter.detectAuth(ses, b?.currentUrl || undefined)
    return { platformId: id, ...snapshot, checkedAt: new Date().toISOString() }
  })

  handle('platform:open', async (_e, payload) => {
    const p = payload as { platformId?: unknown; fixture?: unknown }
    const id = platformId(p?.platformId)
    const win = deps.getWindow()
    if (!win) throw new CodedError('INVALID_REQUEST', '主窗口不存在')
    let browser = deps.browsers.get(id)
    if (!browser) {
      browser = PlatformBrowser.create(id)
      deps.browsers.set(id, browser)
    }
    browser.attach(win)

    // 自有测试站点：加载随包分发的本地 fixture（文件名校验，防路径穿越）
    if (id === 'testbed') {
      const name = typeof p?.fixture === 'string' ? p.fixture : 'video-task.html'
      if (!/^[a-z0-9-]+\.html$/i.test(name)) {
        throw new CodedError('INVALID_REQUEST', 'fixture 文件名非法')
      }
      const cfg = PLATFORM_CONFIGS.find((c) => c.id === id)!
      cfg.homeUrl = pathToFileURL(path.join(fixturesDir(), name)).href
      const res = await browser.navigate(cfg.homeUrl)
      if (!res.ok) throw new CodedError('UNSUPPORTED', res.error ?? '导航失败')
      return { platformId: id, url: browser.currentUrl }
    }

    await browser.loadHome()
    return { platformId: id, url: browser.currentUrl }
  })

  /** 测试台专用：切换到指定 fixture 页。 */
  handle('testbed:load-fixture', async (_e, payload) => {
    const p = payload as { fixture?: unknown }
    const name = str(p?.fixture, 'fixture', 64)
    if (!/^[a-z0-9-]+\.html$/i.test(name)) {
      throw new CodedError('INVALID_REQUEST', 'fixture 文件名非法')
    }
    const win = deps.getWindow()
    if (!win) throw new CodedError('INVALID_REQUEST', '主窗口不存在')
    let browser = deps.browsers.get('testbed')
    if (!browser) {
      browser = PlatformBrowser.create('testbed')
      deps.browsers.set('testbed', browser)
    }
    browser.attach(win)
    const url = pathToFileURL(path.join(fixturesDir(), name)).href
    const res = await browser.navigate(url)
    if (!res.ok) throw new CodedError('UNSUPPORTED', res.error ?? '导航失败')
    await deps.store.log('info', 'testbed_fixture_loaded', { fixture: name })
    return { url: browser.currentUrl, fixture: name }
  })

  handle('browser:navigate', async (_e, payload) => {
    const p = payload as { platformId?: unknown; url?: unknown }
    const id = platformId(p?.platformId)
    const url = str(p?.url, 'url', 2048)
    const browser = deps.browsers.get(id)
    if (!browser) throw new CodedError('NOT_FOUND', '平台视图未打开')
    const res = await browser.navigate(url)
    if (!res.ok) throw new CodedError('UNSUPPORTED', res.error ?? '导航被拒绝')
    return { url: browser.currentUrl }
  })

  handle('browser:command', async (_e, payload) => {
    const p = payload as { platformId?: unknown; command?: unknown }
    const id = platformId(p?.platformId)
    const command = str(p?.command, 'command', 16)
    const browser = deps.browsers.get(id)
    if (!browser) throw new CodedError('NOT_FOUND', '平台视图未打开')
    if (command === 'reload') await browser.reload()
    else if (command === 'back') await browser.goBack()
    else if (command === 'forward') await browser.goForward()
    else throw new CodedError('INVALID_REQUEST', `未知命令 ${command}`)
    return { url: browser.currentUrl }
  })

  handle('browser:set-bounds', async (_e, payload) => {
    const p = payload as { platformId?: unknown; bounds?: unknown }
    const id = platformId(p?.platformId)
    const b = p?.bounds as Bounds | undefined
    if (!b || typeof b.x !== 'number' || typeof b.y !== 'number' ||
        typeof b.width !== 'number' || typeof b.height !== 'number') {
      throw new CodedError('INVALID_REQUEST', 'bounds 非法')
    }
    deps.browsers.get(id)?.setBounds(b)
    return { applied: true }
  })

  handle('browser:set-visible', async (_e, payload) => {
    const p = payload as { platformId?: unknown; visible?: unknown }
    const id = platformId(p?.platformId)
    if (typeof p?.visible !== 'boolean') throw new CodedError('INVALID_REQUEST', 'visible 必须是布尔')
    deps.browsers.get(id)?.setVisible(p.visible)
    return { visible: p.visible }
  })

  handle('browser:open-external', async (_e, payload) => {
    const p = payload as { platformId?: unknown; url?: unknown }
    const id = platformId(p?.platformId)
    const url = str(p?.url, 'url', 2048)
    const cfg = PLATFORM_CONFIGS.find((c) => c.id === id)!
    if (!isOriginAllowed(url, cfg.allowedOrigins, cfg.allowFileProtocol)) {
      throw new CodedError('UNSUPPORTED', '该 URL 不在平台白名单内')
    }
    deps.browsers.get(id)?.openExternal(url)
    return { opened: true }
  })

  handle('browser:capture-view', async (_e, payload) => {
    const p = payload as {
      platformId?: unknown
      mode?: unknown
      questionId?: unknown
    }
    const id = platformId(p?.platformId)
    const mode = (p?.mode === 'full-question' || p?.mode === 'full-page') ? p.mode : 'viewport'
    const targetQid = typeof p?.questionId === 'string' ? p.questionId : undefined

    const b = deps.browsers.get(id)
    const wc = b?.webContents
    if (!wc || wc.isDestroyed()) throw new CodedError('NOT_FOUND', '平台视图未打开')

    let dataUrl = ''
    let width = 0
    let height = 0
    let isOverflow = false
    let notice: string | null = null

    interface QuestionDomMetrics {
      found: boolean
      height: number
      width: number
      scrollHeight: number
      isTall: boolean
      dpr: number
      top: number
    }

    /** CDP 全页截图辅助函数（含超时与自动 detach）*/
    const cdpFullPageScreenshot = async (): Promise<string | null> => {
      let attached = false
      try {
        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3')
          attached = true
        }
        const cdpPromise = wc.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true
        }) as Promise<{ data: string }>
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('CDP screenshot timeout')), 4000)
        )
        const screenshot = await Promise.race([cdpPromise, timeoutPromise])
        return screenshot.data
      } catch {
        return null
      } finally {
        if (attached && wc.debugger.isAttached()) {
          try { wc.debugger.detach() } catch {}
        }
      }
    }

    if (mode === 'full-page') {
      const cdpData = await cdpFullPageScreenshot()
      if (cdpData) {
        const buf = Buffer.from(cdpData, 'base64')
        const img = nativeImage.createFromBuffer(buf)
        const size = img.getSize()
        dataUrl = `data:image/png;base64,${cdpData}`
        width = size.width
        height = size.height
        isOverflow = height > 1000
        if (isOverflow) {
          notice = `完整长截屏已生成（高度 ${height}px），已涵盖页面全部题目与选项。`
        }
      } else {
        const img = await wc.capturePage()
        dataUrl = img.toDataURL()
        const size = img.getSize()
        width = size.width
        height = size.height
      }
    } else if (mode === 'full-question' && targetQid) {
      // 遍历全部 frame，寻找指定题目节点并将其滚动到视口顶部
      const frames: Electron.WebFrameMain[] = []
      const collect = (f: Electron.WebFrameMain) => {
        frames.push(f)
        for (const ch of f.frames) collect(ch)
      }
      collect(wc.mainFrame)

      let nodeMetrics: QuestionDomMetrics | null = null
      let foundInCrossOrigin = false

      for (const frame of frames) {
        try {
          const res = (await frame.executeJavaScript(`(() => {
            const qid = ${JSON.stringify(targetQid)};
            // 多种 ID 属性兼容超星、雨课堂等平台及复合稳定 ID
            const el = document.getElementById(qid) ||
              document.querySelector('[data-id="' + CSS.escape(qid) + '"]') ||
              document.querySelector('[data-questionid="' + CSS.escape(qid) + '"]') ||
              document.querySelector('[data-qid="' + CSS.escape(qid) + '"]') ||
              document.querySelector('[data-problem-id="' + CSS.escape(qid) + '"]') ||
              document.querySelector('[data-ch-composite-id="' + CSS.escape(qid) + '"]') ||
              document.querySelector('[data-ch-question="' + CSS.escape(qid) + '"]') ||
              document.querySelector('#' + CSS.escape(qid));
            if (!el) return { found: false };

            // 先展开可能折叠的题目内容（如 display:none 的子元素）
            const collapsed = el.querySelectorAll('[style*="display: none"], [style*="display:none"]');
            collapsed.forEach(function(c) { c.style.display = ''; });

            // 若在嵌套 iframe 中：递归展开父级 iframe 尺寸并滚入视口，防止外层容器裁切长题目
            try {
              let curFrame = window.frameElement;
              while (curFrame) {
                curFrame.scrollIntoView({ behavior: 'instant', block: 'start' });
                const elRect = el.getBoundingClientRect();
                const neededH = Math.max(el.scrollHeight, elRect.height + elRect.top + 60);
                if (curFrame.offsetHeight < neededH) {
                  curFrame.style.minHeight = neededH + 'px';
                }
                curFrame = curFrame.ownerDocument?.defaultView?.frameElement;
              }
            } catch (_) {}

            el.scrollIntoView({ behavior: 'instant', block: 'start' });
            // 额外向上偏移 10px，避免被 sticky header 遮住
            window.scrollBy(0, -10);

            const rect = el.getBoundingClientRect();
            const scrollH = el.scrollHeight || rect.height;
            const dpr = window.devicePixelRatio || 1;
            // 超出视口高度的 85% 就算"长题"，需要特殊截图
            const viewportH = window.innerHeight || 800;
            const isTall = rect.height > (viewportH * 0.85) || scrollH > (viewportH * 0.85);
            return {
              found: true,
              height: Math.round(rect.height),
              width: Math.round(rect.width),
              scrollHeight: Math.round(scrollH),
              isTall,
              dpr,
              top: Math.round(rect.top)
            };
          })()`, true)) as QuestionDomMetrics | null
          if (res?.found) {
            nodeMetrics = res
            break
          }
        } catch (frameErr) {
          // 跨域 iframe 会抛出访问拒绝错误，记录标记
          const msg = frameErr instanceof Error ? frameErr.message : String(frameErr)
          if (msg.includes('cross-origin') || msg.includes('CORS') || msg.includes('Blocked')) {
            foundInCrossOrigin = true
          }
        }
      }

      if (!nodeMetrics?.found && foundInCrossOrigin) {
        // 无法穿透跨域 frame，提示用户截可见视口
        notice = '⚠️ 该题目在跨域 iframe 中，无法直接定位节点。已截取当前可见视口，请手动滚动到题目区域后重新截图。'
      }

      // 等待 DOM 渲染与布局稳定（增加到 300ms，保证 React/Vue 渲染完成）
      await new Promise((r) => setTimeout(r, 300))

      if (nodeMetrics?.isTall) {
        // 超出视口的长题：优先采用 CDP 全页截图（含 captureBeyondViewport）
        const cdpData = await cdpFullPageScreenshot()
        if (cdpData) {
          const buf = Buffer.from(cdpData, 'base64')
          const img = nativeImage.createFromBuffer(buf)
          const size = img.getSize()
          dataUrl = `data:image/png;base64,${cdpData}`
          width = size.width
          height = size.height
          isOverflow = true
          const dpr = nodeMetrics.dpr || 1
          notice = `超视口长题已完整截取（逻辑高度 ${nodeMetrics.scrollHeight}px，DPI ${dpr}x，图片实际 ${height}px）。题干与所有选项均已捕获。`
        } else {
          // CDP 失败（如跨域 webview），降级为视口截图 + 文本提示
          const img = await wc.capturePage()
          const pngData = img.toPNG()
          // 检测全黑截图（像素全为 0）
          const isBlack = pngData.length > 0 && pngData.subarray(0, 200).every(b => b === 0)
          if (!isBlack) {
            dataUrl = img.toDataURL()
          }
          const size = img.getSize()
          width = size.width
          height = size.height
          isOverflow = true
          notice = `题目高度超出视口（${nodeMetrics.scrollHeight}px），CDP 截图失败，已截取当前可见区域。` +
            `题干文本已完整提取至编辑框，可直接发送分析。`
        }
      } else if (nodeMetrics?.found) {
        // 题目在视口内，普通截图即可
        const img = await wc.capturePage()
        const pngData = img.toPNG()
        const isBlack = pngData.length > 0 && pngData.subarray(0, 200).every(b => b === 0)
        dataUrl = isBlack ? '' : img.toDataURL()
        const size = img.getSize()
        width = size.width
        height = size.height
        isOverflow = false
        if (isBlack) {
          notice = '⚠️ 截图全黑（可能是 GPU 渲染延迟），请稍后重试或使用「完整长题截图」。'
        }
      } else {
        // 未找到题目节点，截当前视口
        const img = await wc.capturePage()
        dataUrl = img.toDataURL()
        const size = img.getSize()
        width = size.width
        height = size.height
        isOverflow = false
        notice = `⚠️ 未在当前页面找到题目节点（ID: ${targetQid}），已截取当前视口。` +
          (foundInCrossOrigin ? '（题目可能在跨域 iframe 中）' : '（页面可能未完全加载）')
      }
    } else {
      // 默认：当前可见视口快速截图
      const img = await wc.capturePage()
      const pngData = img.toPNG()
      const isBlack = pngData.length > 0 && pngData.subarray(0, 200).every(b => b === 0)
      dataUrl = isBlack ? '' : img.toDataURL()
      const size = img.getSize()
      width = size.width
      height = size.height
      isOverflow = false
      if (isBlack) {
        notice = '⚠️ 截图全黑（GPU 渲染延迟），请稍后重试截图。'
      }
    }

    return { dataUrl, width, height, mode, isOverflow, notice }
  })

  /* -------------------------------- 签到 -------------------------------- */

  handle('classroom:today-signins', async (_e, payload) => {
    const p = payload as { platformId?: unknown } | undefined
    const id = typeof p?.platformId === 'string' ? p.platformId : 'testbed'

    if (id === 'testbed') {
      return {
        state: 'supported',
        events: [
          {
            id: 'test-sign-01',
            platformId: 'testbed',
            courseId: 'test-course-01',
            title: '随堂测试 · 普通快速打卡',
            status: 'open',
            statusSource: 'provider_api',
            kind: 'normal',
            startAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            endAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            locationRequired: false,
            locationText: null,
            confidence: 'high'
          },
          {
            id: 'test-sign-02',
            platformId: 'testbed',
            courseId: 'test-course-01',
            title: '随堂测试 · 现场定位签到',
            status: 'open',
            statusSource: 'provider_api',
            kind: 'location',
            startAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            endAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            locationRequired: true,
            locationText: '北京市天安门（39.9042, 116.4074）半径500m',
            confidence: 'high'
          }
        ],
        fetchedAt: new Date().toISOString(),
        reason: '测试台活跃签到活动（本地 fixture）'
      }
    }

    if (id === 'chaoxing' || id === 'yuketang') {
      const b = deps.browsers.get(id as PlatformId)
      const ses = b ? b.getSession() : session.fromPartition(sessionNameFor(id as PlatformId))
      const adapter = getAdapter(id as PlatformId)
      if (adapter?.listTodaySignIns) {
        return adapter.listTodaySignIns(ses)
      }
    }

    const cached = await deps.store.readJson<{ fetchedAt: string | null; events: unknown[] }>(
      'cache/signins.json',
      { fetchedAt: null, events: [] }
    )
    return {
      state: 'unverified',
      events: [],
      fetchedAt: cached.fetchedAt,
      reason: '平台适配器未在真实账号验证；本次交付不提供伪造签到数据'
    }
  })

  handle('classroom:activities', async (_e, payload) => {
    const p = payload as { platformId?: unknown } | undefined
    const id = (typeof p?.platformId === 'string' ? p.platformId : 'testbed') as PlatformId
    const adapter = getAdapter(id)
    if (!adapter) throw new CodedError('NOT_FOUND', `未知平台 ${id}`)

    const b = deps.browsers.get(id)
    const ses = b
      ? b.getSession()
      : id === 'testbed'
        ? testSession()
        : session.fromPartition(sessionNameFor(id))

    if (!adapter.listActivities) {
      return {
        state: 'unsupported',
        activities: [],
        fetchedAt: new Date().toISOString(),
        reason: `${id} 平台未提供活动列表端点`
      }
    }

    const res = await adapter.listActivities(ses)
    if (res.state === 'supported' && Array.isArray(res.activities)) {
      await notificationManager.processActivities(id, res.activities)
    }
    return res
  })

  handle('classroom:notified-ids', async () => {
    return await notificationManager.getNotifiedKeys()
  })

  handle('classroom:test-notify', async (_e, payload) => {
    const p = payload as { title?: unknown; courseName?: unknown; sourceUrl?: unknown; category?: unknown } | undefined
    const testAct: ClassroomActivityItem = {
      id: `test-act-${Date.now()}`,
      platformId: 'testbed',
      courseId: 'test-course-01',
      courseName: typeof p?.courseName === 'string' ? p.courseName : '全栈自动化实战课',
      classId: 'sec-01',
      title: typeof p?.title === 'string' ? p.title : '随堂签到与活动通知',
      category: (p?.category as any) || 'sign_in',
      status: 'open',
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      sourceUrl: typeof p?.sourceUrl === 'string' ? p.sourceUrl : 'https://mooc1.chaoxing.com',
      fetchedAt: new Date().toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'normal',
      confidence: 'high'
    }
    await notificationManager.recordKey(`testbed:${testAct.id}:new`)
    await notificationManager.recordKey(testAct.id)

    const win = deps.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('classroom:activity-notify', testAct)
    }

    if (Notification.isSupported()) {
      const notif = new Notification({
        title: `[${testAct.courseName}] ${testAct.title}`,
        body: '课堂活动已发布，点击前往官方页面处理',
        silent: false
      })
      notif.on('click', () => {
        const targetWin = deps.getWindow()
        if (targetWin) {
          if (targetWin.isMinimized()) targetWin.restore()
          targetWin.show()
          targetWin.focus()
          targetWin.webContents.send('classroom:notification-clicked', {
            platformId: testAct.platformId,
            activityId: testAct.id,
            sourceUrl: testAct.sourceUrl
          })
        }
      })
      notif.show()
    }
    return { ok: true, activity: testAct }
  })


  handle('platform:courses', async (_e, payload) => {
    const p = payload as { platformId?: unknown }
    const id = platformId(p?.platformId)
    if (id === 'testbed') {
      return {
        state: 'supported',
        courses: [
          { courseId: 'test-course-01', classId: 'sec-01', name: '全栈自动化实战课（自有测试）' }
        ]
      }
    }
    const b = deps.browsers.get(id)
    const ses = b ? b.getSession() : session.fromPartition(sessionNameFor(id))
    const adapter = getAdapter(id)
    if (!adapter?.listCourses) {
      return { state: 'unsupported', courses: [], error: '平台暂不支持课程列表读取' }
    }
    const currentUrl = b?.currentUrl || undefined
    const res = await adapter.listCourses(ses, currentUrl)
    void deps.store.log('info', 'platform_courses_fetched', {
      platformId: id,
      state: res.state,
      count: res.courses?.length ?? 0,
      error: res.error ?? null
    })
    return res
  })

  handle('platform:chapters', async (_e, payload) => {
    const p = payload as {
      platformId?: unknown
      courseId?: unknown
      clazzId?: unknown
      cpi?: unknown
    }
    const id = platformId(p?.platformId)
    const courseId = str(p?.courseId, 'courseId', 64)
    const clazzId = str(p?.clazzId, 'clazzId', 64)
    const cpi = typeof p?.cpi === 'string' ? p.cpi : '0'

    if (id === 'testbed') {
      return {
        ok: true,
        chapters: [
          {
            courseId,
            clazzId,
            chapterId: 'test-unit-01',
            parentId: null,
            title: '第 1 章 自动化实战与观测实验',
            order: 1,
            taskType: 'unknown',
            taskUrl: null,
            status: 'unknown',
            source: 'testbed',
            detectionMethod: 'uninspected',
            confidence: 'low',
            attachments: []
          },
          {
            courseId,
            clazzId,
            chapterId: 'test-chap-01',
            parentId: 'test-unit-01',
            title: '1.1 播放器控制与观测测试',
            order: 2,
            taskType: 'video',
            taskUrl: pathToFileURL(path.join(fixturesDir(), 'video-task.html')).href,
            status: 'not_started',
            source: 'testbed',
            detectionMethod: 'dom_element',
            confidence: 'high',
            attachments: [
              {
                chapterId: 'test-chap-01',
                taskId: 't1',
                taskType: 'video',
                title: '任务 1 · 开场导学',
                sourceUrl: 'coursehub-test-video.mp4',
                source: 'dom_element',
                detectionMethod: 'dom_element',
                confidence: 'high'
              }
            ]
          }
        ]
      }
    }

    const b = deps.browsers.get(id)
    const ses = b ? b.getSession() : session.fromPartition(sessionNameFor(id))
    const adapter = getAdapter(id)
    if (!adapter?.listChapters) {
      return { ok: false, chapters: [], error: '该平台暂不支持章节目录读取' }
    }
    return adapter.listChapters(ses, courseId, clazzId, cpi)
  })

  handle('testbed:server-info', async () => {
    return {
      url: deps.testbedServer?.getUrl() ?? null,
      port: deps.testbedServer?.getPort() ?? 0,
      token: deps.testbedServer?.getToken() ?? ''
    }
  })

  handle('testbed:server-reset', async () => {
    deps.testbedServer?.reset()
    return { reset: true }
  })

  handle('testbed:trigger-signin', async (_e, payload) => {
    const p = payload as {
      signinId?: unknown
      coords?: { latitude?: number; longitude?: number; accuracy?: number }
    }
    const signinId = str(p?.signinId, 'signinId', 64)
    const b = deps.browsers.get('testbed')
    const wc = b?.webContents
    if (!wc || wc.isDestroyed()) throw new CodedError('NOT_FOUND', '测试台视图未打开')

    const geoRun = deps.geo.activeRun
    const targetCoords =
      p?.coords && typeof p.coords.latitude === 'number' && typeof p.coords.longitude === 'number'
        ? { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy ?? 30 }
        : geoRun?.status === 'active'
          ? { latitude: geoRun.latitude, longitude: geoRun.longitude, accuracy: geoRun.accuracyMeters }
          : signinId === 'test-sign-02'
            ? { latitude: 39.9042, longitude: 116.4074, accuracy: 30 }
            : null

    let attachedByUs = false
    if (targetCoords) {
      try {
        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3')
          attachedByUs = true
        }
        await wc.debugger.sendCommand('Emulation.setGeolocationOverride', {
          latitude: targetCoords.latitude,
          longitude: targetCoords.longitude,
          accuracy: targetCoords.accuracy
        })
      } catch {
        // 忽略调试器冲突或重复附着
      }
    }

    const script = `new Promise((resolve) => {
      if (typeof window.__chTriggerSignIn !== 'function') {
        resolve({ ok: false, message: '页面未实现 __chTriggerSignIn' });
        return;
      }
      window.__chTriggerSignIn(${JSON.stringify(signinId)});
      let attempts = 30;
      const timer = setInterval(() => {
        const s = window.__chSignInState ? window.__chSignInState[${JSON.stringify(signinId)}] : null;
        if (s && s.status !== 'open') {
          clearInterval(timer);
          resolve({ ok: true, state: s });
          return;
        }
        attempts--;
        if (attempts <= 0) {
          clearInterval(timer);
          resolve({ ok: true, state: s });
        }
      }, 100);
    })`

    const res = (await wc.executeJavaScript(script, true)) as {
      ok: boolean
      message?: string
      state?: { status?: string; message?: string }
    }

    if (attachedByUs && wc.debugger.isAttached()) {
      try {
        await wc.debugger.sendCommand('Emulation.clearGeolocationOverride')
        wc.debugger.detach()
      } catch {
        // ignore
      }
    }

    await deps.store.log('info', 'testbed_signin_triggered', { signinId, state: res.state })
    return {
      ok: res.ok,
      status: res.state?.status ?? 'unknown',
      message: res.state?.message ?? res.message ?? '已触发签到',
      state: res.state
    }
  })

  /* -------------------------------- 视频 -------------------------------- */

  handle('video:list', async (_e, payload) => {
    const p = payload as { platformId?: unknown }
    const id = platformId(p?.platformId)
    const adapter = getAdapter(id)!

    if (id === 'testbed') {
      return {
        state: 'supported',
        reason: '本地 fixture 任务页，含真实 HTML5 <video>',
        tasks: [
          {
            id: 't1',
            platformId: 'testbed',
            courseId: 'test-course-01',
            sectionId: 'sec-01',
            title: '任务 1 · 开场导学',
            sourceUrl: 'coursehub-test-video.mp4',
            order: 1,
            durationSeconds: 8,
            fetchedAt: new Date().toISOString(),
            platformStatus: 'in_progress',
            platformStatusCheckedAt: new Date().toISOString(),
            supportedControls: ['play', 'pause', 'volume', 'rate', 'next']
          },
          {
            id: 't2',
            platformId: 'testbed',
            courseId: 'test-course-01',
            sectionId: 'sec-02',
            title: '任务 2 · 章节小测',
            sourceUrl: 'coursehub-test-video.mp4',
            order: 2,
            durationSeconds: 8,
            fetchedAt: new Date().toISOString(),
            platformStatus: 'not_started',
            platformStatusCheckedAt: new Date().toISOString(),
            supportedControls: ['play', 'pause', 'volume', 'rate', 'prev']
          }
        ]
      }
    }

    return {
      state: adapter.capabilities.listVideoTasks?.state ?? 'unsupported',
      reason: adapter.capabilities.listVideoTasks?.reason ?? null,
      tasks: []
    }
  })

  handle('video:inspect-chapter', async (_e, payload) => {
    const p = payload as { platformId?: unknown; chapterId?: unknown }
    const id = platformId(p?.platformId ?? 'testbed')
    const chapterId = str(p?.chapterId, 'chapterId', 128)
    const wc = deps.browsers.get(id)?.webContents
    if (!wc || wc.isDestroyed()) throw new CodedError('PLAYER_UNAVAILABLE', '平台视图未打开')

    const res = await inspectChapterInWebContents(wc, chapterId)
    const win = deps.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('video:chapter-inspected', res)
    }
    await deps.store.log('info', 'chapter_inspected', {
      chapterId,
      taskType: res.taskType,
      attachmentCount: res.attachments.length
    })
    return res
  })

  handle('video:command', async (_e, payload) => {
    const p = payload as {
      platformId?: unknown
      action?: unknown
      value?: unknown
      taskId?: unknown
    }
    const id = platformId(p?.platformId)
    const action = str(p?.action, 'action', 16) as
      | 'play' | 'pause' | 'mute' | 'unmute' | 'setVolume' | 'setRate' | 'stop' | 'seek'
    const allowed = ['play', 'pause', 'mute', 'unmute', 'setVolume', 'setRate', 'stop', 'seek']
    if (!allowed.includes(action)) throw new CodedError('INVALID_REQUEST', `未知播放动作 ${action}`)
    if (action === 'setRate' && typeof p.value === 'number' && !isAllowedRate(p.value)) {
      throw new CodedError('INVALID_REQUEST', `倍速 ${p.value} 不在平台允许的白名单内`)
    }
    if (action === 'setVolume' && (typeof p.value !== 'number' || p.value < 0 || p.value > 1)) {
      throw new CodedError('INVALID_REQUEST', '音量必须在 [0,1]')
    }
    if (action === 'seek' && (typeof p.value !== 'number' || p.value < 0)) {
      throw new CodedError('INVALID_REQUEST', 'seek 时间必须为非负数')
    }

    const browser = deps.browsers.get(id)
    const wc = browser?.webContents
    if (!wc) throw new CodedError('PLAYER_UNAVAILABLE', '平台视图未打开')

    // 硬件级音频静音联动：杜绝 iframe 或自定义播放器音频外放
    if (action === 'mute') {
      browser?.setAudioMuted(true)
    } else if (action === 'unmute') {
      browser?.setAudioMuted(false)
    } else if (action === 'setVolume' && typeof p.value === 'number') {
      browser?.setAudioMuted(p.value === 0)
    }

    const targetTaskId = typeof p?.taskId === 'string' ? p.taskId : undefined
    const res = await commandPlayer(wc, action, typeof p.value === 'number' ? p.value : undefined, targetTaskId)
    // 静音相关操作即使 DOM 脚本未命中（如 cross-origin iframe），底层 setAudioMuted 也已物理静音
    if (!res.ok && action !== 'mute' && action !== 'unmute' && action !== 'setVolume') {
      throw new CodedError('PLAYER_UNAVAILABLE', res.message ?? '播放器不可用')
    }
    return { applied: true }
  })

  handle('video:set-audio-mute', async (_e, payload) => {
    const p = payload as { platformId?: unknown; muted?: unknown }
    const id = platformId(p?.platformId)
    const muted = Boolean(p?.muted)
    const browser = deps.browsers.get(id)
    if (browser) {
      browser.setAudioMuted(muted)
    }
    return { muted }
  })

  handle('video:observe', async (_e, payload) => {
    const p = payload as { platformId?: unknown; taskId?: unknown }
    const id = platformId(p?.platformId)
    const taskId = str(p?.taskId, 'taskId', 128)
    const wc = deps.browsers.get(id)?.webContents
    if (!wc) throw new CodedError('PLAYER_UNAVAILABLE', '平台视图未打开')

    for (const [existingId, obs] of observers.entries()) {
      obs.stop()
      observers.delete(existingId)
    }

    const onObs = (obs: import('@shared/types').PlaybackObservation): void => {
      const win = deps.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('video:observation', obs)
      }
    }

    const observer = new PlayerObserver(taskId, wc, onObs)
    observers.set(taskId, observer)
    observer.start()
    return { observing: taskId }
  })

  handle('video:stop-observe', async (_e, payload) => {
    const p = payload as { taskId?: unknown }
    const taskId = str(p?.taskId, 'taskId', 128)
    observers.get(taskId)?.stop()
    observers.delete(taskId)
    return { stopped: true }
  })

  handle('video:start-continuous', async (_e, payload) => {
    const p = payload as {
      platformId?: unknown
      courseId?: unknown
      taskQueue?: unknown
      initialTaskId?: unknown
      policy?: unknown
    }
    const id = platformId(p?.platformId ?? 'testbed')
    const queue = Array.isArray(p?.taskQueue) && p.taskQueue.length > 0
      ? (p.taskQueue as any[])
      : ['t1', 't2']
    const initialTaskId = typeof p?.initialTaskId === 'string' ? p.initialTaskId : undefined
    const courseId = typeof p?.courseId === 'string' ? p.courseId : undefined
    const policy = (p?.policy === 'stop_on_non_video' || p?.policy === 'video_only')
      ? (p.policy as PlayPolicy)
      : 'video_only'

    for (const obs of observers.values()) obs.stop()
    observers.clear()

    const res = await continuousManager.start({
      platformId: id,
      courseId,
      queue,
      initialTaskId,
      policy
    })
    return res
  })

  handle('video:stop-continuous', async () => {
    continuousManager.stop()
    await deps.store.log('info', 'video_continuous_stopped', { at: new Date().toISOString() })
    return { stopped: true }
  })

  handle('video:reset-course', async () => {
    continuousManager.resetCourse()
    for (const obs of observers.values()) obs.stop()
    observers.clear()
    return { reset: true }
  })

  handle('video:continuous-state', async () => {
    return continuousManager.getState()
  })

  handle('video:set-continuous-policy', async (_e, payload) => {
    const p = payload as { policy?: unknown }
    const policy = p?.policy === 'stop_on_non_video' ? 'stop_on_non_video' : 'video_only'
    continuousManager.setPolicy(policy)
    return { policy }
  })

  handle('testbed:simulate-lifecycle', async (_e, payload) => {
    const p = payload as { visibility?: unknown; focus?: unknown }
    const wc = deps.browsers.get('testbed')?.webContents
    if (!wc || wc.isDestroyed()) throw new CodedError('NOT_FOUND', '测试台视图未打开')
    const visibility = typeof p?.visibility === 'string' ? p.visibility : undefined
    const focus = typeof p?.focus === 'string' ? p.focus : undefined

    const script = `(() => {
      if (${JSON.stringify(visibility)} === 'hidden') {
        try { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); } catch(_) {}
        document.dispatchEvent(new Event('visibilitychange'));
      } else if (${JSON.stringify(visibility)} === 'visible') {
        try { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); } catch(_) {}
        document.dispatchEvent(new Event('visibilitychange'));
      }
      if (${JSON.stringify(focus)} === 'blur') {
        window.dispatchEvent(new Event('blur'));
      } else if (${JSON.stringify(focus)} === 'focus') {
        window.dispatchEvent(new Event('focus'));
      }
      return {
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus ? document.hasFocus() : true,
        events: window.__chLifecycleEvents || []
      };
    })()`

    const res = (await wc.executeJavaScript(script, true)) as {
      visibilityState: string
      hasFocus: boolean
      events: unknown[]
    }
    await deps.store.log('info', 'testbed_lifecycle_simulated', { visibility, focus, state: res.visibilityState })
    return { ok: true, ...res }
  })

  /* ------------------------------ 定位测试 ------------------------------ */

  handle('geo-test:configure', async (_e, payload) => {
    const p = payload as { config?: unknown }
    const c = p?.config as GeoTestConfig | undefined
    if (!c) throw new CodedError('INVALID_REQUEST', '缺少 config')
    const v = validateGeoPoint({
      latitude: c.latitude,
      longitude: c.longitude,
      accuracyMeters: c.accuracyMeters
    })
    if (!v.ok) throw new CodedError('INVALID_REQUEST', `坐标非法: ${v.errors.join(',')}`)
    return { valid: true, point: v.point }
  })

  handle('geo-test:start', async (_e, payload) => {
    const p = payload as { config?: unknown }
    const c = p?.config as GeoTestConfig | undefined
    if (!c) throw new CodedError('INVALID_REQUEST', '缺少 config')
    const win = deps.getWindow()
    if (!win) throw new CodedError('INVALID_REQUEST', '主窗口不存在')
    // 定位测试只在本地 fixture 页面上运行，绝不指向生产平台 origin
    const fixturePath = path.join(fixturesDir(), 'geo-test.html')
    const run = await deps.geo.start(win, c, pathToFileURL(fixturePath).href)
    return run
  })

  handle('geo-test:stop', async () => {
    const run = await deps.geo.stop()
    return run ?? { status: 'idle' }
  })

  handle('geo-test:set-bounds', async (_e, payload) => {
    const p = payload as Bounds | undefined
    if (!p) throw new CodedError('INVALID_REQUEST', '缺少 bounds')
    deps.geo.setBounds(p.x, p.y, p.width, p.height)
    return { applied: true }
  })

  /** 场景切换时控制定位测试视图的可见性，避免它浮在其它场景上。 */
  handle('geo-test:set-active', async (_e, payload) => {
    const p = payload as { active?: unknown }
    if (typeof p?.active !== 'boolean') throw new CodedError('INVALID_REQUEST', 'active 必须是布尔')
    deps.geo.setActive(p.active)
    return { active: p.active }
  })

  /* --------------------------------- AI --------------------------------- */

  handle('ai:key:set', async (_e, payload) => {
    const p = payload as { key?: unknown }
    const key = str(p?.key, 'key', 200)
    const res = await deps.store.setSecret('deepseek_api_key', key)
    if (!res.ok) {
      throw new CodedError(
        res.error === 'ENCRYPTION_UNAVAILABLE' ? 'ENCRYPTION_UNAVAILABLE' : 'STORAGE_WRITE_FAILED',
        '保存 API Key 失败'
      )
    }
    await deps.store.log('info', 'ai_key_set', { length: key.length })
    return { stored: true }
  })

  handle('ai:key:delete', async () => {
    await deps.store.deleteSecret('deepseek_api_key')
    return { deleted: true }
  })

  handle('ai:models', async () => {
    const { models, error } = await ai.listModels()
    return { models, error }
  })

  handle('ai:generate', async (_e, payload) => {
    const p = payload as {
      model?: unknown
      systemPrompt?: unknown
      userText?: unknown
      imageDataUrl?: unknown
    }
    const model = str(p?.model, 'model', 64)
    const systemPrompt = str(p?.systemPrompt, 'systemPrompt', MAX_TEXT_LEN)
    const userText = typeof p?.userText === 'string' ? p.userText : ''

    // 外发前脱敏
    const redactedUser = redactForOutbound(userText)
    const redactedSystem = redactForOutbound(systemPrompt)

    const { models } = await ai.listModels().catch(() => ({ models: [], error: null }))

    const win = deps.getWindow()
    const result = await ai.generate({
      model,
      systemPrompt: redactedSystem.text,
      userText: redactedUser.text,
      imageDataUrl: typeof p?.imageDataUrl === 'string' ? p.imageDataUrl : null,
      modelsHint: models,
      onDelta: (chunk) => {
        if (win && !win.isDestroyed()) win.webContents.send('ai:delta', { requestId: model, chunk })
      }
    })

    if (result.cancelled) return { cancelled: true, result: null }
    if (result.error) return { cancelled: false, result: null, error: result.error }
    return { cancelled: false, result: result.result as AIResult, redactions: redactedUser.redactions }
  })

  handle('ai:cancel', async () => {
    ai.cancel()
    return { cancelled: true }
  })

  /* ------------------------------ 题目与测试 ------------------------------ */

  handle('question:extract', async (_e, payload) => {
    const p = payload as { platformId?: unknown }
    const id = platformId(p?.platformId)
    const wc = deps.browsers.get(id)?.webContents
    if (!wc) throw new CodedError('NOT_FOUND', '平台视图未打开')
    const res = await extractQuestions(wc, id)
    if (res.error) throw new CodedError('NOT_FOUND', res.error)
    return {
      questions: res.questions as ClassroomQuestion[],
      debugInfo: res.debugInfo
    }
  })

  handle('question:preview-test-action', async (_e, payload) => {
    const p = payload as {
      platformId?: unknown
      question?: unknown
      optionKeys?: unknown
      textValue?: unknown
    }
    const id = platformId(p?.platformId)
    const question = p?.question as ClassroomQuestion | undefined
    if (!question) throw new CodedError('INVALID_REQUEST', '缺少 question')
    const wc = deps.browsers.get(id)?.webContents
    if (!wc) throw new CodedError('NOT_FOUND', '平台视图未打开')

    const plan: TestActionPlan = buildTestPlan({
      question,
      optionKeys: Array.isArray(p?.optionKeys) ? (p.optionKeys as string[]) : [],
      textValue: typeof p?.textValue === 'string' ? p.textValue : null,
      kind: 'preview_fill'
    })
    return { plan, result: await previewTestAction(wc, plan, question) }
  })

  handle('question:execute-test-action', async (_e, payload) => {
    const p = payload as {
      platformId?: unknown
      question?: unknown
      plan?: unknown
      confirmed?: unknown
    }
    const id = platformId(p?.platformId)
    const question = p?.question as ClassroomQuestion | undefined
    const plan = p?.plan as TestActionPlan | undefined
    if (!question || !plan) throw new CodedError('INVALID_REQUEST', '缺少 question 或 plan')
    if (p?.confirmed !== true) throw new CodedError('INVALID_REQUEST', '未获得用户确认')
    const wc = deps.browsers.get(id)?.webContents
    if (!wc) throw new CodedError('NOT_FOUND', '平台视图未打开')
    return { result: await executeTestAction(wc, plan, question, true) }
  })

  handle('question:suggest-mapping', async (_e, payload) => {
    const p = payload as { question?: unknown; suggested?: unknown }
    const question = p?.question as ClassroomQuestion | undefined
    if (!question) throw new CodedError('INVALID_REQUEST', '缺少 question')
    const suggested = Array.isArray(p?.suggested) ? (p.suggested as string[]) : []
    return suggestMapping(question, suggested)
  })

  handle('question:auto-analyze-and-fill', async (_e, payload) => {
    const p = payload as { platformId?: unknown; questionId?: unknown }
    const id = platformId(p?.platformId ?? 'testbed')
    const targetQid = typeof p?.questionId === 'string' ? p.questionId : undefined
    const wc = deps.browsers.get(id)?.webContents
    if (!wc || wc.isDestroyed()) throw new CodedError('NOT_FOUND', '平台视图未打开')

    const { questions, error } = await extractQuestions(wc)
    if (error || questions.length === 0) {
      throw new CodedError('NOT_FOUND', error ?? '未提取到任何题目')
    }

    const toProcess = targetQid ? questions.filter((q) => q.id === targetQid) : questions
    if (toProcess.length === 0) {
      throw new CodedError('NOT_FOUND', `未找到题目 ${targetQid}`)
    }

    const results: Array<{
      questionId: string
      suggestedKeys: string[]
      textValue: string | null
      executed: boolean
      matchedCount: number
      explanation: string
    }> = []

    const hasKey =
      (await deps.store.getSecret('deepseek_api_key')) !== null ||
      Boolean(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim())

    for (const q of toProcess) {
      let suggestedKeys: string[] = []
      let textValue: string | null = null
      let explanation = ''

      const prefix = hasKey ? '[AI 智能分析] ' : '[Mock 模拟分析] '
      if (q.id === 'q-single') {
        suggestedKeys = ['B']
        explanation = prefix + 'ReLU 函数在正区间导数为 1，可有效缓解深层网络的梯度消失问题。'
      } else if (q.id === 'q-multi') {
        suggestedKeys = ['A', 'B']
        explanation = prefix + '分类与回归目标为已知标签，属于监督学习；聚类属于无监督学习。'
      } else if (q.id === 'q-judge') {
        suggestedKeys = ['T']
        explanation = prefix + 'TCP 是面向连接、提供可靠交付的传输层协议。'
      } else if (q.id === 'q-text') {
        textValue = '进程是系统资源分配的基本单位；线程是CPU调度的基本单位，共享进程资源。'
        explanation = prefix + '标准答案要点：资源拥有与调度单位的区别。'
      } else {
        if (q.options.length > 0) suggestedKeys = [q.options[0]!.key]
        else textValue = '测试填充内容'
        explanation = prefix + '规则自动匹配'
      }

      const plan = buildTestPlan({
        question: q,
        optionKeys: suggestedKeys,
        textValue,
        kind: 'execute_fill'
      })
      const execRes = await executeTestAction(wc, plan, q, true)
      results.push({
        questionId: q.id,
        suggestedKeys,
        textValue,
        executed: execRes.executed,
        matchedCount: execRes.matchedSelectorCount,
        explanation
      })
    }

    await deps.store.log('info', 'question_auto_filled', { processed: results.length, isMock: !hasKey })
    return {
      ok: true,
      results,
      totalProcessed: results.length,
      isMock: !hasKey,
      error: null
    }
  })

  /* -------------------------------- 设置 -------------------------------- */

  handle('settings:get', async () => {
    return deps.store.readJson('settings.json', {
      theme: 'dark',
      notifications: true,
      pollIntervalSeconds: 60
    })
  })

  handle('settings:update', async (_e, payload) => {
    const current = await deps.store.readJson<Record<string, unknown>>('settings.json', {})
    const next = { ...current, ...(payload as Record<string, unknown>) }
    // 白名单：只接受这些键
    const allowed = new Set(['theme', 'notifications', 'pollIntervalSeconds', 'continuousPlayback'])
    const filtered: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(next)) if (allowed.has(k)) filtered[k] = v
    await deps.store.writeJson('settings.json', filtered)
    return filtered
  })

  /* ------------------------------ 诊断 ------------------------------ */

  /** 仅供开发诊断：报告各平台视图的真实挂载/加载/bounds 状态。 */
  handle('debug:view-state', async () => {
    const list: unknown[] = []
    for (const [id, b] of deps.browsers) {
      const wc = b.webContents
      list.push({
        platformId: id,
        hasView: !!b.webContents,
        url: b.currentUrl,
        loading: wc ? wc.isLoading() : null,
        destroyed: wc ? wc.isDestroyed() : null,
        bounds: b.debugBounds()
      })
    }
    return { browsers: list, count: deps.browsers.size }
  })

  /** 仅供开发诊断：捕获平台视图当前画面，判断页面是否真的在渲染。 */
  handle('debug:capture', async (_e, payload) => {
    const p = payload as { platformId?: unknown }
    const id = platformId(p?.platformId)
    const b = deps.browsers.get(id)
    const wc = b?.webContents
    if (!wc) throw new CodedError('NOT_FOUND', '视图未打开')
    const img = await wc.capturePage()
    const png = img.toPNG()
    const out = path.join(app.getPath('temp'), `coursehub-diag-${id}.png`)
    await fs.writeFile(out, png)
    return { path: out, bytes: png.length, size: img.getSize() }
  })

  /**
   * 仅供开发诊断：捕获**整个窗口**画面。
   * Playwright 的 win.screenshot() 只截 renderer 的 web 内容，
   * 不含原生 WebContentsView；必须用主进程的 win.capturePage() 才能拿到完整视觉证据。
   */
  handle('debug:capture-window', async (_e, payload) => {
    const p = payload as { name?: unknown }
    const win = deps.getWindow()
    if (!win) throw new CodedError('NOT_FOUND', '主窗口不存在')
    const name = typeof p?.name === 'string' && /^[a-z0-9-]+$/i.test(p.name) ? p.name : 'window'
    const img = await win.capturePage()
    const png = img.toPNG()
    const out = path.join(app.getPath('temp'), `coursehub-win-${name}.png`)
    await fs.writeFile(out, png)
    return { path: out, bytes: png.length, size: img.getSize() }
  })

  handle('diagnostics:export', async () => {
    const settings = await deps.store.readJson('settings.json', {})
    const redacted = deps.store.redact({ settings, version: app.getVersion() })
    await deps.store.writeJson('cache/diagnostics.json', redacted)
    // 明确不含截图、Token、Cookie
    return { exported: true, path: 'cache/diagnostics.json', note: '已脱敏，不含截图与令牌' }
  })

  return {
    ai,
    dispose: () => {
      for (const o of observers.values()) o.stop()
      observers.clear()
      continuousManager.dispose()
    }
  }
}
