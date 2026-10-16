/**
 * 连续播放状态机与调度管理器。
 *
 * 核心准则（开发规范 §2）：
 * 1. 章节列表保留全部真实章节。
 * 2. 视频队列只包含确认为可播放视频的任务；未识别任务在打开并确认类型后才参与连播。
 * 3. 支持用户决定：仅播放视频 (video_only)，还是遇到测验/文档时暂停等待 (stop_on_non_video)。
 * 4. 自动跳过不代表平台任务完成（清晰日志与提示，不伪造完成状态）。
 * 5. 视频正常结束后，防抖切换到下一适用任务；处理好异步导航、旧 Frame 销毁与 Observer 重绑定。
 * 6. 用户关闭连播后立即停止自动导航；页面加载失败时停止并展示具体错误。
 * 7. 切换课程时清理原队列及观察器，杜绝同一任务重复切换或跨课程串队列。
 */

import type { BrowserWindow, WebContents } from 'electron'
import type {
  PlaybackObservation,
  PlayPolicy,
  ContinuousPlaybackState,
  PlatformId,
  TaskType
} from '@shared/types'
import { PlayerObserver, commandPlayer } from './player-observer'
import { inspectChapterInWebContents } from './task-inspector'
import type { Store } from '../services/store'

export interface ContinuousTaskItem {
  id: string
  title: string
  sourceUrl?: string
  taskType: TaskType
}

export interface ContinuousManagerDeps {
  store: Store
  getWindow: () => BrowserWindow | null
  getWebContents: (platformId: PlatformId) => WebContents | null
}

export class ContinuousManager {
  private state: ContinuousPlaybackState = 'idle'
  private policy: PlayPolicy = 'video_only'
  private platformId: PlatformId = 'testbed'
  private courseId: string | null = null
  private queue: ContinuousTaskItem[] = []
  private currentTaskId: string | null = null
  private lastEndedTaskId: string | null = null
  private currentObserver: PlayerObserver | null = null
  private abortController: AbortController | null = null

  constructor(private readonly deps: ContinuousManagerDeps) {}

  getState(): {
    state: ContinuousPlaybackState
    policy: PlayPolicy
    platformId: PlatformId
    courseId: string | null
    currentTaskId: string | null
    queueLength: number
  } {
    return {
      state: this.state,
      policy: this.policy,
      platformId: this.platformId,
      courseId: this.courseId,
      currentTaskId: this.currentTaskId,
      queueLength: this.queue.length
    }
  }

  setPolicy(policy: PlayPolicy): void {
    this.policy = policy
  }

  /**
   * 启动连续播放流程。
   */
  async start(params: {
    platformId: PlatformId
    courseId?: string
    queue: Array<ContinuousTaskItem | string>
    initialTaskId?: string
    policy?: PlayPolicy
  }): Promise<{ ok: boolean; queue: string[]; message?: string }> {
    this.stop()

    this.platformId = params.platformId
    this.courseId = params.courseId ?? 'current'
    this.policy = params.policy ?? this.policy
    this.queue = params.queue.map((item) =>
      typeof item === 'string'
        ? { id: item, title: item, taskType: 'video' }
        : item
    )
    this.currentTaskId = params.initialTaskId ?? this.queue[0]?.id ?? null
    this.lastEndedTaskId = null
    this.state = 'playing'

    await this.deps.store.log('info', 'continuous_started', {
      platformId: this.platformId,
      courseId: this.courseId,
      queueCount: this.queue.length,
      initialTaskId: this.currentTaskId,
      policy: this.policy
    })

    // 开始观测当前首个任务
    if (this.currentTaskId) {
      this.bindObserver(this.currentTaskId)
    }
    return { ok: true, queue: this.queue.map((t) => t.id) }
  }

  /**
   * 停止连续播放（立即生效，取消未完成的导航与重试）。
   */
  stop(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.currentObserver) {
      this.currentObserver.stop()
      this.currentObserver = null
    }
    this.state = 'stopped'
    this.currentTaskId = null
    this.lastEndedTaskId = null

