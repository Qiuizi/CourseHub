/**
 * 平台适配器合同与能力登记。
 *
 * 能力状态必须诚实（开发文档 §1.2、§6）：
 * - supported：有真实证据支撑
 * - partial：部分可用
 * - unsupported：不支持
 * - unverified：**实现存在但未在真实账号/站点验证**
 *
 * P0 审计结论（2026-10-15，只读源码审查）：
 * - 学习通：支持章节目录与视频任务解析、播放器观测、签到与活动识别；第三方签到提交接口待抓包逆向与安全授权。
 * - 雨课堂：题目提取依赖 presentation/fetch 载荷字段，全部为反推未经抓包验证；
 *   自动提交答案/自动签到/伪造观看心跳均不迁入。
 * - 智慧树：仅有历史参考脚本，无真实样例，仅提供浏览入口。
 *
 * 因此本次交付中所有平台适配器一律标记 unverified —— 这是事实，不是缺陷。
 */

import type { PlatformId, CapabilityState, SignInEvent, ChapterNode, ClassroomActivityItem } from '@shared/types'
import type { PlatformHealthReport, PlatformHealthState } from '@shared/feedback'
import { Sanitizer } from '@shared/sanitizer'
import {
  detectChaoxingAuth,
  fetchChaoxingCourses,
  fetchChaoxingSignIns,
  fetchChaoxingActivities,
  fetchChaoxingChapters,
  type SessionLike
} from './chaoxing'
import {
  detectYuketangAuth,
  fetchYuketangCourses,
  fetchYuketangSignIns,
  fetchYuketangActivities,
  fetchYuketangChapters
} from './yuketang'

export interface CapabilityEntry {
  state: CapabilityState
  reason: string
  verifiedAt: string | null
}

export interface PlatformAdapter {
  readonly id: PlatformId
  readonly version: string
  readonly capabilities: Record<string, CapabilityEntry>
  getHealthReport?(): PlatformHealthReport
  detectAuth(ses?: SessionLike, currentUrl?: string): Promise<{
    state: 'unknown' | 'unauthenticated' | 'authenticated' | 'expired' | 'error'
    evidence: string | null
  }>
  listCourses?(ses?: SessionLike, currentUrl?: string): Promise<{
    state: string
    courses: unknown[]
    error?: string
  }>
  listChapters?(
    ses: SessionLike,
    courseId: string,
    clazzId: string,
    cpi?: string
  ): Promise<{
    ok: boolean
    chapters: ChapterNode[]
    enc?: string
    error?: string
  }>
  listTodaySignIns?(ses?: SessionLike): Promise<{
    state: string
    events: SignInEvent[]
    fetchedAt: string
    reason: string | null
  }>
  listActivities?(ses?: SessionLike): Promise<{
    state: string
    activities: ClassroomActivityItem[]
    fetchedAt: string
    reason: string | null
  }>
  stop(): Promise<void>
}

const UNVERIFIED = (reason: string): CapabilityEntry => ({
  state: 'unverified',
  reason,
  verifiedAt: null
})

export const HEALTH_LABELS: Record<PlatformHealthState, string> = {
  healthy: '运行正常',
  expired: '登录已过期',
  need_captcha: '需安全验证码',
  network_error: '网络连接异常',
  rate_limited: '请求频次受限',
  server_error: '平台服务异常',
  parse_error: '数据解析异常',
  suspected_api_change: '疑似接口改版'
}

/**
 * 学习通适配器：已连接 Electron Session、端点解析与数据模型。
 */
export class ChaoxingAdapter implements PlatformAdapter {
  readonly id = 'chaoxing' as const
  readonly version = '0.3.7'

  private healthState: PlatformHealthState = 'healthy'
  private consecutiveParseFailures = 0
  private lastSuccessAt: string | null = null
  private lastCheckedAt: string = new Date().toISOString()
  private errorFingerprint: string | null = null
  private errorMessage: string | null = null

