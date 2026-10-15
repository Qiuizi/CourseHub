/**
 * CourseHub 共享类型合同。
 *
 * 设计原则（来自开发文档 §1、§6、§9）：
 * 1. 「检测到活动」≠「已完成签到」；「播放器结束」≠「平台记完成」；「模型给答案」≠「页面已填」。
 *    因此播放器观测与平台任务状态必须是两个独立字段，不允许互相推导。
 * 2. 未知值一律为 null，禁止用 0 / 空串 / 推算值冒充。
 * 3. 时间统一 ISO UTC 存储，显示层再转本地时区。
 */

export type PlatformId = 'chaoxing' | 'yuketang' | 'zhihuishu' | 'testbed'

export type CapabilityState = 'supported' | 'partial' | 'unsupported' | 'unverified'

export type AuthState = 'unknown' | 'checking' | 'authenticated' | 'expired' | 'error'

/** 数据加载状态机：idle -> checking -> ready/empty/stale/error/unsupported */
export type LoadState = 'initial' | 'loading' | 'ready' | 'empty' | 'stale' | 'error' | 'unsupported'

export type ClassroomEventKind = 'sign_in' | 'quiz' | 'lesson' | 'unknown'

export type PlayerState = 'unknown' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'

/** 平台官方任务状态。与 PlayerState 严格独立。 */
export type ProviderTaskState = 'unknown' | 'not_started' | 'in_progress' | 'completed'

export type SignInKind = 'normal' | 'location' | 'qr' | 'code' | 'other' | 'unknown'

export type SignInStatus = 'pending' | 'open' | 'checked_in' | 'closed' | 'unknown' | 'error'

export type SignInStatusSource =
  | 'provider_api'
  | 'local_dedupe'
  | 'user_confirmed'
  | 'inferred'
  | 'none'

export interface AuthSnapshot {
  state: AuthState
  /** 平台原始返回中能证明登录的字段摘要；无证据则为 null */
  evidence: string | null
  checkedAt: string
}

export interface Course {
  id: string
  platformId: PlatformId
  name: string
  sourceUrl: string | null
  fetchedAt: string
}

export interface SignInEvent {
  id: string
  platformId: PlatformId
  courseId: string | null
  kind: SignInKind
  title: string
  startAt: string | null
  endAt: string | null
  sourceUrl: string | null
  fetchedAt: string
  status: SignInStatus
  /**
   * status 的来源。local_dedupe 表示「仅本地记忆认为已签到」，
   * 不能与 provider_api（平台明确确认）混为一谈。
   */
  statusSource: SignInStatusSource
  locationText: string | null
  /** 平台确实提供位置要求时才填写 */
  locationRequired: boolean
}

export interface VideoTask {
  id: string
  platformId: PlatformId
  courseId: string
  sectionId: string | null
  title: string
  sourceUrl: string
  order: number | null
  durationSeconds: number | null
  fetchedAt: string
  /** 平台官方状态。播放器 ended 不得写入此字段。 */
  platformStatus: ProviderTaskState
  platformStatusCheckedAt: string | null
  supportedControls: readonly PlaybackControl[]
}

export type PlaybackControl = 'play' | 'pause' | 'volume' | 'rate' | 'next' | 'prev'

export interface PlaybackObservation {
  taskId: string
  playerState: PlayerState
  currentTimeSeconds: number | null
  durationSeconds: number | null
  playbackRate: number | null
  volume: number | null
  muted: boolean | null
  observedAt: string
  /** observation 的真实来源，例如 'html5-video' | 'unknown' */
  origin: string
}

export interface ClassroomEvent {
  id: string
  platformId: PlatformId
  courseId: string | null
  kind: ClassroomEventKind
  title: string
  sourceUrl: string | null
  startAt: string | null
  endAt: string | null
  fetchedAt: string
  rawStatus: string | null
  normalizedStatus: string
  confidence: 'high' | 'medium' | 'low'
  capabilityState: CapabilityState
}

export interface Reminder {
  id: string
  sourceEventId: string
  scheduledAt: string | null
  notifiedAt: string | null
  dedupeKey: string
}

export interface PlatformHealth {
  platformId: PlatformId
  authState: AuthState
  capabilityState: CapabilityState
  syncState: LoadState
  lastSuccessAt: string | null
  lastError: string | null
}

