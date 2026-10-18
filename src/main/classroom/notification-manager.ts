/**
 * 课堂活动通知与去重管理器。
 *
 * 核心契约与安全规则（开发规范 §4 & v0.4.1 验收要求）：
 * 1. 首次同步不能向用户集中弹出历史通知：
 *    - 凡发布时间早于 24 小时前（或已结束）的历史进行中活动，首次同步执行静默基线记录（Silent Seed），不触发弹窗。
 * 2. 只有符合提醒条件的活动才触发 Windows 桌面通知：
 *    - 仅 status === 'open' 且（近期新发布 或 临近截止时间）的活动触发通知。
 * 3. 临近截止时间的提醒不会因新活动去重而被错误抑制：
 *    - 通知 Key 按触发阶段细分命名空间（:new, :deadline-24h, :deadline-2h），
 *      即使已通知过新发布，到达截止临界窗口依然精准提醒。
 * 4. 同一平台、课程、活动的相同阶段通知绝不重复。
 * 5. 不同平台的相同活动 ID 绝不发生冲突（包含 platformId 前缀命名空间）。
 * 6. 支持关闭重启后的持久化恢复（cache/notified-activities.json）。
 * 7. 支持测试环境隔离，避免向用户桌面大量发送测试通知。
 */

import type { ClassroomActivityItem, PlatformId, ClassroomActivityCategory } from '@shared/types'
import type { Store } from '../services/store'

export type NotificationTriggerType = 'new_publish' | 'deadline_approaching' | 'deadline_urgent'

export interface NotificationPayload {
  key: string
  triggerType: NotificationTriggerType
  platformId: PlatformId
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
      // 1. 非 open 状态（如 closed 已结束、pending 待开放）一律不触发任何通知
      if (act.status !== 'open') {
        continue
      }

      const actId = act.id
      const baseKey = `${platformId}:${actId}`
      const newKey = `${baseKey}:new`
      const d24hKey = `${baseKey}:deadline-24h`
      const d2hKey = `${baseKey}:deadline-2h`

      // 兼容历史单一 ID 存储格式（仅在 ID 携带平台前缀时兼容，避免无前缀 ID 跨平台串扰）
      const isLegacyPrefixed =
        (platformId === 'chaoxing' && actId.startsWith('cx-')) ||
        (platformId === 'yuketang' && actId.startsWith('ykt-'))
      const alreadyHasNew =
        this.notifiedKeys.has(newKey) ||
        this.notifiedKeys.has(baseKey) ||
        (isLegacyPrefixed && this.notifiedKeys.has(actId))

      let justNotifiedNew = false

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
          justNotifiedNew = true

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

      // 3. 检查「临近截止时间」提醒逻辑（独立去重 Key，不受 new 已发送影响）
      // 若当前 tick 刚刚触发过 new_publish，则本 tick 已提醒过新任务，不需要同秒再弹一次截止弹窗
      if (act.endAt) {
        const remainingMs = new Date(act.endAt).getTime() - currentTime
        if (remainingMs > 0) {
          // 3.1 紧急临界（剩余 <= 2 小时）
          if (remainingMs <= 2 * 60 * 60 * 1000) {
            if (justNotifiedNew) {
              // 新发布且生命周期很短（如15分钟签到），new 提醒已覆盖，静默记录避免同秒双弹
              this.notifiedKeys.add(d2hKey)
              this.notifiedKeys.add(d24hKey)
              stateChanged = true
            } else if (!this.notifiedKeys.has(d2hKey)) {
              this.notifiedKeys.add(d2hKey)
              this.notifiedKeys.add(d24hKey) // 2h 触发同时抑制 24h 重复提醒
              stateChanged = true

              const notifTitle = `[即将截止] [${act.courseName || platformId}] ${act.title}`
              const notifBody = `距离截止仅剩 ${formatRemainingDuration(remainingMs)}，请尽快提交处理！`

              const payload: NotificationPayload = {
                key: d2hKey,
                triggerType: 'deadline_urgent',
                platformId,
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
          // 3.2 临近截止（剩余 <= 24 小时）
          else if (remainingMs <= 24 * 60 * 60 * 1000) {
            if (justNotifiedNew) {
              // 刚发布且截止在 24h 内，new 提醒已覆盖当前知会，记录 24h key，等进入 <= 2h 时再紧急提醒
              this.notifiedKeys.add(d24hKey)
              stateChanged = true
            } else if (!this.notifiedKeys.has(d24hKey)) {
              this.notifiedKeys.add(d24hKey)
              stateChanged = true

              const notifTitle = `[临近截止] [${act.courseName || platformId}] ${act.title}`
              const notifBody = `任务即将在 ${formatRemainingDuration(remainingMs)} 后截止，请合理安排时间。`

              const payload: NotificationPayload = {
                key: d24hKey,
                triggerType: 'deadline_approaching',
                platformId,
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