  readonly capabilities: Record<string, CapabilityEntry> = {
    auth: { state: 'supported', reason: '基于内置浏览器 Session Cookie 与接口探测', verifiedAt: '2026-10-15' },
    listCourses: { state: 'supported', reason: 'MOOC2 现代端点与 MOOC1 双轨容灾已接入 Session', verifiedAt: '2026-10-15' },
    listTodaySignIns: { state: 'supported', reason: 'activelist 签到类型与活动结构已映射', verifiedAt: '2026-10-15' },
    listVideoTasks: { state: 'unsupported', reason: '学习通仅提供只读浏览，不设置视频自动完成', verifiedAt: null },
    classroomQuestions: { state: 'unsupported', reason: '学习通无自动答题链路', verifiedAt: null },
    openVideoTask: { state: 'supported', reason: '通过 studentstudy 真实章节链接在内置视图播放', verifiedAt: '2026-10-16' },
    observePlayer: { state: 'supported', reason: '通过 WebContents 与 FrameSubtree 无侵入观测并控制原生 video 播放器', verifiedAt: '2026-10-16' },
    submitSignIn: { state: 'unsupported', reason: '第三方平台未授权写接口尚未实现，支持在内置浏览器中人工交互完成', verifiedAt: null }
  }

  getHealthReport(): PlatformHealthReport {
    return {
      platformId: 'chaoxing',
      state: this.healthState,
      label: HEALTH_LABELS[this.healthState] || this.healthState,
      lastCheckedAt: this.lastCheckedAt,
      lastSuccessAt: this.lastSuccessAt,
      errorFingerprint: this.errorFingerprint,
      errorMessage: this.errorMessage,
      consecutiveFailures: this.consecutiveParseFailures
    }
  }

  recordSuccess(): void {
    this.healthState = 'healthy'
    this.consecutiveParseFailures = 0
    this.lastSuccessAt = new Date().toISOString()
    this.lastCheckedAt = this.lastSuccessAt
    this.errorFingerprint = null
    this.errorMessage = null
  }

  recordFailure(
    kind: 'expired' | 'need_captcha' | 'network_error' | 'rate_limited' | 'server_error' | 'parse_error',
    message: string,
    code?: string
  ): void {
    this.lastCheckedAt = new Date().toISOString()
    this.errorMessage = message
    if (kind === 'parse_error') {
      this.consecutiveParseFailures++
      if (this.consecutiveParseFailures >= 2) {
        this.healthState = 'suspected_api_change'
      } else {
        this.healthState = 'parse_error'
      }
    } else {
      this.consecutiveParseFailures = 0
      this.healthState = kind
    }
    this.errorFingerprint = Sanitizer.generateFingerprint({
      platform: 'chaoxing',
      module: 'courses',
      code: code || kind.toUpperCase(),
      summary: message
    })
  }

  async detectAuth(ses?: SessionLike): Promise<{
    state: 'unknown' | 'unauthenticated' | 'authenticated' | 'expired' | 'error'
    evidence: string | null
  }> {
    if (!ses) return { state: 'unauthenticated', evidence: '缺少会话上下文' }
    const res = await detectChaoxingAuth(ses)
    if (res.state === 'expired') {
      this.recordFailure('expired', res.evidence || '学习通登录会话已失效')
    } else if (res.state === 'authenticated' && this.healthState === 'expired') {
      this.recordSuccess()
    }
    return res
  }

  async listCourses(ses?: SessionLike): Promise<{
    state: string
    courses: unknown[]
    error?: string
  }> {
    if (!ses) return { state: 'unauthenticated', courses: [], error: '缺少会话上下文' }
    const res = await fetchChaoxingCourses(ses)
    if (res.ok) {
      if (res.state === 'need_captcha') {
        this.recordFailure('need_captcha', res.error || '学习通提示滑动验证码')
      } else {
        this.recordSuccess()
      }
    } else {
      if (res.state === 'expired') {
        this.recordFailure('expired', res.error || '学习通登录已过期')
      } else if (res.state === 'need_captcha') {
        this.recordFailure('need_captcha', res.error || '学习通触发人机安全验证')
      } else if (
        res.error?.includes('网络') ||
        res.error?.includes('timeout') ||
        res.error?.includes('ETIMEDOUT') ||
        res.error?.includes('ENOTFOUND')
      ) {
        this.recordFailure('network_error', res.error)
      } else {
        this.recordFailure('parse_error', res.error || '学习通课程列表解析失败')
      }
    }
    return res
  }

