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
  clazzName?: string
  courseUrl: string
  platformId: 'yuketang'
  term?: number | string
  isCurrentTerm?: boolean
  termLabel?: string
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

export const YKT_WEB_HEADERS = {
  'university-id': '0',
  'uv-id': '0',
  'X-Client': 'web',
  'Xt-Agent': 'web',
  Accept: 'application/json, text/plain, */*'
}

export function buildYktCourseListRequest(baseUrl = 'https://www.yuketang.cn', identity = 2): {
  url: string
  method: string
  headers: Record<string, string>
} {
  const cleanBase = baseUrl.replace(/\/+$/, '')
  return {
    url: `${cleanBase}/v2/api/web/courses/list?identity=${identity}`,
    method: 'GET',
    headers: { ...YKT_WEB_HEADERS, Referer: `${cleanBase}/v2/web/index` }
  }
}

export function parseYktCourseListResponse(raw: unknown, baseUrl = 'https://www.yuketang.cn'): {
  ok: boolean
  courses: YuketangCourse[]
  error?: string
  needsUniversitySelection?: boolean
  universities?: Array<{ id: number | string; name: string }>
} {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, courses: [], error: 'INVALID_JSON: 响应不是对象' }
  }
  const record = raw as Record<string, unknown>
  const code = typeof record.code === 'number' ? record.code : null
  const errcode = typeof record.errcode === 'number' ? record.errcode : null

  if (errcode !== 0 && errcode !== null) {
    const msg = typeof record.errmsg === 'string' ? record.errmsg : `错误码 ${errcode}`
    return { ok: false, courses: [], error: `API_ERROR: ${msg}` }
  }
  if (code !== 0 && code !== null) {
    const msg = typeof record.msg === 'string' ? record.msg : `错误码 ${code}`
    return { ok: false, courses: [], error: `API_ERROR: ${msg}` }
  }

  // 检查是否返回需要指定高校的 universities 列表（多校区账号）
  const data = record.data as Record<string, unknown> | undefined
  const unis = Array.isArray(data?.universities)
    ? (data!.universities as Array<{ id: number | string; name: string }>)
    : Array.isArray(record.universities)
      ? (record.universities as Array<{ id: number | string; name: string }>)
      : []

  if (unis.length > 0) {
    return {
      ok: false,
      courses: [],
      error: `NEED_UNIVERSITY: 检测到多校区高校雨课堂（如 ${unis[0].name}），请在平台浏览器选择对应高校`,
      needsUniversitySelection: true,
      universities: unis
    }
  }

  // 兼容 data.list（现代真实格式）、data.courses、data.result 以及 data 直接为数组
  let list: unknown[] = []
  if (Array.isArray(data?.list)) {
    list = data!.list as unknown[]
  } else if (Array.isArray(data?.courses)) {
    list = data!.courses as unknown[]
  } else if (Array.isArray(data?.result)) {
    list = data!.result as unknown[]
  } else if (Array.isArray(data)) {
    list = data as unknown[]
  } else if (Array.isArray(record.list)) {
    list = record.list as unknown[]
  }

  const courses: YuketangCourse[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const id = String(c.classroom_id ?? c.id ?? '')
    if (!id) continue
    // 课程名称与班级名称分离：
    // 雨课堂在 c.course.name 存储真实课程名（如“数据结构与算法”），在 c.name 存储教学班名（如“2026秋-31107604002”）
    let courseName = ''
    let clazzName = ''
    if (typeof c.course === 'object' && c.course !== null && typeof (c.course as Record<string, unknown>).name === 'string') {
      courseName = String((c.course as Record<string, unknown>).name).trim()
      clazzName = String(c.name ?? '').trim()
    } else if (typeof c.course_name === 'string' && c.course_name) {
      courseName = c.course_name.trim()
      clazzName = String(c.name ?? '').trim()
    } else {
      courseName = String(c.name ?? `未命名课程 ${id}`).trim()
    }

    // 学期归属与本学期标记
    const termVal = c.term ? Number(c.term) : null
    const isCurrentTerm =
      termVal === 202601 ||
      clazzName.includes('2026秋') ||
      clazzName.includes('26秋') ||
      courseName.includes('2026秋') ||
      courseName.includes('26秋')

    let termLabel = '往期课程'
    if (isCurrentTerm) {
      termLabel = '2026秋 (本学期)'
    } else if (termVal === 202502 || clazzName.includes('2026春') || clazzName.includes('25春')) {
      termLabel = '2025春 (已结课)'
    } else if (termVal) {
      termLabel = `学期 ${termVal}`
    }

    // 教师名称解析：若 teacher 为对象 { user_id, name, avatar } 则安全取其 name 字段
    let teacherName = ''
    if (typeof c.teacher === 'object' && c.teacher !== null) {
      teacherName = String((c.teacher as Record<string, unknown>).name ?? '')
    } else if (typeof c.teacher_name === 'string') {
      teacherName = c.teacher_name
    } else if (typeof c.teacher === 'string') {
      teacherName = c.teacher
    }

    // 封面图解析
    let coverUrl: string | null = null
    if (typeof c.cover === 'string' && c.cover) {
      coverUrl = c.cover
    } else if (typeof c.course === 'object' && c.course !== null) {
      const innerCover = (c.course as Record<string, unknown>).cover
      if (typeof innerCover === 'string' && innerCover) coverUrl = innerCover
    } else if (typeof c.teacher === 'object' && c.teacher !== null) {
      const avatar = (c.teacher as Record<string, unknown>).avatar
      if (typeof avatar === 'string' && avatar) coverUrl = avatar
    }

    const courseId = String(c.course_id ?? c.courseId ?? id)
    const classId = String(c.classroom_id ?? id)
    const cleanBase = baseUrl.replace(/\/+$/, '')
    const courseUrl = `${cleanBase}/v2/web/studentlog/${classId}`

    courses.push({
      classroomCourseId: id,
      courseName,
      teacherName,
      coverUrl,
      courseId,
      classId,
      name: courseName,
      clazzName: clazzName || undefined,
      courseUrl,
      platformId: 'yuketang',
      term: termVal ?? undefined,
      isCurrentTerm,
      termLabel
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

import type { SignInEvent, ClassroomActivityItem, ChapterNode, TaskType, TaskDetectionMethod } from '@shared/types'
import type { SessionLike } from './chaoxing'

function parseTimeOrNull(val: unknown): string | null {
  if (!val) return null
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    const ms = val < 1e11 ? val * 1000 : val
    return new Date(ms).toISOString()
  }
  if (typeof val === 'string') {
    const s = val.trim()
    if (!s) return null
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      const ms = n < 1e11 ? n * 1000 : n
      return new Date(ms).toISOString()
    }
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return null
}

/** 探测雨课堂 Session 登录状态，支持通用版及各高校专有独立版（荷塘、长江、黄河等） */
export async function detectYuketangAuth(
  ses: SessionLike,
  currentBrowserUrl?: string
): Promise<{
  state: 'unauthenticated' | 'authenticated' | 'expired' | 'error'
  evidence: string | null
  serverBaseUrl?: string
}> {
  try {
    let detectedBaseUrl = 'https://www.yuketang.cn'
    if (currentBrowserUrl && /^https?:\/\//i.test(currentBrowserUrl)) {
      try {
        const u = new URL(currentBrowserUrl)
        if (u.hostname.includes('yuketang.cn')) {
          detectedBaseUrl = u.origin
        }
      } catch {}
    }

    const allCookies = await ses.cookies.get({}).catch(() => [])
    const yktCookies = allCookies.filter((c) => !c.domain || c.domain.includes('yuketang.cn'))
    const authCookie = yktCookies.find((c) =>
      ['sessionid', 'login_user_id', 'uvbe'].some(
        (k) => c.name.toLowerCase() === k.toLowerCase() || c.name.toLowerCase().includes(k.toLowerCase())
      )
    )

    if (!authCookie) {
      return {
        state: 'unauthenticated',
        evidence: '未在内置浏览器中检测到雨课堂登录会话（sessionid）',
        serverBaseUrl: detectedBaseUrl
      }
    }

    // 若未通过浏览器 URL 推断出特定子域，则依据 cookie 的 host 进行判定：
    if (detectedBaseUrl === 'https://www.yuketang.cn') {
      const domain = (authCookie.domain || '').toLowerCase().replace(/^\./, '')
      if (domain === 'pro.yuketang.cn') detectedBaseUrl = 'https://pro.yuketang.cn'
      else if (domain === 'changjiang.yuketang.cn') detectedBaseUrl = 'https://changjiang.yuketang.cn'
      else if (domain === 'huanghe.yuketang.cn') detectedBaseUrl = 'https://huanghe.yuketang.cn'
      else detectedBaseUrl = 'https://www.yuketang.cn'
    }

    const courseReq = buildYktCourseListRequest(detectedBaseUrl, 2)
    const resp = await ses.fetch(courseReq.url, { method: courseReq.method, headers: courseReq.headers })
    if (resp.status === 401 || resp.status === 403) {
      return {
        state: 'expired',
        evidence: `雨课堂登录凭证已失效（HTTP ${resp.status}）`,
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
          evidence: `雨课堂登录会话有效（服务器：${detectedBaseUrl}）`,
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

let cachedYktCourses: YuketangCourse[] = []

/** 通过 Session 拉取雨课堂课程列表 */
export async function fetchYuketangCourses(
  ses: SessionLike,
  currentBrowserUrl?: string
): Promise<{
  ok: boolean
  state: 'supported' | 'unauthenticated' | 'expired' | 'error'
  courses: YuketangCourse[]
  error?: string
}> {
  const auth = await detectYuketangAuth(ses, currentBrowserUrl)
  if (auth.state !== 'authenticated') {
    if (auth.state === 'unauthenticated' || auth.state === 'expired') {
      cachedYktCourses = []
    }
    return { ok: false, state: auth.state, courses: [], error: auth.evidence ?? '未登录雨课堂' }
  }

  const baseUrl = auth.serverBaseUrl || 'https://www.yuketang.cn'
  try {
    // 1. 优先拉取学生身份课程 (identity=2)
    const req = buildYktCourseListRequest(baseUrl, 2)
    const resp = await ses.fetch(req.url, { method: req.method, headers: req.headers })
    if (!resp.ok) {
      if (cachedYktCourses.length > 0) {
        return { ok: true, state: 'supported', courses: cachedYktCourses }
      }
      return {
        ok: false,
        state: 'error',
        courses: [],
        error: `雨课堂课程接口返回 HTTP ${resp.status} ${resp.statusText}`
      }
    }

    const json = (await resp.json().catch(() => null)) as unknown
    const parsed = parseYktCourseListResponse(json, baseUrl)
    if (parsed.ok) {
      cachedYktCourses = parsed.courses
      return {
        ok: true,
        state: 'supported',
        courses: parsed.courses
      }
    }

    if (cachedYktCourses.length > 0) {
      return { ok: true, state: 'supported', courses: cachedYktCourses }
    }
    return {
      ok: false,
      state: 'error',
      courses: [],
      error: parsed.error ?? '雨课堂课程解析失败'
    }
  } catch (err) {
    if (cachedYktCourses.length > 0) {
      return { ok: true, state: 'supported', courses: cachedYktCourses }
    }
    return {
      ok: false,
      state: 'error',
      courses: [],
      error: `雨课堂网络请求异常: ${err instanceof Error ? err.message : String(err)}`
    }
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

/** 通过 Session 拉取雨课堂活动（在课互动、习题测验、期末考试、多课程课后作业聚合） */
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
  const activities: ClassroomActivityItem[] = []

  // 1. 检查实时上课状态与考前测试
  try {
    const req = buildOnLessonRequest(baseUrl)
    const resp = await ses.fetch(req.url, { method: req.method })
    const json = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    const onLesson = parseOnLessonResponse(json)

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
  } catch {}

  // 2. 聚合在读课程的课堂活动与课后作业
  try {
    let courses = cachedYktCourses
    if (courses.length === 0) {
      const cr = await fetchYuketangCourses(ses)
      if (cr.ok) courses = cr.courses
    }
    const currentTermCourses = courses.filter((c) => c.isCurrentTerm)
    const targetCourses = currentTermCourses.length > 0 ? currentTermCourses : courses.slice(0, 3)

    const now = Date.now()
    await Promise.all(
      targetCourses.map(async (course) => {
        try {
          const logUrl = `${baseUrl}/v2/api/web/logs/learn/${encodeURIComponent(course.classId)}?actype=-1&page=0&offset=20&sort=-1`
          const lResp = await ses.fetch(logUrl, { method: 'GET' })
          if (!lResp.ok) return
          const lJson = (await lResp.json().catch(() => null)) as Record<string, unknown> | null
          const lData = (lJson?.data ?? lJson) as Record<string, unknown> | null
          const acts = Array.isArray(lData?.activities) ? (lData!.activities as Record<string, unknown>[]) : []

          for (const item of acts) {
            const numType = Number(item.type)
            if (numType === 19) {
              // 课后作业 / 测验
              const deadline = item.content && typeof item.content === 'object'
                ? Number((item.content as Record<string, unknown>).score_d)
                : null
              const isPast = deadline ? deadline < now : false
              const isDone = item.is_finished === true
              const status: 'open' | 'closed' | 'pending' = isDone ? 'closed' : isPast ? 'closed' : 'open'

              let deadlineSource: import('@shared/types').DeadlineSource = 'none'
              let deadlineNotice: string | null = null
              if (deadline) {
                const d = new Date(deadline)
                const createTimeMs = item.create_time ? Number(item.create_time) : now
                const isMonthEnd =
                  (d.getUTCMonth() === 0 && d.getUTCDate() === 31) || // 01-31
                  (d.getUTCMonth() === 6 && d.getUTCDate() === 31) || // 07-31
                  (d.getUTCMonth() === 5 && d.getUTCDate() === 30)    // 06-30
                const isLongTerm = deadline - createTimeMs > 60 * 24 * 3600 * 1000

                if (isMonthEnd && isLongTerm) {
                  deadlineSource = 'semester_default'
                  deadlineNotice = '学期统一默认时间 (仅供参考，非教师单独设置)'
                } else {
                  deadlineSource = 'teacher_explicit'
                }
              }

              activities.push({
                id: `ykt-hw-${item.id}`,
                platformId: 'yuketang',
                courseId: course.courseId,
                courseName: course.name,
                classId: course.classId,
                title: String(item.title || `课后作业 ${item.id}`),
                category: 'quiz',
                status,
                startAt: parseTimeOrNull(item.create_time),
                endAt: parseTimeOrNull(deadline),
                sourceUrl: `${baseUrl}/v2/web/studentlog/${course.classId}`,
                fetchedAt: new Date().toISOString(),
                locationRequired: false,
                locationText: null,
                signInKind: 'unknown',
                confidence: 'high',
                deadlineSource,
                deadlineNotice
              })
            }
          }
        } catch {}
      })
    )
  } catch {}

  // 去重与排序：进行中(open) > 未开始(pending) > 已结束(closed)
  const seen = new Set<string>()
  const deduped: ClassroomActivityItem[] = []
  for (const a of activities) {
    if (!seen.has(a.id)) {
      seen.add(a.id)
      deduped.push(a)
    }
  }

  const orderWeight = { open: 0, pending: 1, unknown: 2, closed: 3 }
  deduped.sort((a, b) => {
    const diff = (orderWeight[a.status] ?? 2) - (orderWeight[b.status] ?? 2)
    if (diff !== 0) return diff
    return (b.startAt || '').localeCompare(a.startAt || '')
  })

  return {
    state: 'supported',
    activities: deduped,
    fetchedAt: new Date().toISOString(),
    reason: deduped.length === 0 ? '当前在读课程暂无进行中的课堂互动与作业' : `已汇总 ${deduped.length} 项雨课堂活动与作业`
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

  const baseUrl = auth.serverBaseUrl || 'https://www.yuketang.cn'
  const targetClassId = clazzId || courseId
  const chapters: ChapterNode[] = []

  // 从雨课堂学习日志/课件端点获取真实课堂课件、文档、视频与测验
  try {
    const url = `${baseUrl}/v2/api/web/logs/learn/${encodeURIComponent(targetClassId)}?actype=-1&page=0&offset=50&sort=-1`
    const resp = await ses.fetch(url, { method: 'GET' })
    const json = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    const data = (json?.data ?? json) as Record<string, unknown> | null
    const list = Array.isArray(data?.activities) ? (data!.activities as Record<string, unknown>[]) : []

    if (list.length > 0) {
      let order = 1
      for (const item of list) {
        const id = String(item.id ?? item.courseware_id ?? '')
        if (!id) continue
        const title = String(item.title ?? item.name ?? `雨课堂课件 ${id}`).trim()
        const numericType = Number(item.type)

        let taskType: TaskType = 'unknown'
        let detectionMethod: TaskDetectionMethod = 'dom_element'
        let confidence: 'high' | 'medium' | 'low' = 'high'

        if (numericType === 16 || numericType === 17) {
          // 微电影/导论视频
          taskType = 'video'
          detectionMethod = 'dom_element'
        } else if (numericType === 14 || numericType === 15) {
          // 14: 课堂授课PPT/讲义报告, 15: 课前/课外文档课件
          taskType = 'doc'
          detectionMethod = 'dom_element'
        } else if (numericType === 19) {
          // 课后作业/随堂测验
          taskType = 'quiz'
          detectionMethod = 'dom_element'
        } else if (numericType === 9) {
          // 班级群公告/通知
          taskType = 'other'
          detectionMethod = 'dom_element'
        } else {
          // 标题兜底识别或如实标记为待确认，绝不瞎猜为视频
          const lowerTitle = title.toLowerCase()
          if (lowerTitle.includes('作业') || lowerTitle.includes('测验') || lowerTitle.includes('题') || lowerTitle.includes('quiz')) {
            taskType = 'quiz'
            detectionMethod = 'catalog_title'
            confidence = 'medium'
          } else if (lowerTitle.includes('视频') || lowerTitle.includes('录像') || lowerTitle.includes('微课') || lowerTitle.includes('mp4')) {
            taskType = 'video'
            detectionMethod = 'catalog_title'
            confidence = 'medium'
          } else if (lowerTitle.includes('课件') || lowerTitle.includes('讲义') || lowerTitle.includes('ppt') || lowerTitle.includes('pdf') || lowerTitle.includes('文档')) {
            taskType = 'doc'
            detectionMethod = 'catalog_title'
            confidence = 'medium'
          } else {
            taskType = 'unknown'
            detectionMethod = 'uninspected'
            confidence = 'low'
          }
        }

        // 精准跳转链接：
        // 课堂报告 (type 14) 若有 courseware_id 则直达课件报告页，否则进入 studentlog
        let taskUrl = `${baseUrl}/v2/web/studentlog/${targetClassId}`
        if (numericType === 14 && item.courseware_id) {
          taskUrl = `${baseUrl}/v2/web/student-lesson-report/${targetClassId}/${item.courseware_id}/${id}`
        }

        // 状态映射：真实字段判断
        let status: 'completed' | 'not_started' | 'unknown' = 'unknown'
        if (item.is_finished === true || item.attend_status === true || item.hasRead === true) {
          status = 'completed'
        } else if (item.is_finished === false || item.attend_status === false) {
          status = 'not_started'
        }

        chapters.push({
          courseId,
          clazzId: targetClassId,
          chapterId: `ykt-chap-${id}`,
          parentId: null,
          title,
          order: order++,
          taskType,
          taskUrl,
          status,
          source: 'yuketang_api',
          detectionMethod,
          confidence,
          attachments: []
        })
      }
    }
  } catch (_) {}

  // 若该课程未发布在线章节或课件，如实返回空数组，不伪造假节点
  return {
    ok: true,
    chapters
  }
}



