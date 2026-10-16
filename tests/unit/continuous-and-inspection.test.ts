import { describe, it, expect, vi } from 'vitest'
import { ContinuousManager } from '../../src/main/video/continuous-manager'
import { buildInspectionScript } from '../../src/main/video/task-inspector'

describe('Task Inspector', () => {
  it('buildInspectionScript 生成合法的注入检测脚本并包含 chapterId', () => {
    const script = buildInspectionScript('test-chap-101')
    expect(script).toContain('test-chap-101')
    expect(script).toContain('video')
    expect(script).toContain('dom_element')
    expect(script).toContain('attachments')
  })
})

describe('ContinuousManager 连播状态机与调度规则', () => {
  function createMockDeps() {
    const logFn = vi.fn().mockResolvedValue(undefined)
    const sendFn = vi.fn()
    const execJsFn = vi.fn().mockResolvedValue({ ok: true })

    const mockWc: any = {
      isDestroyed: () => false,
      getURL: () => 'http://127.0.0.1:40123/video-task.html',
      loadURL: vi.fn().mockResolvedValue(undefined),
      executeJavaScript: execJsFn
    }

    const mockWin: any = {
      isDestroyed: () => false,
      webContents: {
        send: sendFn
      }
    }

    const store: any = {
      log: logFn
    }

    const deps = {
      store,
      getWindow: () => mockWin,
      getWebContents: () => mockWc
    }

    return { deps, logFn, sendFn, execJsFn, mockWc, mockWin }
  }

  it('初始状态为 idle，启动后进入 playing 并绑定首个任务', async () => {
    const { deps, logFn } = createMockDeps()
    const cm = new ContinuousManager(deps)

    expect(cm.getState().state).toBe('idle')
    expect(cm.getState().queueLength).toBe(0)

    const res = await cm.start({
      platformId: 'testbed',
      courseId: 'course-1',
      queue: [
        { id: 't1', title: '第 1 节 导学', taskType: 'video' },
        { id: 't2', title: '第 2 节 实战', taskType: 'video' }
      ],
      initialTaskId: 't1',
      policy: 'video_only'
    })

    expect(res.ok).toBe(true)
    expect(res.queue).toEqual(['t1', 't2'])
    expect(cm.getState().state).toBe('playing')
    expect(cm.getState().currentTaskId).toBe('t1')
    expect(logFn).toHaveBeenCalledWith('info', 'continuous_started', expect.objectContaining({
      courseId: 'course-1',
      initialTaskId: 't1'
    }))

    cm.stop()
  })

  it('防抖：连续接收到同一任务的 ended 事件不重复切换', async () => {
    const { deps, sendFn } = createMockDeps()
    const cm = new ContinuousManager(deps)

    await cm.start({
      platformId: 'testbed',
      courseId: 'course-1',
      queue: [
        { id: 't1', title: '任务 1', taskType: 'video' },
        { id: 't2', title: '任务 2', taskType: 'video' }
      ],
      initialTaskId: 't1',
      policy: 'video_only'
    })

    // 第一次触发 ended
    await cm.handleObservation({
      taskId: 't1',
      playerState: 'ended',
      currentTimeSeconds: 8,
      durationSeconds: 8,
      playbackRate: 1,
      volume: 1,
      muted: false,
      observedAt: new Date().toISOString(),
      origin: 'html5-video'
    })

    // 立即第二次触发 ended（模拟 Observer 1秒轮询在切页期间重入）
    await cm.handleObservation({
      taskId: 't1',
      playerState: 'ended',
      currentTimeSeconds: 8,
      durationSeconds: 8,
      playbackRate: 1,
      volume: 1,
      muted: false,
      observedAt: new Date().toISOString(),
      origin: 'html5-video'
    })

    // 验证状态机切换
    expect(cm.getState().currentTaskId).toBe('t2')
    // task-switched 仅发送了一次
    const switchCalls = sendFn.mock.calls.filter((c) => c[0] === 'video:task-switched')
    expect(switchCalls.length).toBe(1)

    cm.stop()
  })

  it('策略为 video_only 时自动跳过非视频任务，并明确记录不代表平台完成', async () => {
    const { deps, logFn, sendFn } = createMockDeps()
    const cm = new ContinuousManager(deps)

    await cm.start({
      platformId: 'testbed',
      courseId: 'course-1',
      queue: [
        { id: 't1', title: '视频 1', taskType: 'video' },
        { id: 't-doc', title: '课件 PDF', taskType: 'doc' },
        { id: 't-quiz', title: '课后自测', taskType: 'quiz' },
        { id: 't2', title: '视频 2', taskType: 'video' }
      ],
      initialTaskId: 't1',
      policy: 'video_only'
    })

    // t1 ended
    await cm.handleObservation({
      taskId: 't1',
      playerState: 'ended',
      currentTimeSeconds: 10,
      durationSeconds: 10,
      playbackRate: 1,
      volume: 1,
      muted: false,
      observedAt: new Date().toISOString(),
      origin: 'html5-video'
    })

    // 应当跳过 t-doc 和 t-quiz，直接切到 t2
    expect(cm.getState().currentTaskId).toBe('t2')

    // 检查跳过事件与日志
    const skipLogs = logFn.mock.calls.filter((c) => c[1] === 'continuous_skipped_non_video')
    expect(skipLogs.length).toBe(2)
    expect(skipLogs[0]![2]).toMatchObject({
      skippedId: 't-doc',
      note: '自动跳过不代表平台任务完成'
    })
    expect(skipLogs[1]![2]).toMatchObject({
      skippedId: 't-quiz',
      note: '自动跳过不代表平台任务完成'
    })

    const skipEvents = sendFn.mock.calls.filter((c) => c[0] === 'video:task-skipped')
    expect(skipEvents.length).toBe(2)

    cm.stop()
  })

  it('策略为 stop_on_non_video 时遇到非视频任务安全暂停等待确认', async () => {
    const { deps, sendFn } = createMockDeps()
    const cm = new ContinuousManager(deps)

    await cm.start({
      platformId: 'testbed',
      courseId: 'course-1',
      queue: [
        { id: 't1', title: '视频 1', taskType: 'video' },
        { id: 't-quiz', title: '重要随堂测验', taskType: 'quiz' },
        { id: 't2', title: '视频 2', taskType: 'video' }
      ],
      initialTaskId: 't1',
      policy: 'stop_on_non_video'
    })

    // t1 ended
    await cm.handleObservation({
      taskId: 't1',
      playerState: 'ended',
      currentTimeSeconds: 10,
      durationSeconds: 10,
      playbackRate: 1,
      volume: 1,
      muted: false,
      observedAt: new Date().toISOString(),
      origin: 'html5-video'
    })

    // 状态机暂停在 non_video 阶段
    expect(cm.getState().state).toBe('paused_non_video')
    expect(sendFn).toHaveBeenCalledWith('video:continuous-paused-non-video', expect.objectContaining({
      currentTaskId: 't-quiz',
      taskType: 'quiz'
    }))

    cm.stop()
  })

  it('resetCourse 彻底复位课程状态并停止一切调度，杜绝跨课程串队列', async () => {
    const { deps, sendFn } = createMockDeps()
    const cm = new ContinuousManager(deps)

    await cm.start({
      platformId: 'testbed',
      courseId: 'course-1',
      queue: [{ id: 't1', title: '任务 1', taskType: 'video' }],
      initialTaskId: 't1'
    })

    expect(cm.getState().state).toBe('playing')
    expect(cm.getState().courseId).toBe('course-1')

    cm.resetCourse()

    expect(cm.getState().state).toBe('idle')
    expect(cm.getState().courseId).toBeNull()
    expect(cm.getState().currentTaskId).toBeNull()
    expect(cm.getState().queueLength).toBe(0)
    expect(sendFn).toHaveBeenCalledWith('video:continuous-stopped', expect.anything())
  })
})