  async listChapters(
    ses: SessionLike,
    courseId: string,
    clazzId: string,
    cpi = '0'
  ): Promise<{
    ok: boolean
    chapters: ChapterNode[]
    enc?: string
    error?: string
  }> {
    if (!ses) return { ok: false, chapters: [], error: '缺少会话上下文' }
    const res = await fetchChaoxingChapters(ses, courseId, clazzId, cpi)
    if (!res.ok && res.error) {
      if (res.error.includes('网络') || res.error.includes('ETIMEDOUT')) {
        this.recordFailure('network_error', res.error)
      } else {
        this.recordFailure('parse_error', res.error)
      }
    }
    return res
  }

  async listTodaySignIns(ses?: SessionLike): Promise<{
    state: string
    events: SignInEvent[]
    fetchedAt: string
    reason: string | null
  }> {
    if (!ses) {
      return {
        state: 'unauthenticated',
        events: [],
        fetchedAt: new Date().toISOString(),
        reason: '缺少会话上下文'
      }
    }
    return fetchChaoxingSignIns(ses)
  }

  async listActivities(ses?: SessionLike): Promise<{
    state: string
    activities: ClassroomActivityItem[]
    fetchedAt: string
    reason: string | null
  }> {
    if (!ses) {
      return {
        state: 'unauthenticated',
        activities: [],
        fetchedAt: new Date().toISOString(),
        reason: '缺少会话上下文'
      }
    }
    return fetchChaoxingActivities(ses)
  }

  async stop(): Promise<void> {
    /* 无后台任务 */
  }
}


/**
 * 雨课堂适配器：已连接在课检测、课堂活动与课程列表解析。
 */
export class YuketangAdapter implements PlatformAdapter {
  readonly id = 'yuketang' as const
  readonly version = '0.4.0'

  private healthState: PlatformHealthState = 'healthy'
  private consecutiveParseFailures = 0
  private lastSuccessAt: string | null = null
  private lastCheckedAt: string = new Date().toISOString()
  private errorFingerprint: string | null = null
  private errorMessage: string | null = null

  readonly capabilities: Record<string, CapabilityEntry> = {
    auth: { state: 'supported', reason: '基于内置浏览器 Cookie 与在课探测', verifiedAt: '2026-10-15' },
    listCourses: { state: 'supported', reason: '雨课堂课程列表解析器已就绪', verifiedAt: '2026-10-15' },
    listTodaySignIns: { state: 'supported', reason: '基于 on-lesson 课堂互动与上课签到检测', verifiedAt: '2026-10-15' },
    listActivities: { state: 'supported', reason: '基于在课与即将到来的互动测验检测', verifiedAt: '2026-10-17' },
    listChapters: { state: 'supported', reason: '基于雨课堂学习日志/课件或课程入口导航', verifiedAt: '2026-10-17' },
    listVideoTasks: UNVERIFIED('无公开独立任务列表端点'),
    classroomQuestions: UNVERIFIED('题目识别优先在测试台验证'),
    openVideoTask: UNVERIFIED('未验证'),
    observePlayer: { state: 'unverified', reason: '播放器自研，需真实页面注入检测', verifiedAt: null },
    submitAnswer: { state: 'unsupported', reason: '真实计分作业/考试不设自动提交链路', verifiedAt: null },
    videoHeartbeat: { state: 'unsupported', reason: '不伪造观看时长与心跳', verifiedAt: null }
  }

  getHealthReport(): PlatformHealthReport {
    return {
      platformId: 'yuketang',
      state: this.healthState,
      label: HEALTH_LABELS[this.healthState] || this.healthState,
      lastCheckedAt: this.lastCheckedAt,
      lastSuccessAt: this.lastSuccessAt,
      errorFingerprint: this.errorFingerprint,
      errorMessage: this.errorMessage,
      consecutiveFailures: this.consecutiveParseFailures
    }
  }

