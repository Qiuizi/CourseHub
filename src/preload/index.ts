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
  ClassroomActivityItem,
  ClassroomQuestion,
  GeoTestConfig,
  GeoTestRun,
  PlatformId,
  PlaybackObservation,
  PlayPolicy,
  TestActionPlan,
  ChapterNode,
  ChapterInspectionResult
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
      invoke<{ platformId: PlatformId; url: string | null }>('platform:open', input),
    courses: (platformId: PlatformId) =>
      invoke<{ state: string; courses: unknown[]; error?: string }>('platform:courses', { platformId }),
    chapters: (input: { platformId: PlatformId; courseId: string; clazzId: string; cpi?: string }) =>
      invoke<{ ok: boolean; chapters: ChapterNode[]; enc?: string; error?: string }>('platform:chapters', input)
  },
  testbed: {
    loadFixture: (fixture: string) =>
      invoke<{ url: string | null; fixture: string }>('testbed:load-fixture', { fixture }),
    simulateLifecycle: (input: { visibility?: 'visible' | 'hidden'; focus?: 'focus' | 'blur' }) =>
      invoke<{ ok: boolean; visibilityState: string; hasFocus: boolean; events: unknown[] }>(
        'testbed:simulate-lifecycle',
        input
      ),
    triggerSignIn: (signinId: string, coords?: { latitude: number; longitude: number; accuracy?: number }) =>
      invoke<{ ok: boolean; status: string; message: string; state: unknown }>('testbed:trigger-signin', {
        signinId,
        coords
      }),
    serverInfo: () =>
      invoke<{ url: string | null; port: number; token: string }>('testbed:server-info'),
    resetServer: () =>
      invoke<{ reset: boolean }>('testbed:server-reset')
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
      invoke<{ opened: boolean }>('browser:open-external', { platformId, url }),
    captureView: (platformId: PlatformId) =>
      invoke<{ dataUrl: string; width: number; height: number }>('browser:capture-view', { platformId })
  },
  classroom: {
    todaySignIns: (platformId?: PlatformId) =>
      invoke<{ state: string; events: unknown[]; fetchedAt: string | null; reason: string | null }>(
        'classroom:today-signins',
        { platformId }
      ),
    activities: (platformId?: PlatformId) =>
      invoke<{ state: string; activities: ClassroomActivityItem[]; fetchedAt: string; reason: string | null }>(
        'classroom:activities',
        { platformId }
      ),
    auth: (platformId: PlatformId) =>
      invoke<{ state: string; evidence: string | null }>('platform:auth', { platformId }),
    courses: (platformId: PlatformId) =>
      invoke<{ state: string; courses: unknown[]; error?: string }>('platform:courses', { platformId }),
    chapters: (platformId: PlatformId, courseId: string, clazzId: string, cpi?: string) =>
      invoke<{ ok: boolean; chapters: ChapterNode[]; enc?: string; error?: string }>('platform:chapters', {
        platformId,
        courseId,
        clazzId,
        cpi
      })
  },
  video: {
    list: (platformId: PlatformId) =>
      invoke<{ state: string; reason: string | null; tasks: unknown[] }>('video:list', { platformId }),
    inspectChapter: (input: { platformId: PlatformId; chapterId: string }) =>
      invoke<ChapterInspectionResult>('video:inspect-chapter', input),
    command: (platformId: PlatformId, action: string, value?: number, taskId?: string) =>
      invoke<{ applied: boolean }>('video:command', { platformId, action, value, taskId }),
    observe: (platformId: PlatformId, taskId: string) =>
      invoke<{ observing: string }>('video:observe', { platformId, taskId }),
    stopObserve: (taskId: string) => invoke<{ stopped: boolean }>('video:stop-observe', { taskId }),
    setAudioMute: (platformId: PlatformId, muted: boolean) =>
      invoke<{ muted: boolean }>('video:set-audio-mute', { platformId, muted }),
    startContinuous: (input: {
      platformId: PlatformId
      courseId?: string
      taskQueue: Array<{ id: string; title: string; sourceUrl?: string; taskType: string } | string>
      initialTaskId?: string
      policy?: PlayPolicy
    }) =>
      invoke<{ ok: boolean; queue: string[]; message?: string }>('video:start-continuous', input),
    stopContinuous: () => invoke<{ stopped: boolean }>('video:stop-continuous'),
    resetCourse: () => invoke<{ reset: boolean }>('video:reset-course'),
    continuousState: () =>
      invoke<{
        state: string
        policy: PlayPolicy
        platformId: PlatformId
        courseId: string | null
        currentTaskId: string | null
        queueLength: number
      }>('video:continuous-state'),
    setContinuousPolicy: (policy: PlayPolicy) =>
      invoke<{ policy: PlayPolicy }>('video:set-continuous-policy', { policy })
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
      ),
    autoAnalyzeAndFill: (input: { platformId?: PlatformId; questionId?: string }) =>
      invoke<{ ok: boolean; results: unknown[]; totalProcessed: number; isMock: boolean; error: string | null }>(
        'question:auto-analyze-and-fill',
        input
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
    onTaskSwitched: (cb: (evt: { previousTaskId: string; currentTaskId: string }) => void): (() => void) => {
      const handler = (_e: unknown, evt: { previousTaskId: string; currentTaskId: string }): void => cb(evt)
      ipcRenderer.on('video:task-switched', handler)
      return () => ipcRenderer.removeListener('video:task-switched', handler)
    },
    onContinuousCompleted: (cb: (evt: { completedAt: string }) => void): (() => void) => {
      const handler = (_e: unknown, evt: { completedAt: string }): void => cb(evt)
      ipcRenderer.on('video:continuous-completed', handler)
      return () => ipcRenderer.removeListener('video:continuous-completed', handler)
    },
    onContinuousStopped: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('video:continuous-stopped', handler)
      return () => ipcRenderer.removeListener('video:continuous-stopped', handler)
    },
    onChapterInspected: (cb: (res: ChapterInspectionResult) => void): (() => void) => {
      const handler = (_e: unknown, res: ChapterInspectionResult): void => cb(res)
      ipcRenderer.on('video:chapter-inspected', handler)
      return () => ipcRenderer.removeListener('video:chapter-inspected', handler)
    },
    onTaskSkipped: (cb: (evt: { taskId: string; title: string; taskType: string; reason: string }) => void): (() => void) => {
      const handler = (_e: unknown, evt: { taskId: string; title: string; taskType: string; reason: string }): void => cb(evt)
      ipcRenderer.on('video:task-skipped', handler)
      return () => ipcRenderer.removeListener('video:task-skipped', handler)
    },
    onContinuousPausedNonVideo: (cb: (evt: { currentTaskId: string; title: string; taskType: string; reason: string }) => void): (() => void) => {
      const handler = (_e: unknown, evt: { currentTaskId: string; title: string; taskType: string; reason: string }): void => cb(evt)
      ipcRenderer.on('video:continuous-paused-non-video', handler)
      return () => ipcRenderer.removeListener('video:continuous-paused-non-video', handler)
    },
    onContinuousError: (cb: (evt: { code: string; message: string; taskId: string }) => void): (() => void) => {
      const handler = (_e: unknown, evt: { code: string; message: string; taskId: string }): void => cb(evt)
      ipcRenderer.on('video:continuous-error', handler)
      return () => ipcRenderer.removeListener('video:continuous-error', handler)
    },
    onActivityNotify: (cb: (act: ClassroomActivityItem) => void): (() => void) => {
      const handler = (_e: unknown, act: ClassroomActivityItem): void => cb(act)
      ipcRenderer.on('classroom:activity-notify', handler)
      return () => ipcRenderer.removeListener('classroom:activity-notify', handler)
    }
  }
}

export type CourseHubApi = typeof api

contextBridge.exposeInMainWorld('coursehub', api)
