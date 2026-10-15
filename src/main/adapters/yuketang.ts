/**
 * 雨课堂适配器请求构建与响应解析。
 *
 * 源码证据：
 * - 课程列表与在课状态端点：`yuketang_plugin/src/shared/constants.js:7-20`
 * - API 响应格式及错误处理：`yuketang_plugin/src/background/api-client.js:30-67`
 * - WebSocket 操作码协议：`yuketang_plugin/src/shared/constants.js:23-39`
 */

export interface YuketangCourse {
  classroomCourseId: string
  courseName: string
  teacherName: string
  coverUrl: string | null
}

export interface YuketangOnLessonStatus {
  onLesson: boolean
  lessonId: string | null
  classroomId: string | null
  courseName: string | null
  rawStatus?: unknown
}

export const YUKETANG_ENDPOINTS = {
  courseList: 'https://www.yuketang.cn/v2/api/web/courses/list?identity=2',
  onLesson: 'https://www.yuketang.cn/api/v3/classroom/on-lesson-upcoming-exam'
}

export const KNOWN_WS_OPS = new Set([
  'hello',
  'unlockproblem',
  'extendtime',
  'callpaused',
  'lessonfinished',
  'fetchtimeline',
  'showpresentation',
  'presentationcreated',
  'slidenav',
  'probleminfo',
  'problemfinished'
])

export function buildYktCourseListRequest(): { url: string; method: string } {
  return {
    url: YUKETANG_ENDPOINTS.courseList,
    method: 'GET'
  }
}

export function parseYktCourseListResponse(raw: unknown): {
  ok: boolean
  courses: YuketangCourse[]
  error?: string
} {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, courses: [], error: 'INVALID_JSON: 响应不是对象' }
  }
  const record = raw as Record<string, unknown>
  const code = typeof record.code === 'number' ? record.code : null
  if (code !== 0 && code !== null) {
    const msg = typeof record.msg === 'string' ? record.msg : `错误码 ${code}`
    return { ok: false, courses: [], error: `API_ERROR: ${msg}` }
  }

  const data = record.data as Record<string, unknown> | undefined
  const list = Array.isArray(data?.courses) ? (data!.courses as unknown[]) : []

  const courses: YuketangCourse[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const id = String(c.classroom_id ?? c.id ?? '')
    if (!id) continue
    courses.push({
      classroomCourseId: id,
      courseName: String(c.course_name ?? c.name ?? `未命名课程 ${id}`),
      teacherName: String(c.teacher_name ?? c.teacher ?? ''),
      coverUrl: typeof c.cover === 'string' ? c.cover : null
    })
  }

  return { ok: true, courses }
}

export function buildOnLessonRequest(): { url: string; method: string } {
  return {
    url: YUKETANG_ENDPOINTS.onLesson,
    method: 'GET'
  }
}

export function parseOnLessonResponse(raw: unknown): {
  ok: boolean
  status: YuketangOnLessonStatus
  error?: string
} {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      status: { onLesson: false, lessonId: null, classroomId: null, courseName: null },
      error: 'INVALID_JSON: 响应不是对象'
    }
  }

  const record = raw as Record<string, unknown>
  const data = (record.data ?? record) as Record<string, unknown>

  // 雨课堂在课通常返回 on_lesson 为 true，或存在当前 lesson 信息
  const onLesson = Boolean(data.on_lesson ?? data.onLesson ?? (data.lesson_id != null && data.lesson_id !== 0))
  const lessonId = data.lesson_id != null ? String(data.lesson_id) : null
  const classroomId = data.classroom_id != null ? String(data.classroom_id) : null
  const courseName = typeof data.course_name === 'string' ? data.course_name : null

  return {
    ok: true,
    status: {
      onLesson,
      lessonId,
      classroomId,
      courseName,
      rawStatus: data
    }
  }
}

export interface WsAppMessage {
  op: string
  data: unknown
  isKnown: boolean
}

/**
 * 解析雨课堂 WebSocket /wsapp/ 文本消息。
 * 格式通常为 JSON 包含 op 字段与数据载荷。
 */
export function parseWsAppMessage(rawText: string): WsAppMessage | null {
  if (!rawText || typeof rawText !== 'string') return null
  try {
    const json = JSON.parse(rawText) as Record<string, unknown>
    if (!json || typeof json !== 'object') return null
    const op = typeof json.op === 'string' ? json.op.toLowerCase() : 'unknown'
    return {
      op,
      data: json.data ?? json,
      isKnown: KNOWN_WS_OPS.has(op)
    }
  } catch {
    return null
  }
}

import type { SignInEvent } from '@shared/types'
import type { SessionLike } from './chaoxing'

