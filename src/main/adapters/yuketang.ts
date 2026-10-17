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
  // 统一平台适配字段
  courseId: string
  classId: string
  name: string
  courseUrl: string
  platformId: 'yuketang'
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

export function buildYktCourseListRequest(baseUrl = 'https://www.yuketang.cn'): { url: string; method: string } {
  const cleanBase = baseUrl.replace(/\/+$/, '')
  return {
    url: `${cleanBase}/v2/api/web/courses/list?identity=2`,
    method: 'GET'
  }
}

export function parseYktCourseListResponse(raw: unknown, baseUrl = 'https://www.yuketang.cn'): {
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
    const name = String(c.course_name ?? c.name ?? `未命名课程 ${id}`)
    const teacherName = String(c.teacher_name ?? c.teacher ?? '')
    const coverUrl = typeof c.cover === 'string' ? c.cover : null
    const courseId = String(c.course_id ?? c.courseId ?? id)
    const classId = String(c.classroom_id ?? id)
    const cleanBase = baseUrl.replace(/\/+$/, '')
    const courseUrl = `${cleanBase}/v2/web/studentlog/${classId}`

    courses.push({
      classroomCourseId: id,
      courseName: name,
      teacherName,
      coverUrl,
      courseId,
      classId,
      name,
      courseUrl,
      platformId: 'yuketang'
    })
  }

  return { ok: true, courses }
}