    const win = this.deps.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('video:continuous-stopped', {
        at: new Date().toISOString()
      })
    }
  }

  /**
   * 课程切换或退出时清理全部状态，杜绝跨课程串队列。
   */
  resetCourse(): void {
    this.stop()
    this.queue = []
    this.courseId = null
    this.state = 'idle'
  }

  /**
   * 绑定指定任务的播放器观测器。
   */
  bindObserver(taskId: string): void {
    if (this.currentObserver) {
      this.currentObserver.stop()
      this.currentObserver = null
    }

    const wc = this.deps.getWebContents(this.platformId)
    if (!wc || wc.isDestroyed()) return

    this.currentTaskId = taskId
    this.currentObserver = new PlayerObserver(
      taskId,
      wc,
      (obs) => this.handleObservation(obs)
    )
    this.currentObserver.start()
  }

  /**
   * 处理单次播放器观测回调，驱动连续播放状态机。
   */
  async handleObservation(obs: PlaybackObservation): Promise<void> {
    const win = this.deps.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('video:observation', obs)
    }

    // 仅在处于正常播放状态且当前任务触发 ended 时处理
    if (
      this.state === 'playing' &&
      obs.playerState === 'ended' &&
      obs.taskId === this.currentTaskId &&
      obs.taskId !== this.lastEndedTaskId
    ) {
      this.lastEndedTaskId = obs.taskId
      await this.advanceToNextTask(obs.taskId)
    }
  }

  /**
   * 推进到队列中的下一个任务。
   */
  private async advanceToNextTask(completedTaskId: string): Promise<void> {
    if (this.state !== 'playing') return
    this.state = 'transitioning'

    const currentIndex = this.queue.findIndex((t) => t.id === completedTaskId)
    if (currentIndex === -1 || currentIndex >= this.queue.length - 1) {
      // 队列已到底
      this.state = 'completed'
      const win = this.deps.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('video:continuous-completed', {
          completedAt: new Date().toISOString()
        })
      }
      await this.deps.store.log('info', 'continuous_completed', {
        courseId: this.courseId,
        lastTaskId: completedTaskId
      })
      return
    }

    // 寻找下一个符合策略的任务
    let nextIndex = currentIndex + 1
    let nextCandidate: ContinuousTaskItem | null = null

    while (nextIndex < this.queue.length) {
      const candidate = this.queue[nextIndex]!
      if (this.policy === 'video_only') {
        if (candidate.taskType === 'video' || candidate.taskType === 'unknown') {
          nextCandidate = candidate
          break
        } else {
          // 自动跳过非视频任务，明确记录并不代表平台完成
          await this.deps.store.log('info', 'continuous_skipped_non_video', {
            skippedId: candidate.id,
            title: candidate.title,
            type: candidate.taskType,
            note: '自动跳过不代表平台任务完成'
          })
          const win = this.deps.getWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('video:task-skipped', {
              taskId: candidate.id,
              title: candidate.title,
              taskType: candidate.taskType,
              reason: '连播策略配置为仅播放视频，已自动跳过该任务'
            })
          }
          nextIndex++
        }
      } else {
        // stop_on_non_video: 遇到非视频任务即停下来给用户确认
        nextCandidate = candidate
        break
      }
    }

    if (!nextCandidate) {
      this.state = 'completed'
      const win = this.deps.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('video:continuous-completed', {
          completedAt: new Date().toISOString()
        })
      }
      return
    }

    // 检查候选任务是否为非视频且策略要求暂停
    if (this.policy === 'stop_on_non_video' && nextCandidate.taskType !== 'video' && nextCandidate.taskType !== 'unknown') {
      this.state = 'paused_non_video'
      const win = this.deps.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('video:continuous-paused-non-video', {
          currentTaskId: nextCandidate.id,
          title: nextCandidate.title,
          taskType: nextCandidate.taskType,
          reason: `连播遇到非视频任务（${nextCandidate.title}），已安全暂停等待操作`
        })
      }
      return
    }

    // 开始切换导航到下一个任务
    const abort = new AbortController()
    this.abortController = abort

    try {
      const wc = this.deps.getWebContents(this.platformId)
      if (!wc || wc.isDestroyed()) {
        throw new Error('平台视图不可用')
      }

      // 1. 停止旧 Observer
      if (this.currentObserver) {
        this.currentObserver.stop()
        this.currentObserver = null
      }

      // 2. 如果具有新的独立页面链接，执行页面导航与组件检测
      const currentUrl = wc.getURL()
      const targetUrl = nextCandidate.sourceUrl
      const isNavNeeded =
        targetUrl &&
        (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) &&
        targetUrl !== currentUrl

      if (isNavNeeded) {
        await wc.loadURL(targetUrl)
        if (abort.signal.aborted) return

        // 等待基本 DOM 就绪
        await new Promise((r) => setTimeout(r, 600))
        if (abort.signal.aborted) return

        // 3. 进入页面后对 unknown 或未验证任务执行真实组件检查
        const inspection = await inspectChapterInWebContents(wc, nextCandidate.id)
        if (abort.signal.aborted) return

        nextCandidate.taskType = inspection.taskType
        const win = this.deps.getWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('video:chapter-inspected', inspection)
        }

        // 4. 若经页面检查确认为非视频任务
        if (inspection.taskType !== 'video') {
          if (this.policy === 'stop_on_non_video') {
            this.state = 'paused_non_video'
            win?.webContents.send('video:continuous-paused-non-video', {
              currentTaskId: nextCandidate.id,
              title: nextCandidate.title,
              taskType: inspection.taskType,
              reason: `页面实测确认为 ${inspection.taskType} 任务，已安全暂停等待操作`
            })
            return
          } else {
            // video_only 策略：继续查找下一个视频
            this.state = 'playing'
            return this.advanceToNextTask(nextCandidate.id)
          }
        }
      }

      if (abort.signal.aborted) return

      // 5. 目标已确认包含可播放媒体：重绑 Observer 并下发起播
      this.bindObserver(nextCandidate.id)
      await commandPlayer(wc, 'play', undefined, nextCandidate.id)

      this.currentTaskId = nextCandidate.id
      this.state = 'playing'

      const win = this.deps.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('video:task-switched', {
          previousTaskId: completedTaskId,
          currentTaskId: nextCandidate.id,
          taskType: nextCandidate.taskType,
          title: nextCandidate.title
        })
      }

      await this.deps.store.log('info', 'continuous_switched', {
        from: completedTaskId,
        to: nextCandidate.id,
        title: nextCandidate.title
      })
    } catch (err) {
      if (abort.signal.aborted) return
      this.state = 'error'
      const errMsg = err instanceof Error ? err.message : String(err)
      const win = this.deps.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('video:continuous-error', {
          code: 'NAVIGATION_FAILED',
          message: `自动切换至任务 ${nextCandidate.title} 失败: ${errMsg}`,
          taskId: nextCandidate.id
        })
      }
      await this.deps.store.log('error', 'continuous_error', {
        targetTaskId: nextCandidate.id,
        error: errMsg
      })
    } finally {
      if (this.abortController === abort) {
        this.abortController = null
      }
    }
  }

  dispose(): void {
    this.resetCourse()
  }
}