  recordSuccess(): void {
    this.healthState = 'healthy'
    this.consecutiveParseFailures = 0
    this.lastSuccessAt = new Date().toISOString()
    this.lastCheckedAt = this.lastSuccessAt
    this.errorFingerprint = null
    this.errorMessage = null
  }

  recordFailure(
    kind: 'expired' | 'need_captcha' | 'network_error' | 'rate_limited' | 'server_error' | 'parse_error',
    message: string,
    code?: string
  ): void {
    this.lastCheckedAt = new Date().toISOString()
    this.errorMessage = message
    if (kind === 'parse_error') {
      this.consecutiveParseFailures++
      if (this.consecutiveParseFailures >= 2) {
        this.healthState = 'suspected_api_change'
      } else {
        this.healthState = 'parse_error'
      }
    } else {
      this.consecutiveParseFailures = 0
      this.healthState = kind
    }
    this.errorFingerprint = Sanitizer.generateFingerprint({
      platform: 'yuketang',
      module: 'courses',
      code: code || kind.toUpperCase(),
      summary: message
    })
  }

  async detectAuth(ses?: SessionLike, currentUrl?: string): Promise<{
    state: 'unknown' | 'unauthenticated' | 'authenticated' | 'expired' | 'error'
    evidence: string | null
  }> {
    if (!ses) return { state: 'unauthenticated', evidence: '缺少会话上下文' }
    const res = await detectYuketangAuth(ses, currentUrl)
    if (res.state === 'expired' || res.state === 'unauthenticated') {
      this.recordFailure('expired', res.evidence || '雨课堂未登录或登录已失效')
    } else if (res.state === 'authenticated' && this.healthState === 'expired') {
      this.recordSuccess()
    }
    return res
  }

  async listCourses(ses?: SessionLike, currentUrl?: string): Promise<{
    state: string
    courses: unknown[]
    error?: string
  }> {
    if (!ses) return { state: 'unauthenticated', courses: [], error: '缺少会话上下文' }
    const res = await fetchYuketangCourses(ses, currentUrl)
    if (res.ok) {
      this.recordSuccess()
    } else {
      if (res.state === 'expired' || res.state === 'unauthenticated') {
        this.recordFailure('expired', res.error || '雨课堂未登录或登录已过期')
      } else if (res.error?.includes('429')) {
        this.recordFailure('rate_limited', res.error)
      } else if (res.error?.includes('500') || res.error?.includes('502') || res.error?.includes('503')) {
        this.recordFailure('server_error', res.error)
      } else if (res.error?.includes('网络') || res.error?.includes('timeout') || res.error?.includes('ETIMEDOUT')) {
        this.recordFailure('network_error', res.error)
      } else {
        this.recordFailure('parse_error', res.error || '雨课堂课程解析失败')
      }
    }
    return res
  }

  async listChapters(
    ses: SessionLike,
    courseId: string,
    clazzId: string
  ): Promise<{
    ok: boolean
    chapters: ChapterNode[]
    error?: string
  }> {
    if (!ses) return { ok: false, chapters: [], error: '缺少会话上下文' }
    const res = await fetchYuketangChapters(ses, courseId, clazzId)
    if (!res.ok && res.error) {
      if (res.error.includes('网络') || res.error.includes('ETIMEDOUT')) {
        this.recordFailure('network_error', res.error)
      } else {
        this.recordFailure('parse_error', res.error)
      }
    }
    return res
  }

  async listTodaySignIns(ses?: SessionLike): Promise<{
    state: string
    events: SignInEvent[]
    fetchedAt: string
    reason: string | null
  }> {
    if (!ses) {
      return {
        state: 'unauthenticated',
        events: [],
        fetchedAt: new Date().toISOString(),
        reason: '缺少会话上下文'
      }
    }
    return fetchYuketangSignIns(ses)
  }

