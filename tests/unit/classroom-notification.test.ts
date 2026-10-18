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
    expect(keys).toContain('yuketang:31890235:ykt-hw-56573570:new')
    expect(keys).toContain('chaoxing:265867291:cx-act-4000174809020:new')
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
      endAt: new Date(BASE_TIME + 48 * 60 * 60 * 1000).toISOString(),
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
    expect(keys).toContain('chaoxing:c1:common-id-888:new')
    expect(keys).toContain('yuketang:c2:common-id-888:new')
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

  it('9. 修正疑似学期默认截止时间：学期统一边界 (semester_default) 不产生紧急截止提醒', async () => {
    // 模拟时间推进到距离学期边界 2027-01-31 仅剩 1 小时
    const SEMESTER_END = new Date('2027-01-31T15:59:59.000Z').getTime()
    const TEST_NOW = SEMESTER_END - 50 * 60 * 1000 // 剩余 50 分钟

    const manager = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => TEST_NOW
    })

    const semesterDefaultActivity: ClassroomActivityItem = {
      id: 'ykt-hw-57318508',
      platformId: 'yuketang',
      courseId: '31890235',
      courseName: '战略性思维',
      classId: '31890235',
      title: '毛康珊老师课后作业',
      category: 'quiz',
      status: 'open',
      startAt: '2026-09-21T09:21:14.000Z',
      endAt: '2027-01-31T15:59:59.000Z',
      sourceUrl: 'https://www.yuketang.cn',
      fetchedAt: new Date(TEST_NOW).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high',
      deadlineSource: 'semester_default',
      deadlineNotice: '学期统一默认时间 (仅供参考，非教师单独设置)'
    }

    const triggered = await manager.processActivities('yuketang', [semesterDefaultActivity])

    // 重点验证：虽然剩余时间不足 1 小时，但因被判定为学期默认边界，绝不触发紧急提醒！
    expect(triggered.filter((t) => t.triggerType.startsWith('deadline')).length).toBe(0)
    expect(sentNotifications.filter((t) => t.triggerType.startsWith('deadline')).length).toBe(0)
  })

  it('10. 修正多级提醒重叠：同时满足 24h 和 2h 条件时同一轮同步仅发一条（优先 2h 紧急）', async () => {
    const manager = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => BASE_TIME
    })

    // 首次发现活动时（已超过24h发布），距离截止仅剩 45 分钟（同时属于 <=24h 和 <=2h 窗口）
    const urgentTask: ClassroomActivityItem = {
      id: 'cx-urgent-task-1',
      platformId: 'chaoxing',
      courseId: 'course-english',
      courseName: '学术英语交流',
      classId: 'class-01',
      title: '随堂紧急小测',
      category: 'quiz',
      status: 'open',
      startAt: new Date(BASE_TIME - 30 * 60 * 60 * 1000).toISOString(), // 30 小时前发布（历史任务，无 new 弹窗）
      endAt: new Date(BASE_TIME + 45 * 60 * 1000).toISOString(), // 剩余 45 分钟截止
      sourceUrl: 'https://mooc1.chaoxing.com',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high',
      deadlineSource: 'teacher_explicit'
    }

    const triggered = await manager.processActivities('chaoxing', [urgentTask])

    // 重点验证：同一轮同步中最多触发一条截止提醒，且优先选择更紧急的 deadline_urgent
    expect(triggered.length).toBe(1)
    expect(triggered[0].triggerType).toBe('deadline_urgent')
    expect(triggered[0].notifTitle).toContain('[即将截止]')
    expect(sentNotifications.length).toBe(1)

    // 重复同步执行时完全幂等，不造成重复弹窗
    const round2 = await manager.processActivities('chaoxing', [urgentTask])
    expect(round2.length).toBe(0)
    expect(sentNotifications.length).toBe(1)
  })

  it('11. 不同课程相同活动 ID 绝不冲突（platformId + courseId 严格命名空间隔离）', async () => {
    const manager = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => BASE_TIME
    })

    // 课程 A 与课程 B 具有相同活动 ID "hw-shared-999"
    const actCourseA: ClassroomActivityItem = {
      id: 'hw-shared-999',
      platformId: 'chaoxing',
      courseId: 'course-math',
      courseName: '高等数学',
      classId: 'class-math-01',
      title: '第一周作业',
      category: 'task',
      status: 'open',
      startAt: new Date(BASE_TIME - 10 * 60 * 1000).toISOString(),
      endAt: new Date(BASE_TIME + 48 * 60 * 60 * 1000).toISOString(),
      sourceUrl: 'https://chaoxing.com',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high'
    }

    const actCourseB: ClassroomActivityItem = {
      id: 'hw-shared-999',
      platformId: 'chaoxing',
      courseId: 'course-physics',
      courseName: '大学物理',
      classId: 'class-phys-01',
      title: '力学练习',
      category: 'task',
      status: 'open',
      startAt: new Date(BASE_TIME - 10 * 60 * 1000).toISOString(),
      endAt: new Date(BASE_TIME + 48 * 60 * 60 * 1000).toISOString(),
      sourceUrl: 'https://chaoxing.com',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high'
    }

    await manager.processActivities('chaoxing', [actCourseA])
    await manager.processActivities('chaoxing', [actCourseB])

    // 两门不同课程的相同活动 ID 均成功提醒，互不覆盖
    expect(sentNotifications.length).toBe(2)
    expect(sentNotifications[0].courseName).toBe('高等数学')
    expect(sentNotifications[1].courseName).toBe('大学物理')

    const keys = await manager.getNotifiedKeys()
    expect(keys).toContain('chaoxing:course-math:hw-shared-999:new')
    expect(keys).toContain('chaoxing:course-physics:hw-shared-999:new')
  })

  it('12. 任务已过期（endAt <= now）绝不产生虚假临期通知', async () => {
    const manager = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => BASE_TIME
    })

    const expiredTask: ClassroomActivityItem = {
      id: 'expired-hw-1',
      platformId: 'chaoxing',
      courseId: 'course-cs',
      courseName: '编译原理',
      classId: 'class-01',
      title: '期中作业',
      category: 'task',
      status: 'open',
      startAt: new Date(BASE_TIME - 5 * 24 * 60 * 60 * 1000).toISOString(),
      endAt: new Date(BASE_TIME - 10 * 60 * 1000).toISOString(), // 10 分钟前已截止
      sourceUrl: 'https://mooc1.chaoxing.com',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high',
      deadlineSource: 'teacher_explicit'
    }

    const triggered = await manager.processActivities('chaoxing', [expiredTask])
    expect(triggered.length).toBe(0)
    expect(sentNotifications.length).toBe(0)
  })

  it('13. 重启后不会补发已结束活动，应用关闭一天后在截止前 1 小时恢复仅发一条紧急提醒', async () => {
    // 阶段 1：任务发布于 25 小时前（历史任务）
    const publishTime = BASE_TIME - 25 * 60 * 60 * 1000
    const deadlineTime = BASE_TIME + 60 * 60 * 1000 // 今天还有 1 小时截止

    const act: ClassroomActivityItem = {
      id: 'restart-act-urgent',
      platformId: 'chaoxing',
      courseId: 'course-ee',
      courseName: '模拟电子技术',
      classId: 'class-01',
      title: '实验报告',
      category: 'task',
      status: 'open',
      startAt: new Date(publishTime).toISOString(),
      endAt: new Date(deadlineTime).toISOString(),
      sourceUrl: 'https://mooc1.chaoxing.com',
      fetchedAt: new Date(BASE_TIME).toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high',
      deadlineSource: 'teacher_explicit'
    }

    // 模拟应用关闭一天后，在截止前 1 小时重新启动运行
    const managerRestart = new ClassroomNotificationManager({
      store: mockStore,
      sender: (payload) => sentNotifications.push(payload),
      now: () => BASE_TIME
    })

    const triggered = await managerRestart.processActivities('chaoxing', [act])

    // 重点验证：重启后历史 new 被静默记录，截止前 1 小时仅触发一条 deadline_urgent 提醒
    expect(triggered.length).toBe(1)
    expect(triggered[0].triggerType).toBe('deadline_urgent')
    expect(triggered[0].notifTitle).toContain('[即将截止]')
    expect(sentNotifications.length).toBe(1)
  })
})

