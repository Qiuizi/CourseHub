import { describe, it, expect, beforeEach } from 'vitest'
import {
  ClassroomNotificationManager,
  formatRemainingDuration,
  type NotificationPayload
} from '../../src/main/classroom/notification-manager'
import type { ClassroomActivityItem } from '../../src/shared/types'

describe('ClassroomNotificationManager 课堂活动通知与去重审计', () => {
  let memoryStore: Record<string, unknown>
  let mockStore: {
    readJson: <T>(k: string, fallback: T) => Promise<T>
    writeJson: (k: string, val: unknown) => Promise<void>
  }
  let sentNotifications: NotificationPayload[]

  const BASE_TIME = new Date('2026-10-18T12:00:00.000Z').getTime()

  beforeEach(() => {
    memoryStore = {}
    mockStore = {
      readJson: async <T>(k: string, fallback: T): Promise<T> => {
        return (memoryStore[k] as T) ?? fallback
      },
      writeJson: async (k: string, val: unknown): Promise<void> => {
        memoryStore[k] = val
      }
    }
    sentNotifications = []
  })

  it('1. 首次同步不能向用户集中弹出历史通知（发布时间超过 24 小时的活动执行静默记录）', async () => {
    const manager = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => BASE_TIME
    })

    // 模拟雨课堂 4 项历史作业（发布于 2026-08-31 ~ 2026-09-21，早于当前时间 20+ 天）
    // 模拟超星历史任务（发布于 5 天前 2026-10-13）
    const historicalActivities: ClassroomActivityItem[] = [
      {
        id: 'ykt-hw-56573570',
        platformId: 'yuketang',
        courseId: '31890235',
        courseName: '战略性思维',
        classId: '31890235',
        title: '赵长轶老师课后作业',
        category: 'quiz',
        status: 'open',
        startAt: '2026-08-31T10:29:33.000Z', // 48 天前
        endAt: '2027-01-31T15:59:59.000Z',
        sourceUrl: 'https://www.yuketang.cn',
        fetchedAt: new Date(BASE_TIME).toISOString(),
        locationRequired: false,
        locationText: null,
        signInKind: 'unknown',
        confidence: 'high'
      },
      {
        id: 'cx-act-4000174809020',
        platformId: 'chaoxing',
        courseId: '265867291',
        courseName: '26秋-学术英语交流',
        classId: '151361493',
        title: 'Script for Oral Presentation on Academic Paper',
        category: 'task',
        status: 'open',
        startAt: '2026-10-13T00:05:00.000Z', // 5 天前
        endAt: '2026-10-20T15:59:00.000Z',   // 2 天后，尚未进入 24h 截止临界
        sourceUrl: 'https://mooc1.chaoxing.com',
        fetchedAt: new Date(BASE_TIME).toISOString(),
        locationRequired: false,
        locationText: null,
        signInKind: 'unknown',
        confidence: 'high'
      }
    ]

    const triggered = await manager.processActivities('yuketang', [historicalActivities[0]])
    const triggered2 = await manager.processActivities('chaoxing', [historicalActivities[1]])

    // 重点验收：首次同步零弹窗！
    expect(triggered.length).toBe(0)
    expect(triggered2.length).toBe(0)
    expect(sentNotifications.length).toBe(0)

    // 但其 ID 与 Key 已被静默登记，不会在下次作为“新活动”触发
    const keys = await manager.getNotifiedKeys()
    expect(keys).toContain('yuketang:ykt-hw-56573570:new')
    expect(keys).toContain('ykt-hw-56573570')
    expect(keys).toContain('chaoxing:cx-act-4000174809020:new')
    expect(keys).toContain('cx-act-4000174809020')
  })

  it('2. 真正近期发布（<24h）的新活动必须精准触发 Windows 通知', async () => {
    const manager = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => BASE_TIME
    })

    const freshActivity: ClassroomActivityItem = {
      id: 'cx-act-new-999',
      platformId: 'chaoxing',
      courseId: '265867291',
      courseName: '26秋-学术英语交流',
      classId: '151361493',
      title: '随堂限时快速练习',
      category: 'task',
      status: 'open',
      startAt: new Date(BASE_TIME - 30 * 60 * 1000).toISOString(), // 30 分钟前刚刚发布
      endAt: new Date(BASE_TIME + 2 * 24 * 60 * 60 * 1000).toISOString(),
      sourceUrl: 'https://mooc1.chaoxing.com/test',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high'
    }

    const triggered = await manager.processActivities('chaoxing', [freshActivity])

    expect(triggered.length).toBe(1)
    expect(triggered[0].triggerType).toBe('new_publish')
    expect(triggered[0].notifTitle).toContain('随堂限时快速练习')
    expect(sentNotifications.length).toBe(1)
  })

  it('3. 同一平台同一活动不重复提醒（去重幂等性）', async () => {
    const manager = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => BASE_TIME
    })

    const act: ClassroomActivityItem = {
      id: 'cx-act-fresh',
      platformId: 'chaoxing',
      courseId: '101',
      courseName: '计算机网络',
      classId: '202',
      title: '课堂签到',
      category: 'sign_in',
      status: 'open',
      startAt: new Date(BASE_TIME - 10 * 60 * 1000).toISOString(),
      endAt: new Date(BASE_TIME + 20 * 60 * 1000).toISOString(),
      sourceUrl: 'https://mooc1.chaoxing.com',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'normal',
      confidence: 'high'
    }

    // 第一次处理：触发
    await manager.processActivities('chaoxing', [act])
    expect(sentNotifications.length).toBe(1)

    // 第二次处理（同一活动）：被 Set 去重拦截，不再通知
    await manager.processActivities('chaoxing', [act])
    expect(sentNotifications.length).toBe(1)
  })

  it('4. 不同平台的相同活动 ID 绝不冲突（platformId 命名空间隔离）', async () => {
    const manager = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => BASE_TIME
    })

    // 两个平台均有 ID 为 "common-id-888" 的新活动
    const cxAct: ClassroomActivityItem = {
      id: 'common-id-888',
      platformId: 'chaoxing',
      courseId: 'c1',
      courseName: '超星测试课',
      classId: 'cl1',
      title: '超星作业',
      category: 'task',
      status: 'open',
      startAt: new Date(BASE_TIME - 5 * 60 * 1000).toISOString(),
      endAt: null,
      sourceUrl: 'https://chaoxing.com',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high'
    }

    const yktAct: ClassroomActivityItem = {
      id: 'common-id-888',
      platformId: 'yuketang',
      courseId: 'c2',
      courseName: '雨课堂测试课',
      classId: 'cl2',
      title: '雨课堂作业',
      category: 'quiz',
      status: 'open',
      startAt: new Date(BASE_TIME - 5 * 60 * 1000).toISOString(),
      endAt: null,
      sourceUrl: 'https://yuketang.cn',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high'
    }

    await manager.processActivities('chaoxing', [cxAct])
    await manager.processActivities('yuketang', [yktAct])

    // 两个平台的通知均成功触发，互不冲突
    expect(sentNotifications.length).toBe(2)
    expect(sentNotifications[0].platformId).toBe('chaoxing')
    expect(sentNotifications[1].platformId).toBe('yuketang')

    const keys = await manager.getNotifiedKeys()
    expect(keys).toContain('chaoxing:common-id-888:new')
    expect(keys).toContain('yuketang:common-id-888:new')
  })

  it('5. 临近截止时间提醒不会因新活动已通知而被错误抑制', async () => {
    let currentTime = BASE_TIME
    const manager = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => currentTime
    })

    // 阶段 A: 发布时（3 天后截止，不在 24h 临界内）
    const deadlineTask: ClassroomActivityItem = {
      id: 'deadline-task-1',
      platformId: 'chaoxing',
      courseId: '265867291',
      courseName: '学术英语交流',
      classId: '151361493',
      title: 'Presentation Script',
      category: 'task',
      status: 'open',
      startAt: new Date(BASE_TIME - 10 * 60 * 1000).toISOString(), // 刚刚发布
      endAt: new Date(BASE_TIME + 72 * 60 * 60 * 1000).toISOString(), // 3 天后截止
      sourceUrl: 'https://mooc1.chaoxing.com',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high'
    }

    // 第一次触发新发布提醒
    await manager.processActivities('chaoxing', [deadlineTask])
    expect(sentNotifications.length).toBe(1)
    expect(sentNotifications[0].triggerType).toBe('new_publish')

    // 阶段 B: 时间推进 52 小时后（距离截止剩余 20 小时，进入 24h 临近窗口）
    currentTime += 52 * 60 * 60 * 1000
    await manager.processActivities('chaoxing', [deadlineTask])

    // 重点验证：虽然前面已经通知过 new，进入 24h 临近窗口时成功触发提醒！未被 new 抑制！
    expect(sentNotifications.length).toBe(2)
    expect(sentNotifications[1].triggerType).toBe('deadline_approaching')
    expect(sentNotifications[1].notifTitle).toContain('[临近截止]')

    // 阶段 C: 时间推进 19 小时后（距离截止仅剩 1 小时，进入紧急 2h 临界）
    currentTime += 19 * 60 * 60 * 1000
    await manager.processActivities('chaoxing', [deadlineTask])

    // 重点验证：进入 2h 紧急窗口时成功触发紧急提醒！
    expect(sentNotifications.length).toBe(3)
    expect(sentNotifications[2].triggerType).toBe('deadline_urgent')
    expect(sentNotifications[2].notifTitle).toContain('[即将截止]')
  })

  it('6. 已关闭 (closed) 或 未开始 (pending) 的活动绝不触发通知', async () => {
    const manager = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => BASE_TIME
    })

    const acts: ClassroomActivityItem[] = [
      {
        id: 'closed-1',
        platformId: 'chaoxing',
        courseId: 'c1',
        courseName: '心理健康',
        classId: 'cl1',
        title: '历史已结束签到',
        category: 'sign_in',
        status: 'closed',
        startAt: new Date(BASE_TIME - 2 * 60 * 60 * 1000).toISOString(),
        endAt: new Date(BASE_TIME - 1 * 60 * 60 * 1000).toISOString(),
        sourceUrl: null,
        fetchedAt: new Date(BASE_TIME).toISOString(),
        locationRequired: false,
        locationText: null,
        signInKind: 'normal',
        confidence: 'high'
      },
      {
        id: 'pending-1',
        platformId: 'chaoxing',
        courseId: 'c1',
        courseName: '心理健康',
        classId: 'cl1',
        title: '未开放问卷',
        category: 'questionnaire',
        status: 'pending',
        startAt: null,
        endAt: null,
        sourceUrl: null,
        fetchedAt: new Date(BASE_TIME).toISOString(),
        locationRequired: false,
        locationText: null,
        signInKind: 'unknown',
        confidence: 'high'
      }
    ]

    const triggered = await manager.processActivities('chaoxing', acts)
    expect(triggered.length).toBe(0)
    expect(sentNotifications.length).toBe(0)
  })

  it('7. 关闭重启后从持久化存储恢复，不重复通知旧活动', async () => {
    // 进程 1：发生了一次通知并持久化
    const manager1 = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => BASE_TIME
    })

    const act: ClassroomActivityItem = {
      id: 'persisted-act-1',
      platformId: 'chaoxing',
      courseId: 'c1',
      courseName: '算法设计',
      classId: 'cl1',
      title: '随堂测试',
      category: 'quiz',
      status: 'open',
      startAt: new Date(BASE_TIME - 10 * 60 * 1000).toISOString(),
      endAt: new Date(BASE_TIME + 48 * 60 * 60 * 1000).toISOString(),
      sourceUrl: 'https://mooc1.chaoxing.com',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high'
    }

    await manager1.processActivities('chaoxing', [act])
    expect(sentNotifications.length).toBe(1)
    expect(memoryStore['cache/notified-activities.json']).toBeDefined()

    // 进程 2：模拟重启应用（新的实例，相同的数据存储）
    const sent2: NotificationPayload[] = []
    const manager2 = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sent2.push(payload),
      now: () => BASE_TIME + 60 * 1000 // 1 分钟后重启启动
    })

    await manager2.processActivities('chaoxing', [act])

    // 重启后从存储加载历史记录，旧活动零通知
    expect(sent2.length).toBe(0)
  })

  it('8. 剩余时间格式化工具函数准确无误', () => {
    expect(formatRemainingDuration(30 * 1000)).toBe('1 分钟')
    expect(formatRemainingDuration(5 * 60 * 1000)).toBe('5 分钟')
    expect(formatRemainingDuration(65 * 60 * 1000)).toBe('1 小时 5 分钟')
    expect(formatRemainingDuration(2 * 60 * 60 * 1000)).toBe('2 小时')
    expect(formatRemainingDuration(23 * 60 * 60 * 1000 + 45 * 60 * 1000)).toBe('23 小时 45 分钟')
    expect(formatRemainingDuration(0)).toBe('0 分钟')
    expect(formatRemainingDuration(-100)).toBe('0 分钟')
  })
})