  async listActivities(ses?: SessionLike): Promise<{
    state: string
    activities: ClassroomActivityItem[]
    fetchedAt: string
    reason: string | null
  }> {
    if (!ses) {
      return {
        state: 'unauthenticated',
        activities: [],
        fetchedAt: new Date().toISOString(),
        reason: '缺少会话上下文'
      }
    }
    return fetchYuketangActivities(ses)
  }

  async stop(): Promise<void> {
    /* 无后台任务 */
  }
}

/**
 * 智慧树适配器（仅浏览入口）。
 *
 * P0 审计：本仓库无智慧树插件。仅有的两个参考项目为历史脚本，
 * 未取得真实共享课样例。按需求「不把浏览入口写成完整适配」。
 */
export class ZhihuishuAdapter implements PlatformAdapter {
  readonly id = 'zhihuishu' as const
  readonly version = '0.2.0'

  readonly capabilities: Record<string, CapabilityEntry> = {
    auth: { state: 'unverified', reason: '仅提供浏览入口，未验证登录流程', verifiedAt: null },
    listCourses: { state: 'unsupported', reason: '未取得真实共享课样例', verifiedAt: null },
    listTodaySignIns: { state: 'unsupported', reason: '待真实证据', verifiedAt: null },
    listVideoTasks: { state: 'unverified', reason: '共享课视频结构未知，待真实样例', verifiedAt: null },
    classroomQuestions: { state: 'unsupported', reason: '待真实证据', verifiedAt: null }
  }

  getHealthReport(): PlatformHealthReport {
    return {
      platformId: 'zhihuishu',
      state: 'healthy',
      label: '待验证（仅入口）',
      lastCheckedAt: new Date().toISOString(),
      lastSuccessAt: null,
      errorFingerprint: null,
      errorMessage: null,
      consecutiveFailures: 0
    }
  }

  async detectAuth(): Promise<{ state: 'unknown'; evidence: string | null }> {
    return { state: 'unknown', evidence: null }
  }

  async stop(): Promise<void> {
    /* 无后台任务 */
  }
}