export function buildOnLessonRequest(baseUrl = 'https://www.yuketang.cn'): { url: string; method: string } {
  const cleanBase = baseUrl.replace(/\/+$/, '')
  return {
    url: `${cleanBase}/api/v3/classroom/on-lesson-upcoming-exam`,
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

import type { SignInEvent, ClassroomActivityItem, ChapterNode } from '@shared/types'
import type { SessionLike } from './chaoxing'

/** 探测雨课堂 Session 登录状态，支持通用版及各高校专有独立版（荷塘、长江、黄河等） */
export async function detectYuketangAuth(ses: SessionLike): Promise<{
  state: 'unauthenticated' | 'authenticated' | 'expired' | 'error'
  evidence: string | null
  serverBaseUrl?: string
}> {
  try {
    const domainCandidates: Array<{ domain: string; base: string }> = [
      { domain: 'pro.yuketang.cn', base: 'https://pro.yuketang.cn' },
      { domain: 'changjiang.yuketang.cn', base: 'https://changjiang.yuketang.cn' },
      { domain: 'huanghe.yuketang.cn', base: 'https://huanghe.yuketang.cn' },
      { domain: 'yuketang.cn', base: 'https://www.yuketang.cn' }
    ]

    let detectedBaseUrl = 'https://www.yuketang.cn'
    let hasAuthCookie = false

    for (const item of domainCandidates) {
      const cookies = await ses.cookies.get({ domain: item.domain }).catch(() => [])
      const matched = cookies.some((c) =>
        ['sessionid', 'login_user_id', 'uvbe'].some((k) =>
          c.name.toLowerCase() === k.toLowerCase() || c.name.toLowerCase().includes(k.toLowerCase())
        )
      )
      if (matched) {
        hasAuthCookie = true
        detectedBaseUrl = item.base
        break
      }
    }

    if (!hasAuthCookie) {
      return {
        state: 'unauthenticated',
        evidence: '未在内置浏览器中检测到雨课堂登录会话（sessionid）',
        serverBaseUrl: detectedBaseUrl
      }
    }

    const courseReq = buildYktCourseListRequest(detectedBaseUrl)
    const resp = await ses.fetch(courseReq.url, { method: courseReq.method })
    if (resp.status === 401 || resp.status === 403) {
      return {
        state: 'expired',
        evidence: '雨课堂登录凭证已失效（HTTP 401/403）',
        serverBaseUrl: detectedBaseUrl
      }
    }
    const json = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    if (json && typeof json === 'object') {
      const code = typeof json.code === 'number' ? json.code : null
      const errcode = typeof json.errcode === 'number' ? json.errcode : null
      if (code === 0 || errcode === 0) {
        return {
          state: 'authenticated',
          evidence: '雨课堂登录会话有效',
          serverBaseUrl: detectedBaseUrl
        }
      }
      if (errcode === 401002 || code === 401 || code === 403 || code === 50000 || json.msg === 'UNAUTHENTICATED') {
        return {
          state: 'expired',
          evidence: '雨课堂会话已超时或未登录，请在内置浏览器登录',
          serverBaseUrl: detectedBaseUrl
        }
      }
    }
    return {
      state: 'unauthenticated',
      evidence: '无法验证雨课堂身份状态',
      serverBaseUrl: detectedBaseUrl
    }
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
    return { ok: false, state: auth.state, courses: [], error: auth.evidence ?? '未登录雨课堂' }
  }

  const baseUrl = auth.serverBaseUrl || 'https://www.yuketang.cn'
  const req = buildYktCourseListRequest(baseUrl)
  const resp = await ses.fetch(req.url, { method: req.method })
  const json = (await resp.json().catch(() => null)) as unknown
  const parsed = parseYktCourseListResponse(json, baseUrl)
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

  const baseUrl = auth.serverBaseUrl || 'https://www.yuketang.cn'
  const req = buildOnLessonRequest(baseUrl)
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
      sourceUrl: `${baseUrl}/v2/web/studentlog/${onLesson.status.lessonId}`,
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

/** 通过 Session 拉取雨课堂活动（在课互动、习题测验、期末考试） */
export async function fetchYuketangActivities(ses: SessionLike): Promise<{
  state: 'supported' | 'unauthenticated' | 'expired' | 'unverified' | 'error'
  activities: ClassroomActivityItem[]
  fetchedAt: string
  reason: string | null
}> {
  const auth = await detectYuketangAuth(ses)
  if (auth.state === 'unauthenticated') {
    return {
      state: 'unauthenticated',
      activities: [],
      fetchedAt: new Date().toISOString(),
      reason: '未登录雨课堂账号，请在平台浏览器完成手动登录'
    }
  }
  if (auth.state === 'expired') {
    return {
      state: 'expired',
      activities: [],
      fetchedAt: new Date().toISOString(),
      reason: '雨课堂登录已过期，请重新登录'
    }
  }
  if (auth.state === 'error') {
    return {
      state: 'error',
      activities: [],
      fetchedAt: new Date().toISOString(),
      reason: auth.evidence ?? '网络异常'
    }
  }

  const baseUrl = auth.serverBaseUrl || 'https://www.yuketang.cn'
  const req = buildOnLessonRequest(baseUrl)
  const resp = await ses.fetch(req.url, { method: req.method })
  const json = (await resp.json().catch(() => null)) as Record<string, unknown> | null
  const onLesson = parseOnLessonResponse(json)

  const activities: ClassroomActivityItem[] = []
  if (onLesson.ok && onLesson.status.onLesson && onLesson.status.lessonId) {
    activities.push({
      id: `ykt-act-${onLesson.status.lessonId}`,
      platformId: 'yuketang',
      courseId: onLesson.status.classroomId || '',
      courseName: onLesson.status.courseName || '雨课堂互动教学',
      classId: onLesson.status.classroomId || '',
      title: `${onLesson.status.courseName || '课堂互动'} · 正在上课（进入课堂签到与答题）`,
      category: 'sign_in',
      status: 'open',
      startAt: new Date().toISOString(),
      endAt: null,
      sourceUrl: `${baseUrl}/v2/web/studentlog/${onLesson.status.lessonId}`,
      fetchedAt: new Date().toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'normal',
      confidence: 'high'
    })
  }

  const data = (json?.data ?? json) as Record<string, unknown> | null
  const upcoming = Array.isArray(data?.upcoming_exam) ? (data!.upcoming_exam as Record<string, unknown>[]) : []
  for (const exam of upcoming) {
    if (!exam || typeof exam !== 'object') continue
    const examId = String(exam.id ?? exam.exam_id ?? '')
    if (!examId) continue
    activities.push({
      id: `ykt-exam-${examId}`,
      platformId: 'yuketang',
      courseId: String(exam.classroom_id ?? exam.course_id ?? ''),
      courseName: String(exam.course_name ?? '雨课堂测试'),
      classId: String(exam.classroom_id ?? ''),
      title: String(exam.title ?? exam.name ?? `随堂测试 ${examId}`),
      category: 'quiz',
      status: 'pending',
      startAt: typeof exam.start_time === 'string' ? exam.start_time : null,
      endAt: typeof exam.end_time === 'string' ? exam.end_time : null,
      sourceUrl: `${baseUrl}/v2/web/studentlog/${exam.classroom_id ?? ''}`,
      fetchedAt: new Date().toISOString(),
      locationRequired: false,
      locationText: null,
      signInKind: 'unknown',
      confidence: 'high'
    })
  }

  return {
    state: 'supported',
    activities,
    fetchedAt: new Date().toISOString(),
    reason: activities.length === 0 ? '当前无正在进行的课堂互动' : null
  }
}

/** 通过 Session 获取雨课堂章节与课件内容 */
export async function fetchYuketangChapters(
  ses: SessionLike,
  courseId: string,
  clazzId: string
): Promise<{
  ok: boolean
  chapters: ChapterNode[]
  error?: string
}> {
  const auth = await detectYuketangAuth(ses)
  if (auth.state !== 'authenticated') {
    return { ok: false, chapters: [], error: auth.evidence ?? '未登录雨课堂' }
  }

  const targetClassId = clazzId || courseId
  const chapters: ChapterNode[] = []

  // 1. 尝试从雨课堂学习日志/课件端点获取
  try {
    const url = `https://www.yuketang.cn/v2/api/web/logs/learn/${encodeURIComponent(targetClassId)}?actype=-1&page=0&offset=50&sort=-1`
    const resp = await ses.fetch(url, { method: 'GET' })
    const json = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    const data = (json?.data ?? json) as Record<string, unknown> | null
    const list = Array.isArray(data?.activities) ? (data!.activities as Record<string, unknown>[]) : []

    if (list.length > 0) {
      let order = 1
      for (const item of list) {
        const id = String(item.id ?? item.courseware_id ?? '')
        if (!id) continue
        const title = String(item.title ?? item.name ?? `雨课堂课件 ${id}`)
        const typeStr = String(item.type ?? '').toLowerCase()
        const taskType = typeStr.includes('video') ? 'video' : typeStr.includes('problem') || typeStr.includes('quiz') ? 'quiz' : 'doc'
        const taskUrl = `https://www.yuketang.cn/v2/web/studentlog/${targetClassId}`

        chapters.push({
          courseId,
          clazzId: targetClassId,
          chapterId: `ykt-chap-${id}`,
          parentId: null,
          title,
          order: order++,
          taskType,
          taskUrl,
          status: 'unknown',
          source: 'yuketang_api',
          confidence: 'high',
          attachments: []
        })
      }
    }
  } catch (_) {}

  // 2. 如果接口暂无独立活动列表或端点结构差异，提供根章节入口直接学习
  if (chapters.length === 0) {
    chapters.push({
      courseId,
      clazzId: targetClassId,
      chapterId: `ykt-main-${targetClassId}`,
      parentId: null,
      title: '进入雨课堂学习（课件、习题与回放）',
      order: 1,
      taskType: 'other',
      taskUrl: `https://www.yuketang.cn/v2/web/studentlog/${targetClassId}`,
      status: 'unknown',
      source: 'yuketang_direct',
      confidence: 'medium',
      attachments: []
    })
  }

  return {
    ok: true,
    chapters
  }
}


