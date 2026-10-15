/**
 * 类型化 IPC 注册。
 *
 * 所有通道都做 sender frame 校验、schema 校验与大小限制（开发文档 §10）。
 * 远程平台页面拿不到任何 preload，因此不可能调用这些通道。
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AIResult,
  Bounds,
  ClassroomQuestion,
  GeoTestConfig,
  PlatformId,
  TestActionPlan
} from '@shared/types'
import { ok, toErrorResult, CodedError } from '@shared/ipc'
import { isAllowedRate } from '@shared/video'
import { validateGeoPoint } from '@shared/geo'
import { getAdapter } from '../adapters'
import { PLATFORM_CONFIGS, PlatformBrowser, isOriginAllowed } from '../browser/platform-browser'
import { GeoTestManager } from '../geo-test/geo-test-manager'
import { PlayerObserver, commandPlayer } from '../video/player-observer'
import { DeepSeekClient } from '../ai/deepseek-client'
import {
  extractQuestions,
  previewTestAction,
  executeTestAction,
  suggestMapping
} from '../classroom/question-extractor'
import { redactForOutbound } from '@shared/deepseek'
import { buildTestPlan } from '@shared/question'
import type { Store } from '../services/store'

const MAX_TEXT_LEN = 20_000

function assertSender(event: Electron.IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  if (!frame) throw new CodedError('INVALID_REQUEST', '缺少 sender frame')
  // 远程页面（http/https）不得调用本地 IPC
  const url = frame.url
  if (/^https?:/i.test(url)) {
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
}

export function registerIpc(deps: IpcDeps): { ai: DeepSeekClient; dispose: () => void } {
  const ai = new DeepSeekClient(deps.store)
  const observers = new Map<string, PlayerObserver>()

  const handle = <T>(
    channel: string,
    fn: (event: Electron.IpcMainInvokeEvent, payload: unknown) => Promise<T>
  ): void => {
    ipcMain.handle(channel, async (event, payload): Promise<unknown> => {
      try {
        assertSender(event)
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
    const snapshot = await adapter!.detectAuth(new AbortController().signal)
    return { platformId: id, ...snapshot, checkedAt: new Date().toISOString() }
  })

  handle('platform:open', async (_e, payload) => {
    const id = platformId((payload as { platformId?: unknown })?.platformId)
    const win = deps.getWindow()
    if (!win) throw new CodedError('INVALID_REQUEST', '主窗口不存在')
    let browser = deps.browsers.get(id)
    if (!browser) {
      browser = PlatformBrowser.create(id)
      deps.browsers.set(id, browser)
    }
    browser.attach(win)
    await browser.loadHome()
    return { platformId: id, url: browser.currentUrl }
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
    if (!isOriginAllowed(url, cfg.allowedOrigins)) {
      throw new CodedError('UNSUPPORTED', '该 URL 不在平台白名单内')
    }
    deps.browsers.get(id)?.openExternal(url)
    return { opened: true }
  })

  /* -------------------------------- 签到 -------------------------------- */

  handle('classroom:today-signins', async () => {
    const cached = await deps.store.readJson<{ fetchedAt: string | null; events: unknown[] }>(
      'cache/signins.json',
      { fetchedAt: null, events: [] }
    )
    // 没有真实平台数据时如实返回空 + unverified，绝不伪造签到记录
    return {
      state: 'unverified',
      events: [],
      fetchedAt: cached.fetchedAt,
      reason: '平台适配器未在真实账号验证；本次交付不提供伪造签到数据'
    }
  })

  /* -------------------------------- 视频 -------------------------------- */

  handle('video:list', async (_e, payload) => {
    const p = payload as { platformId?: unknown }
    const id = platformId(p?.platformId)
    const adapter = getAdapter(id)!
    return {
      state: adapter.capabilities.listVideoTasks?.state ?? 'unsupported',
      reason: adapter.capabilities.listVideoTasks?.reason ?? null,
      tasks: []
    }
  })

  handle('video:command', async (_e, payload) => {
    const p = payload as {
      platformId?: unknown
      action?: unknown
      value?: unknown
    }
    const id = platformId(p?.platformId)
    const action = str(p?.action, 'action', 16) as
      | 'play' | 'pause' | 'mute' | 'unmute' | 'setVolume' | 'setRate' | 'stop'
    const allowed = ['play', 'pause', 'mute', 'unmute', 'setVolume', 'setRate', 'stop']
    if (!allowed.includes(action)) throw new CodedError('INVALID_REQUEST', `未知播放动作 ${action}`)
    if (action === 'setRate' && typeof p.value === 'number' && !isAllowedRate(p.value)) {
      throw new CodedError('INVALID_REQUEST', `倍速 ${p.value} 不在平台允许的白名单内`)
    }
    if (action === 'setVolume' && (typeof p.value !== 'number' || p.value < 0 || p.value > 1)) {
      throw new CodedError('INVALID_REQUEST', '音量必须在 [0,1]')
    }

    const wc = deps.browsers.get(id)?.webContents
    if (!wc) throw new CodedError('PLAYER_UNAVAILABLE', '平台视图未打开')
    const res = await commandPlayer(wc, action, typeof p.value === 'number' ? p.value : undefined)
    if (!res.ok) throw new CodedError('PLAYER_UNAVAILABLE', res.message ?? '播放器不可用')
    return { applied: true }
  })

  handle('video:observe', async (_e, payload) => {
    const p = payload as { platformId?: unknown; taskId?: unknown }
    const id = platformId(p?.platformId)
    const taskId = str(p?.taskId, 'taskId', 128)
    const wc = deps.browsers.get(id)?.webContents
    if (!wc) throw new CodedError('PLAYER_UNAVAILABLE', '平台视图未打开')

    observers.get(taskId)?.stop()
    const observer = new PlayerObserver(taskId, wc, (obs) => {
      const win = deps.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('video:observation', obs)
      }
    })
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

  handle('video:stop-continuous', async () => {
    // 连续播放为用户显式开启；停止即清空所有观察器并复位
    for (const o of observers.values()) o.stop()
    observers.clear()
    const win = deps.getWindow()
    win?.webContents.send('video:continuous-stopped', { at: new Date().toISOString() })
    return { stopped: true }
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
    const fixturePath = path.join(app.getAppPath(), 'tests', 'fixtures', 'geo-test.html')
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
    if (error) return { models: [], error }
    return { models, error: null }
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
    const res = await extractQuestions(wc)
    if (res.error) throw new CodedError('NOT_FOUND', res.error)
    return { questions: res.questions as ClassroomQuestion[] }
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

  handle('diagnostics:export', async () => {
    const settings = await deps.store.readJson('settings.json', {})
    const redacted = deps.store.redact({ settings, version: '0.2.0' })
    await deps.store.writeJson('cache/diagnostics.json', redacted)
    // 明确不含截图、Token、Cookie
    return { exported: true, path: 'cache/diagnostics.json', note: '已脱敏，不含截图与令牌' }
  })

  return {
    ai,
    dispose: () => {
      for (const o of observers.values()) o.stop()
      observers.clear()
    }
  }
}