/* ------------------------------ 定位模拟测试 ------------------------------ */

export type GeoCoordinateSystem = 'wgs84' | 'gcj02'

export interface GeoTarget {
  /** 必须是 file:// 下的 fixture，或配置中登记的自有授权 origin */
  origin: string
  label: string
}

export interface GeoTestConfig {
  latitude: number
  longitude: number
  accuracyMeters: number
  coordinateSystem: GeoCoordinateSystem
  targetOrigin: string
}

export type GeoRunStatus = 'idle' | 'preparing' | 'active' | 'clearing' | 'cleared' | 'failed'

export interface GeoTestRun {
  id: string
  targetOrigin: string
  latitude: number
  longitude: number
  accuracyMeters: number
  appliedAt: string | null
  clearedAt: string | null
  /** 从测试页 navigator.geolocation 实读回来的值；未读到为 null */
  observedLocation: { latitude: number; longitude: number; accuracy: number } | null
  status: GeoRunStatus
  error: string | null
}

/* --------------------------------- DeepSeek -------------------------------- */

export type AIModelModality = 'text' | 'image'

export interface AIModelInfo {
  id: string
  displayName: string | null
  contextWindow: number | null
  maxOutputTokens: number | null
  inputModalities: readonly AIModelModality[]
  /** 来自 /models 的原始记录，便于排障 */
  raw: unknown
}

export type AIRequestStatus =
  | 'idle'
  | 'preparing'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AIResult {
  explanation: string
  suggestedAnswer: string | null
  optionsMapping: Record<string, string> | null
  uncertainty: string | null
  model: string
  contextSource: 'text' | 'screenshot' | 'text+screenshot'
  usage: { promptTokens: number | null; completionTokens: number | null } | null
}

export interface AIRequestState {
  id: string
  model: string
  sourceKind: 'text' | 'screenshot' | 'text+screenshot'
  status: AIRequestStatus
  startedAt: string
  endedAt: string | null
  error: string | null
}

/* -------------------------------- 课堂题目 -------------------------------- */

export type QuestionType = 'single' | 'multiple' | 'judgement' | 'text' | 'unknown'

export interface QuestionOption {
  key: string
  label: string
}

export interface ClassroomQuestion {
  id: string
  platformId: PlatformId | null
  sourceUrl: string | null
  questionType: QuestionType
  extractedText: string | null
  options: readonly QuestionOption[]
  /** 仅在平台确实提供可靠结束时间时填写 */
  endsAt: string | null
  detectedAt: string
  source: 'dom' | 'intercepted_payload' | 'screenshot' | 'unknown'
}

/**
 * 受限测试动作。模型不能直接执行；只能提出意图，
 * 由本地执行层在隔离测试页上做白名单操作，且写操作需用户确认。
 */
export type TestActionKind = 'locate_question' | 'preview_fill' | 'execute_fill'

export interface TestActionPlan {
  kind: TestActionKind
  targetQuestionId: string
  /** 仅限白名单题型；不允许任意 JS */
  optionKeys: readonly string[]
  textValue: string | null
  /** 最大操作数硬上限 */
  maxOps: number
}

export interface TestActionPreview {
  plan: TestActionPlan
  matchedSelectorCount: number
  previewText: string
  requiresConfirmation: boolean
  executed: boolean
  error: string | null
}

/* --------------------------------- IPC 合同 -------------------------------- */

export type ErrorCode =
  | 'AUTH_EXPIRED'
  | 'NETWORK_TIMEOUT'
  | 'RATE_LIMITED'
  | 'ADAPTER_SCHEMA_CHANGED'
  | 'UNSUPPORTED'
  | 'DATA_STALE'
  | 'PLAYER_UNAVAILABLE'
  | 'MEDIA_RESTRICTED'
  | 'VIDEO_STATUS_UNKNOWN'
  | 'GEO_PERMISSION_DENIED'
  | 'GEO_OVERRIDE_FAILED'
  | 'AI_KEY_INVALID'
  | 'AI_QUOTA_EXCEEDED'
  | 'ENCRYPTION_UNAVAILABLE'
  | 'STORAGE_WRITE_FAILED'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string; retryable: boolean } }

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
