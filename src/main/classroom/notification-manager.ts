/**
 * 课堂活动通知与去重管理器。
 *
 * 核心契约与安全规则（开发规范 §4 & v0.4.1 边界修正）：
 * 1. 首次同步不能向用户集中弹出历史通知：
 *    - 凡发布时间早于 24 小时前（或已结束）的历史进行中活动，首次同步执行静默基线记录（Silent Seed），不触发弹窗。
 * 2. 疑似系统默认学期边界只作参考展示：
 *    - 若截止时间判定为学期统一默认边界（semester_default），只在 UI 参考展示，绝不自动发送临近/紧急截止通知。
 * 3. 教师明确截止时间正常提醒：
 *    - 仅 teacher_explicit 的真实截止时间参与临近与紧急截止提醒。
 * 4. 临近截止时间提醒不会因新活动去重而被错误抑制：
 *    - 通知 Key 按触发阶段细分命名空间（:new, :deadline-24h, :deadline-2h），
 *      发布通知后到达截止临界窗口依然精准提醒。
 * 5. 同一活动在同一轮同步中最多触发一条截止提醒，优先选择更紧急的提醒等级（<=2h 优先于 <=24h）。
 * 6. 任务已过期（endAt <= now）或已关闭（status !== 'open'）绝不补发提醒。
 * 7. 不同课程、不同平台的相同活动 ID 绝不冲突（platformId + courseId 命名空间）。
 * 8. 支持关闭重启后的持久化恢复（cache/notified-activities.json），同步重复执行幂等无弹窗。
 */

import type { ClassroomActivityItem, PlatformId, ClassroomActivityCategory } from '@shared/types'
import type { Store } from '../services/store'

export type NotificationTriggerType = 'new_publish' | 'deadline_approaching' | 'deadline_urgent'

export interface NotificationPayload {
  key: string
  triggerType: NotificationTriggerType
  platformId: PlatformId
  courseId: string
  activityId: string
  courseName: string
  title: string
  category: ClassroomActivityCategory
  startAt: string | null
  endAt: string | null
  sourceUrl: string | null
  notifTitle: string
  notifBody: string
}

export interface NotificationManagerOptions {
  store: Pick<Store, 'readJson' | 'writeJson'>
  sender?: (payload: NotificationPayload) => void
  now?: () => number
}

