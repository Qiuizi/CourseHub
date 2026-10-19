/**
 * CourseHub 用户反馈、诊断与平台健康模型定义。
 *
 * 契约规范：
 * - 面向真实 C 端用户，错误类别使用直观自然语言，不出现深奥的技术堆栈术语。
 * - 平台健康状态严格细分，杜绝将验证码和会话过期误报为接口改版。
 */

import type { PlatformId } from './types'

/** 8 种用户反馈分类 */
export type FeedbackCategory =
  | 'login'               // 登录问题
  | 'course_sync'         // 课程同步
  | 'courseware_video'    // 课件与视频
  | 'activity_signin'     // 课堂活动或签到提醒
  | 'ai_assistant'        // AI 助教
  | 'crash_lag'           // 软件闪退或卡顿
  | 'ui_display'          // 界面显示问题
  | 'suggestion_other'    // 功能建议与其他

export const FEEDBACK_CATEGORIES: { id: FeedbackCategory; label: string; icon: string; desc: string }[] = [
  { id: 'login', label: '登录问题', icon: 'KeyRound', desc: '账号登录失败、二维码未刷新或频繁掉登录' },
  { id: 'course_sync', label: '课程同步', icon: 'FolderSync', desc: '课程列表加载失败、课程缺失或学期分类错误' },
  { id: 'courseware_video', label: '课件与视频', icon: 'PlaySquare', desc: '视频无法连播、课件打不开或播放进度未更新' },
  { id: 'activity_signin', label: '课堂活动或签到提醒', icon: 'BellRing', desc: '签到活动未收到提醒、位置打卡异常或测验未同步' },
  { id: 'ai_assistant', label: 'AI 助教', icon: 'Sparkles', desc: '题目识别不准、模型响应缓慢或 API Key 报错' },
  { id: 'crash_lag', label: '软件闪退或卡顿', icon: 'ZapOff', desc: '界面假死无响应、页面突然白屏或内存占用异常' },
  { id: 'ui_display', label: '界面显示问题', icon: 'Layout', desc: '排版错位、暗黑模式异常或字体图标显示不全' },
  { id: 'suggestion_other', label: '功能建议与其他', icon: 'MessageSquarePlus', desc: '改进建议、新功能诉求或其他未归类问题' }
]

/** 平台结构化健康状态（8 态精确分类） */
export type PlatformHealthState =
  | 'healthy'               // 一切正常
  | 'expired'               // 会话或登录已失效
  | 'need_captcha'          // 触发平台安全验证码阻断
  | 'network_error'         // 网络异常、超时或无法连接
  | 'rate_limited'          // 触发平台请求频次限制 (HTTP 429)
  | 'server_error'          // 平台服务端故障 (HTTP 5xx)
  | 'parse_error'           // 接口响应成功但字段/DOM解析失败
  | 'suspected_api_change'  // 连续多次结构解析失败，高度怀疑接口改版

export interface PlatformHealthReport {
  platformId: PlatformId
  state: PlatformHealthDetailedState
  label: string
  lastCheckedAt: string
  lastSuccessAt: string | null
  errorFingerprint: string | null
  errorMessage: string | null
  consecutiveFailures: number
}

export type PlatformHealthDetailedState = PlatformHealthState

/** 结构化诊断事件 */
export interface DiagnosticEvent {
  ts: string
  module: 'chaoxing' | 'yuketang' | 'renderer' | 'main' | 'video' | 'ai' | 'geo' | 'classroom' | 'system' | 'updater'
  platform?: PlatformId
  level: 'info' | 'warn' | 'error'
  type: string
  code: string
  summary: string
  fingerprint: string
  data?: Record<string, unknown>
  stack?: string
}

/** 诊断包清单信息 */
export interface DiagnosticManifest {
  app: {
    name: string
    version: string
    buildCommit: string
    environment: string
  }
  system: {
    platform: string
    osRelease: string
    arch: string
    electronVersion: string
    chromeVersion: string
    nodeVersion: string
  }
  runtime: {
    generatedAt: string
    timeZone: string
    activePlatform: PlatformId
    platformsHealth: Record<PlatformId, PlatformHealthReport>
  }
  privacyNotice: string
}

/** 完整脱敏诊断包内存载荷 */
export interface DiagnosticPackageData {
  manifest: DiagnosticManifest
  recentErrors: DiagnosticEvent[]
  summaryText: string
}

/** 用户提交反馈载荷 */
export interface FeedbackSubmissionPayload {
  clientFeedbackId?: string
  category: FeedbackCategory
  description: string
  reproductionSteps?: string
  contact?: string
  attachDiagnostics: boolean
  screenshotBase64?: string
  diagnosticData?: DiagnosticPackageData
}

/** 在线反馈失败具体类别 */
export type FeedbackFailureCategory =
  | 'network_error'
  | 'timeout'
  | 'unauthorized'
  | 'rate_limited'
  | 'server_error'
  | 'invalid_response'

/** 反馈处理返回状态 */
export interface FeedbackSubmissionResult {
  success: boolean
  feedbackId: string
  createdAt: string
  message: string
  offlineFallback?: boolean
  diagnosticZipPath?: string
  issueNumber?: number
  failureCategory?: FeedbackFailureCategory
  httpStatus?: number
  durationMs?: number
  errorCode?: string
  idempotent?: boolean
}