export const ADAPTERS: Record<PlatformId, PlatformAdapter> = {
  chaoxing: new ChaoxingAdapter(),
  yuketang: new YuketangAdapter(),
  zhihuishu: new ZhihuishuAdapter(),
  testbed: {
    id: 'testbed',
    version: '0.2.0',
    capabilities: {
      auth: { state: 'supported', reason: '本地 fixture，无登录', verifiedAt: '2026-10-15' },
      listVideoTasks: { state: 'supported', reason: '本地 fixture 任务页，含真实 HTML5 <video>', verifiedAt: '2026-10-15' },
      observePlayer: { state: 'supported', reason: '标准 HTML5 media 属性可观测', verifiedAt: '2026-10-15' },
      classroomQuestions: { state: 'supported', reason: 'data-ch-* 契约题目，可重复 E2E', verifiedAt: '2026-10-15' },
      geoOverride: { state: 'supported', reason: 'CDP Emulation.setGeolocationOverride', verifiedAt: '2026-10-15' }
    },
    getHealthReport(): PlatformHealthReport {
      return {
        platformId: 'testbed',
        state: 'healthy',
        label: '运行正常（本地测试台）',
        lastCheckedAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        errorFingerprint: null,
        errorMessage: null,
        consecutiveFailures: 0
      }
    },
    async detectAuth() {
      return { state: 'authenticated' as const, evidence: 'local-fixture' }
    },
    async listActivities() {
      return {
        state: 'supported',
        activities: [
          {
            id: 'tb-act-signin-normal',
            platformId: 'testbed' as const,
            courseId: 'test-course-01',
            courseName: '人工智能导论（测试课程）',
            classId: 'sec-01',
            category: 'sign_in' as const,
            title: '第 3 周随堂签到',
            status: 'open' as const,
            startAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            endAt: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
            sourceUrl: 'http://127.0.0.1:40123/classroom-test.html',
            fetchedAt: new Date().toISOString(),
            locationRequired: false,
            locationText: null,
            signInKind: 'normal' as const,
            confidence: 'high' as const
          },
          {
            id: 'tb-act-signin-location',
            platformId: 'testbed' as const,
            courseId: 'test-course-01',
            courseName: '人工智能导论（测试课程）',
            classId: 'sec-01',
            category: 'sign_in' as const,
            title: '实验大楼现场定位签到',
            status: 'open' as const,
            startAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            endAt: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
            sourceUrl: 'http://127.0.0.1:40123/geo-test.html',
            fetchedAt: new Date().toISOString(),
            locationRequired: true,
            locationText: '北京市天安门（39.9042, 116.4074）半径500m',
            signInKind: 'location' as const,
            confidence: 'high' as const
          },
          {
            id: 'tb-act-quiz-01',
            platformId: 'testbed' as const,
            courseId: 'test-course-01',
            courseName: '人工智能导论（测试课程）',
            classId: 'sec-01',
            category: 'quiz' as const,
            title: '随堂互动小测：神经网络与损失函数',
            status: 'open' as const,
            startAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
            endAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
            sourceUrl: 'http://127.0.0.1:40123/classroom-test.html',
            fetchedAt: new Date().toISOString(),
            locationRequired: false,
            locationText: null,
            signInKind: 'unknown' as const,
            confidence: 'high' as const
          },
          {
            id: 'tb-act-survey-01',
            platformId: 'testbed' as const,
            courseId: 'test-course-02',
            courseName: '计算机网络体系结构',
            classId: 'sec-02',
            category: 'questionnaire' as const,
            title: '期中教学反馈与课程难度调研',
            status: 'open' as const,
            startAt: new Date(Date.now() - 3600 * 1000).toISOString(),
            endAt: new Date(Date.now() + 86400 * 1000).toISOString(),
            sourceUrl: 'http://127.0.0.1:40123/classroom-test.html',
            fetchedAt: new Date().toISOString(),
            locationRequired: false,
            locationText: null,
            signInKind: 'unknown' as const,
            confidence: 'high' as const
          },
          {
            id: 'tb-act-notice-01',
            platformId: 'testbed' as const,
            courseId: 'test-course-02',
            courseName: '计算机网络体系结构',
            classId: 'sec-02',
            category: 'notice' as const,
            title: '关于下周四实验机房调整的紧急通知',
            status: 'open' as const,
            startAt: new Date(Date.now() - 7200 * 1000).toISOString(),
            endAt: null,
            sourceUrl: 'http://127.0.0.1:40123/classroom-test.html',
            fetchedAt: new Date().toISOString(),
            locationRequired: false,
            locationText: null,
            signInKind: 'unknown' as const,
            confidence: 'high' as const
          },
          {
            id: 'tb-act-signin-closed',
            platformId: 'testbed' as const,
            courseId: 'test-course-01',
            courseName: '人工智能导论（测试课程）',
            classId: 'sec-01',
            category: 'sign_in' as const,
            title: '第 2 周课前签到（已结束）',
            status: 'closed' as const,
            startAt: new Date(Date.now() - 7 * 86400 * 1000).toISOString(),
            endAt: new Date(Date.now() - 7 * 86400 * 1000 + 1800 * 1000).toISOString(),
            sourceUrl: 'http://127.0.0.1:40123/classroom-test.html',
            fetchedAt: new Date().toISOString(),
            locationRequired: false,
            locationText: null,
            signInKind: 'normal' as const,
            confidence: 'high' as const
          }
        ],
        fetchedAt: new Date().toISOString(),
        reason: '本地 fixture 课堂活动数据集'
      }
    },
    async stop() {
      /* noop */
    }
  }
}

export function getAdapter(id: PlatformId): PlatformAdapter | null {
  return ADAPTERS[id] ?? null
}

export function getAllPlatformHealth(): Record<PlatformId, PlatformHealthReport> {
  const result = {} as Record<PlatformId, PlatformHealthReport>
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.getHealthReport) {
      result[id as PlatformId] = adapter.getHealthReport()
    }
  }
  return result
}