export function formatRemainingDuration(ms: number): string {
  if (ms <= 0) return '0 分钟'
  const totalMinutes = Math.floor(ms / (60 * 1000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) {
    return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
  }
  return `${Math.max(1, minutes)} 分钟`
}

export class ClassroomNotificationManager {
  private readonly store: Pick<Store, 'readJson' | 'writeJson'>
  private readonly sender?: (payload: NotificationPayload) => void
  private readonly now: () => number
  private readonly notifiedKeys = new Set<string>()
  private initialized = false
  private initPromise: Promise<void> | null = null

  constructor(options: NotificationManagerOptions) {
    this.store = options.store
    this.sender = options.sender
    this.now = options.now || (() => Date.now())
  }

  /** 初始化载入持久化去重记录 */
  async init(): Promise<void> {
    if (this.initialized) return
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const saved = await this.store.readJson<string[]>('cache/notified-activities.json', [])
        if (Array.isArray(saved)) {
          for (const k of saved) {
            if (typeof k === 'string' && k.trim().length > 0) {
              this.notifiedKeys.add(k.trim())
            }
          }
        }
        this.initialized = true
      })()
    }
    return this.initPromise
  }

  /** 获取全部已记录去重 Key 列表 */
  async getNotifiedKeys(): Promise<string[]> {
    await this.init()
    return Array.from(this.notifiedKeys)
  }

  /** 判断是否已记录某 Key 或其对应的活动 ID */
  hasKey(key: string): boolean {
    return this.notifiedKeys.has(key)
  }

  /** 手动登记某个 Key（如测试打卡或静默标记） */
  async recordKey(key: string): Promise<void> {
    await this.init()
    if (!this.notifiedKeys.has(key)) {
      this.notifiedKeys.add(key)
      await this.save()
    }
  }

  /**
   * 处理课堂活动列表并判定通知。
   * 返回实际触发通知的 Payload 列表（供调用方发送 IPC 事件或系统通知）。
   */
  async processActivities(
    platformId: PlatformId,
    activities: ClassroomActivityItem[]
  ): Promise<NotificationPayload[]> {
    await this.init()
    const currentTime = this.now()
    const triggered: NotificationPayload[] = []
    let stateChanged = false

    for (const act of activities) {
      // 1. 过滤：非 open 状态（如 closed 已结束、pending 待开放）一律不触发任何通知
      if (act.status !== 'open') {
        continue
      }

      // 如果有截止时间且截止时间已过（<= 当前时间），属于已逾期/已结束任务，绝不触发任何通知
      if (act.endAt && new Date(act.endAt).getTime() <= currentTime) {
        continue
      }

      const actId = act.id
      const courseId = act.courseId || 'general'
      // 命名空间严格隔离：平台 + 课程 + 活动ID
      const baseKey = `${platformId}:${courseId}:${actId}`
      const legacyBaseKey = `${platformId}:${actId}`
      const newKey = `${baseKey}:new`
      const d24hKey = `${baseKey}:deadline-24h`
      const d2hKey = `${baseKey}:deadline-2h`

      // 兼容历史单一 ID 存储格式（仅在带有专用前缀时兼容，避免跨平台或跨课程无前缀冲突）
      const isLegacyPrefixed =
        (platformId === 'chaoxing' && actId.startsWith('cx-')) ||
        (platformId === 'yuketang' && actId.startsWith('ykt-'))
      const alreadyHasNew =
        this.notifiedKeys.has(newKey) ||
        this.notifiedKeys.has(baseKey) ||
        this.notifiedKeys.has(`${legacyBaseKey}:new`) ||
        this.notifiedKeys.has(legacyBaseKey) ||
        (isLegacyPrefixed && this.notifiedKeys.has(actId))

      // 2. 检查「新活动发布」提醒逻辑
      if (!alreadyHasNew) {
        // 判断是否为历史已发布活动（发布时间超过 24 小时）
        const isHistorical = act.startAt
          ? currentTime - new Date(act.startAt).getTime() > 24 * 60 * 60 * 1000
          : false

        if (isHistorical) {
          // 首次同步或启动时发现的历史进行中任务：静默记录（Silent Seed），不弹窗打扰用户
          this.notifiedKeys.add(newKey)
          this.notifiedKeys.add(baseKey)
          if (isLegacyPrefixed) this.notifiedKeys.add(actId)
          stateChanged = true
        } else {
          // 真正近期发布（<24小时）的新活动：触发新活动提醒
          this.notifiedKeys.add(newKey)
          this.notifiedKeys.add(baseKey)
          if (isLegacyPrefixed) this.notifiedKeys.add(actId)
          stateChanged = true

          const notifTitle = `[${act.courseName || platformId}] ${act.title}`
          const notifBody =
            act.category === 'sign_in'
              ? '课堂签到正在进行，请在官方页面处理'
              : act.category === 'quiz'
                ? '有新发布的随堂作业/测验'
                : '发现新的课堂互动，点击前往查看'

          const payload: NotificationPayload = {
            key: newKey,
            triggerType: 'new_publish',
            platformId,
            courseId,
            activityId: actId,
            courseName: act.courseName || '',
            title: act.title,
            category: act.category,
            startAt: act.startAt,
            endAt: act.endAt,
            sourceUrl: act.sourceUrl,
            notifTitle,
            notifBody
          }
          triggered.push(payload)
          if (this.sender) {
            this.sender(payload)
          }
        }
      }

      // 3. 检查「临近截止时间」提醒逻辑
      // 规则：
      // - 若截止时间判定为学期统一默认边界（semester_default），只作参考展示，绝不发送截止通知！
      // - 同一活动在同一轮同步中最多触发一条截止提醒，优先选择更紧急的提醒等级（<=2h 优先于 <=24h）
      const isSemesterDefault = act.deadlineSource === 'semester_default'
      if (act.endAt && !isSemesterDefault) {
        const remainingMs = new Date(act.endAt).getTime() - currentTime
        if (remainingMs > 0) {
          // 3.1 紧急临界（剩余 <= 2 小时）
          if (remainingMs <= 2 * 60 * 60 * 1000) {
            if (!this.notifiedKeys.has(d2hKey)) {
              this.notifiedKeys.add(d2hKey)
              this.notifiedKeys.add(d24hKey) // 2h 触发同时抑制 24h 重复提醒
              stateChanged = true

              const notifTitle = `[即将截止] [${act.courseName || platformId}] ${act.title}`
              const notifBody = `距离截止仅剩 ${formatRemainingDuration(remainingMs)}，请尽快提交处理！`

              const payload: NotificationPayload = {
                key: d2hKey,
                triggerType: 'deadline_urgent',
                platformId,
                courseId,
                activityId: actId,
                courseName: act.courseName || '',
                title: act.title,
                category: act.category,
                startAt: act.startAt,
                endAt: act.endAt,
                sourceUrl: act.sourceUrl,
                notifTitle,
                notifBody
              }
              triggered.push(payload)
              if (this.sender) {
                this.sender(payload)
              }
            }
          }
          // 3.2 临近截止（剩余 <= 24 小时，且 > 2 小时）
          else if (remainingMs <= 24 * 60 * 60 * 1000) {
            if (!this.notifiedKeys.has(d24hKey)) {
              this.notifiedKeys.add(d24hKey)
              stateChanged = true

              const notifTitle = `[临近截止] [${act.courseName || platformId}] ${act.title}`
              const notifBody = `任务即将在 ${formatRemainingDuration(remainingMs)} 后截止，请合理安排时间。`

              const payload: NotificationPayload = {
                key: d24hKey,
                triggerType: 'deadline_approaching',
                platformId,
                courseId,
                activityId: actId,
                courseName: act.courseName || '',
                title: act.title,
                category: act.category,
                startAt: act.startAt,
                endAt: act.endAt,
                sourceUrl: act.sourceUrl,
                notifTitle,
                notifBody
              }
              triggered.push(payload)
              if (this.sender) {
                this.sender(payload)
              }
            }
          }
        }
      }
    }

    if (stateChanged) {
      await this.save()
    }

    return triggered
  }

  private async save(): Promise<void> {
    try {
      await this.store.writeJson('cache/notified-activities.json', Array.from(this.notifiedKeys))
    } catch {
      // 容错持久化异常，不阻断主流程
    }
  }
}