/** 探测雨课堂 Session 登录状态 */
export async function detectYuketangAuth(ses: SessionLike): Promise<{
  state: 'unauthenticated' | 'authenticated' | 'expired' | 'error'
  evidence: string | null
}> {
  try {
    const cookies = await ses.cookies.get({ domain: 'yuketang.cn' }).catch(() => [])
    const proCookies = await ses.cookies.get({ domain: 'pro.yuketang.cn' }).catch(() => [])
    const all = [...cookies, ...proCookies]
    const hasAuthCookie = all.some((c) =>
      ['sessionid', 'csrftoken', 'login_user_id', 'uvbe', 'auth'].some((k) =>
        c.name.toLowerCase().includes(k.toLowerCase())
      )
    )
    if (!hasAuthCookie && all.length === 0) {
      return { state: 'unauthenticated', evidence: '未在内置浏览器中检测到雨课堂登录 Cookie' }
    }

    const req = buildOnLessonRequest()
    const resp = await ses.fetch(req.url, { method: req.method })
    if (resp.status === 401 || resp.status === 403) {
      return { state: 'expired', evidence: '雨课堂登录凭证已失效（HTTP 401/403）' }
    }
    const json = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    if (json && typeof json === 'object') {
      if (json.code === 0) {
        return { state: 'authenticated', evidence: '雨课堂登录会话有效' }
      }
      if (json.code === 401 || json.code === 403) {
        return { state: 'expired', evidence: '雨课堂会话已超时，请重新登录' }
      }
    }
    return { state: 'unauthenticated', evidence: '无法验证雨课堂身份状态' }
  } catch (e) {
    return { state: 'error', evidence: e instanceof Error ? e.message : String(e) }
  }
}

/** 通过 Session 拉取雨课堂课程列表 */
export async function fetchYuketangCourses(ses: SessionLike): Promise<{
  ok: boolean
  state: 'supported' | 'unauthenticated' | 'expired' | 'error'
  courses: YuketangCourse[]
  error?: string
}> {
  const auth = await detectYuketangAuth(ses)
  if (auth.state !== 'authenticated') {
    return { ok: false, state: auth.state, courses: [], error: auth.evidence ?? '未登录' }
  }

  const req = buildYktCourseListRequest()
  const resp = await ses.fetch(req.url, { method: req.method })
  const json = (await resp.json().catch(() => null)) as unknown
  const parsed = parseYktCourseListResponse(json)
  return {
    ok: parsed.ok,
    state: parsed.ok ? 'supported' : 'error',
    courses: parsed.courses,
    error: parsed.error
  }
}

/** 通过 Session 拉取雨课堂正在进行的课堂（课堂进入签到） */
export async function fetchYuketangSignIns(ses: SessionLike): Promise<{
  state: 'supported' | 'unauthenticated' | 'expired' | 'unverified' | 'error'
  events: SignInEvent[]
  fetchedAt: string
  reason: string | null
}> {
  const auth = await detectYuketangAuth(ses)
  if (auth.state === 'unauthenticated') {
    return {
      state: 'unauthenticated',
      events: [],
      fetchedAt: new Date().toISOString(),
      reason: '未登录雨课堂账号，请在平台浏览器完成手动登录'
    }
  }
  if (auth.state === 'expired') {
    return {
      state: 'expired',
      events: [],
      fetchedAt: new Date().toISOString(),
      reason: '雨课堂登录已过期，请重新登录'
    }
  }
  if (auth.state === 'error') {
    return {
      state: 'error',
      events: [],
      fetchedAt: new Date().toISOString(),
      reason: auth.evidence ?? '网络异常'
    }
  }

  const req = buildOnLessonRequest()
  const resp = await ses.fetch(req.url, { method: req.method })
  const json = (await resp.json().catch(() => null)) as unknown
  const onLesson = parseOnLessonResponse(json)

  const events: SignInEvent[] = []
  if (onLesson.ok && onLesson.status.onLesson && onLesson.status.lessonId) {
    events.push({
      id: `ykt-${onLesson.status.lessonId}`,
      platformId: 'yuketang',
      courseId: onLesson.status.classroomId || '',
      kind: 'normal',
      title: `${onLesson.status.courseName || '课堂互动'} · 正在上课（进入课堂签到）`,
      startAt: new Date().toISOString(),
      endAt: null,
      sourceUrl: `https://www.yuketang.cn/v2/web/studentlog/${onLesson.status.lessonId}`,
      fetchedAt: new Date().toISOString(),
      status: 'open',
      statusSource: 'provider_api',
      locationText: null,
      locationRequired: false
    })
  }

  return {
    state: 'supported',
    events,
    fetchedAt: new Date().toISOString(),
    reason: events.length === 0 ? '当前无正在进行的课堂' : null
  }
}

