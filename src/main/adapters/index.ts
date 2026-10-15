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
 * - 学习通：src/ 无视频任务、无题目提取；签到只有检测，自动提交签到属违规写操作，不迁入。
 * - 雨课堂：题目提取依赖 presentation/fetch 载荷字段，全部为反推未经抓包验证；
 *   自动提交答案/自动签到/伪造观看心跳均不迁入。
 * - 智慧树：仅有历史参考脚本，无真实样例，仅提供浏览入口。
 *
 * 因此本次交付中所有平台适配器一律标记 unverified —— 这是事实，不是缺陷。
 */

import type { PlatformId, CapabilityState } from '@shared/types'

export interface CapabilityEntry {
  state: CapabilityState
  reason: string
  verifiedAt: string | null
}

export interface PlatformAdapter {
  readonly id: PlatformId
  readonly version: string
  readonly capabilities: Record<string, CapabilityEntry>
  detectAuth(signal: AbortSignal): Promise<{ state: 'unknown' | 'authenticated' | 'expired' | 'error'; evidence: string | null }>
  stop(): Promise<void>
}

const UNVERIFIED = (reason: string): CapabilityEntry => ({
  state: 'unverified',
  reason,
  verifiedAt: null
})

/**
 * 学习通适配器（骨架）。
 *
 * 只读端点来自 P0 审计到的源码：
 * - 课程列表 mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1
 * - 活动列表 mobilelearn.chaoxing.com/v2/apis/active/student/activelist
 * - 活动详情 mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo
 *
 * 全部标记 unverified：审计确认这些端点在真实账号上从未实测，
 * 字段映射亦为跨仓库推断。签到提交（stuSignajax）**故意不实现**。
 */
export class ChaoxingAdapter implements PlatformAdapter {
  readonly id = 'chaoxing' as const
  readonly version = '0.2.0'

  readonly capabilities: Record<string, CapabilityEntry> = {
    auth: UNVERIFIED('依赖浏览器登录 Cookie；未在真实账号验证'),
    listCourses: UNVERIFIED('端点 backclazzdata 来自插件源码，未经真实响应校准'),
    listTodaySignIns: UNVERIFIED('端点 activelist 字段映射为跨仓库推断，未实测'),
    listVideoTasks: { state: 'unsupported', reason: 'P0 审计：学习通插件 src/ 中不存在视频任务实现', verifiedAt: null },
    classroomQuestions: { state: 'unsupported', reason: 'P0 审计：插件 src/ 中不存在题目提取实现', verifiedAt: null },
    openVideoTask: { state: 'unsupported', reason: '同上', verifiedAt: null },
    observePlayer: { state: 'unsupported', reason: '同上', verifiedAt: null },
    submitSignIn: { state: 'unsupported', reason: '自动提交签到属违规写操作，按需求明确不实现', verifiedAt: null }
  }

  async detectAuth(): Promise<{ state: 'unknown'; evidence: string | null }> {
    return { state: 'unknown', evidence: null }
  }

  async stop(): Promise<void> {
    /* 无后台任务 */
  }
}

/**
 * 雨课堂适配器（骨架）。
 *
 * 只读端点来自 P0 审计：
 * - 在课检测 /api/v3/classroom/on-lesson-upcoming-exam
 * - 签到 /api/v3/lesson/checkin（**不实现提交**）
 * - 答案提交 /api/v3/lesson/problem/answer（**不实现**）
 * - 视频心跳 /video-log/heartbeat/（**不实现**）
 *
 * P0 审计发现原插件存在无人值守提交链路（autonomyLevel=auto 或
 * 距截止 ≤25 秒 + autoSubmitTimed），以及 isExam 硬规则在答题链路上不可达。
 * 这些一律不迁入。
 */
export class YuketangAdapter implements PlatformAdapter {
  readonly id = 'yuketang' as const
  readonly version = '0.2.0'

  readonly capabilities: Record<string, CapabilityEntry> = {
    auth: UNVERIFIED('Cookie + Set-Auth Bearer 三重捕获机制未在真实页面验证'),
    listCourses: UNVERIFIED('端点 /v2/api/web/courses/list 曾返回 HTTP 500，无成功响应样本'),
    listTodaySignIns: UNVERIFIED('签到=进入课堂；无独立签到检测接口'),
    listVideoTasks: UNVERIFIED('仅能从 presentation 载荷 shapes[].playurl 提取，无任务列表端点'),
    classroomQuestions: UNVERIFIED('字段 body/options/blanks 全部为反推，未抓包验证'),
    openVideoTask: UNVERIFIED('未验证'),
    observePlayer: { state: 'unverified', reason: '雨课堂播放器为自研，未验证是否暴露 HTML5 video', verifiedAt: null },
    submitAnswer: { state: 'unsupported', reason: '真实计分作业/考试不设无人值守提交链路', verifiedAt: null },
    videoHeartbeat: { state: 'unsupported', reason: '不伪造观看时长与心跳', verifiedAt: null }
  }

  async detectAuth(): Promise<{ state: 'unknown'; evidence: string | null }> {
    return { state: 'unknown', evidence: null }
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
    async detectAuth() {
      return { state: 'authenticated' as const, evidence: 'local-fixture' }
    },
    async stop() {
      /* noop */
    }
  }
}

export function getAdapter(id: PlatformId): PlatformAdapter | null {
  return ADAPTERS[id] ?? null
}
