/**
 * Preload：只给本地 UI 的受限 contextBridge。
 *
 * 远程平台视图不加载任何 preload，因此物理上无法调用这些 API。
 * 这里不暴露 ipcRenderer 本身，只暴露白名单方法。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcResult } from '@shared/types'
import type {
  AIResult,
  Bounds,
  ClassroomQuestion,
  GeoTestConfig,
  GeoTestRun,
  PlatformId,
  PlaybackObservation,
  TestActionPlan
} from '@shared/types'

export interface PlatformSummary {
  id: PlatformId
  name: string
  homeUrl: string
  capabilities: Record<string, { state: string; reason: string; verifiedAt: string | null }>
  adapterVersion: string | null
}

const invoke = <T>(channel: string, payload?: unknown): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<IpcResult<T>>

const api = {
  platform: {
    list: () => invoke<PlatformSummary[]>('platform:list'),
    auth: (platformId: PlatformId) =>
      invoke<{ platformId: PlatformId; state: string; evidence: string | null; checkedAt: string }>(
        'platform:auth',
        { platformId }
      ),
    open: (input: { platformId: PlatformId; fixture?: string }) =>
      invoke<{ platformId: PlatformId; url: string | null }>('platform:open', input)
  },
  testbed: {
    loadFixture: (fixture: string) =>
      invoke<{ url: string | null; fixture: string }>('testbed:load-fixture', { fixture })
  },
  browser: {
    navigate: (platformId: PlatformId, url: string) =>
      invoke<{ url: string | null }>('browser:navigate', { platformId, url }),
    command: (platformId: PlatformId, command: 'reload' | 'back' | 'forward') =>
      invoke<{ url: string | null }>('browser:command', { platformId, command }),
    setBounds: (platformId: PlatformId, bounds: Bounds) =>
      invoke<{ applied: boolean }>('browser:set-bounds', { platformId, bounds }),
    setVisible: (platformId: PlatformId, visible: boolean) =>
      invoke<{ visible: boolean }>('browser:set-visible', { platformId, visible }),
    openExternal: (platformId: PlatformId, url: string) =>
      invoke<{ opened: boolean }>('browser:open-external', { platformId, url })
  },
  classroom: {
    todaySignIns: () =>
      invoke<{ state: string; events: unknown[]; fetchedAt: string | null; reason: string | null }>(
        'classroom:today-signins'
      )
  },
  video: {
    list: (platformId: PlatformId) =>
      invoke<{ state: string; reason: string | null; tasks: unknown[] }>('video:list', { platformId }),
    command: (platformId: PlatformId, action: string, value?: number) =>
      invoke<{ applied: boolean }>('video:command', { platformId, action, value }),
    observe: (platformId: PlatformId, taskId: string) =>
      invoke<{ observing: string }>('video:observe', { platformId, taskId }),
    stopObserve: (taskId: string) => invoke<{ stopped: boolean }>('video:stop-observe', { taskId }),
    stopContinuous: () => invoke<{ stopped: boolean }>('video:stop-continuous')
  },
  geoTest: {
    configure: (config: GeoTestConfig) => invoke<{ valid: boolean }>('geo-test:configure', { config }),
    start: (config: GeoTestConfig) => invoke<GeoTestRun>('geo-test:start', { config }),
    stop: () => invoke<GeoTestRun>('geo-test:stop'),
    setBounds: (bounds: Bounds) => invoke<{ applied: boolean }>('geo-test:set-bounds', bounds),
    setActive: (active: boolean) => invoke<{ active: boolean }>('geo-test:set-active', { active })
  },
  ai: {
    setKey: (key: string) => invoke<{ stored: boolean }>('ai:key:set', { key }),
    deleteKey: () => invoke<{ deleted: boolean }>('ai:key:delete'),
    models: () => invoke<{ models: import('@shared/types').AIModelInfo[]; error: string | null }>('ai:models'),
    generate: (input: {
      model: string
      systemPrompt: string
      userText: string
      imageDataUrl?: string | null
    }) =>
      invoke<{ cancelled: boolean; result: AIResult | null; error?: string; redactions?: string[] }>(
        'ai:generate',
        input
      ),
    cancel: () => invoke<{ cancelled: boolean }>('ai:cancel')
  },
  question: {
    extract: (platformId: PlatformId) =>
      invoke<{ questions: ClassroomQuestion[] }>('question:extract', { platformId }),
    previewTestAction: (input: {
      platformId: PlatformId
      question: ClassroomQuestion
      optionKeys: string[]
      textValue: string | null
    }) =>
      invoke<{ plan: TestActionPlan; result: { ok: boolean; matchedSelectorCount: number; previewText: string; executed: boolean; error: string | null } }>(
        'question:preview-test-action',
        input
      ),
    executeTestAction: (input: {
      platformId: PlatformId
      question: ClassroomQuestion
      plan: TestActionPlan
      confirmed: boolean
    }) =>
      invoke<{ result: { ok: boolean; matchedSelectorCount: number; previewText: string; executed: boolean; error: string | null } }>(
        'question:execute-test-action',
        input
      ),
    suggestMapping: (question: ClassroomQuestion, suggested: string[]) =>
      invoke<{ mapping: Record<string, string>; unmatched: string[]; allKeys: string[] }>(
        'question:suggest-mapping',
        { question, suggested }
      )
  },
  settings: {
    get: () => invoke<Record<string, unknown>>('settings:get'),
    update: (patch: Record<string, unknown>) => invoke<Record<string, unknown>>('settings:update', patch)
  },
  diagnostics: {
    export: () => invoke<{ exported: boolean; path: string; note: string }>('diagnostics:export'),
    viewState: () => invoke<{ browsers: unknown[]; count: number }>('debug:view-state'),
    capture: (platformId: PlatformId) =>
      invoke<{ path: string; bytes: number; size: { width: number; height: number } }>(
        'debug:capture',
        { platformId }
      ),
    captureWindow: (name: string) =>
      invoke<{ path: string; bytes: number; size: { width: number; height: number } }>(
        'debug:capture-window',
        { name }
      )
  },
  events: {
    onVideoObservation: (cb: (obs: PlaybackObservation) => void): (() => void) => {
      const handler = (_e: unknown, obs: PlaybackObservation): void => cb(obs)
      ipcRenderer.on('video:observation', handler)
      return () => ipcRenderer.removeListener('video:observation', handler)
    },
    onGeoUpdate: (cb: (run: GeoTestRun) => void): (() => void) => {
      const handler = (_e: unknown, run: GeoTestRun): void => cb(run)
      ipcRenderer.on('geo-test:update', handler)
      return () => ipcRenderer.removeListener('geo-test:update', handler)
    },
    onAiDelta: (cb: (chunk: string) => void): (() => void) => {
      const handler = (_e: unknown, payload: { chunk: string }): void => cb(payload.chunk)
      ipcRenderer.on('ai:delta', handler)
      return () => ipcRenderer.removeListener('ai:delta', handler)
    },
    onContinuousStopped: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('video:continuous-stopped', handler)
      return () => ipcRenderer.removeListener('video:continuous-stopped', handler)
    }
  }
}

export type CourseHubApi = typeof api

contextBridge.exposeInMainWorld('coursehub', api)
